const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://story.neodomain.cn';
const isVercel = process.env.VERCEL === '1';
const GENERATED_DIR = isVercel ? '/tmp/generated' : path.join(__dirname, 'generated');
const PUBLIC_DIR = path.join(__dirname, 'public');
const REQUEST_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 3000;
const DEFAULT_MODEL_NAME = process.env.DEFAULT_MODEL_NAME || 'gemini-3-pro-image-preview';
const RUNTIME_ENV_FILE = isVercel ? '/tmp/.env.runtime' : path.join(__dirname, '.env.runtime');

const envToken = process.env.NEODOMAIN_ACCESS_TOKEN || process.env.ACCESS_TOKEN || '';
let runtimeAccessToken = loadRuntimeToken() || envToken || '';
let runtimeTokenSource = loadRuntimeToken() ? 'runtime_file' : (envToken ? 'env' : 'none');

fs.mkdirSync(GENERATED_DIR, { recursive: true });

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use('/generated', express.static(GENERATED_DIR));
app.use(express.static(PUBLIC_DIR));

function loadRuntimeToken() {
  try {
    if (!fs.existsSync(RUNTIME_ENV_FILE)) return '';
    const content = fs.readFileSync(RUNTIME_ENV_FILE, 'utf8');
    const match = content.match(/(?:NEODOMAIN_ACCESS_TOKEN|ACCESS_TOKEN)=(.*)/);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function persistRuntimeToken(token) {
  const safe = (token || '').trim();
  if (!safe) return false;
  const content = `NEODOMAIN_ACCESS_TOKEN=${safe}\nACCESS_TOKEN=${safe}\n`;
  fs.writeFileSync(RUNTIME_ENV_FILE, content, 'utf8');
  runtimeAccessToken = safe;
  runtimeTokenSource = 'runtime_file';
  process.env.NEODOMAIN_ACCESS_TOKEN = safe;
  process.env.ACCESS_TOKEN = safe;
  return true;
}

function clearRuntimeToken() {
  runtimeAccessToken = envToken || '';
  runtimeTokenSource = envToken ? 'env' : 'none';
  if (fs.existsSync(RUNTIME_ENV_FILE)) fs.unlinkSync(RUNTIME_ENV_FILE);
  if (!envToken) {
    delete process.env.NEODOMAIN_ACCESS_TOKEN;
    delete process.env.ACCESS_TOKEN;
  }
}

function jsonResponse(res, status, payload) {
  res.status(status).json(payload);
}

function getActiveServerToken() {
  return (runtimeAccessToken || envToken || '').trim();
}

function resolveAccessToken(candidate) {
  return (candidate || getActiveServerToken() || '').trim();
}

function isTokenExpiredError(error) {
  const payload = error?.payload || {};
  const message = String(payload.errMessage || error?.message || '').toLowerCase();
  const code = String(payload.errCode || '');
  return code === '2001' || message.includes('token has been revoked') || message.includes('token expired') || message.includes('access token') && message.includes('expired');
}

function normalizeApiError(error, fallbackMessage) {
  const tokenExpired = isTokenExpiredError(error);
  return {
    success: false,
    error: error?.payload?.errMessage || error?.message || fallbackMessage,
    tokenExpired,
    errCode: error?.payload?.errCode || null,
  };
}

function requestJson(method, urlString, { headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const options = {
      method,
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      protocol: url.protocol,
      headers,
      family: 4,
      timeout: timeoutMs,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (error) {
          return reject(new Error(`返回不是合法 JSON: ${raw.slice(0, 300)}`));
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve(parsed);
        }

        const err = new Error(parsed.errMessage || `HTTP ${res.statusCode}`);
        err.statusCode = res.statusCode;
        err.payload = parsed;
        reject(err);
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`请求超时（${timeoutMs / 1000} 秒）`));
    });

    req.on('error', (error) => reject(error));

    if (body) req.write(body);
    req.end();
  });
}

function downloadFile(fileUrl, filePath) {
  return new Promise((resolve, reject) => {
    const url = new URL(fileUrl);
    const req = https.get({ hostname: url.hostname, path: `${url.pathname}${url.search}`, family: 4, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, filePath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`下载失败，HTTP ${res.statusCode}`));
      }
      const stream = fs.createWriteStream(filePath);
      res.pipe(stream);
      stream.on('finish', () => stream.close(() => resolve(filePath)));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`下载超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`)));
    req.on('error', reject);
  });
}

function getExtensionFromFormat(format = 'png') {
  const safe = String(format).toLowerCase();
  if (['png', 'jpeg', 'jpg', 'webp'].includes(safe)) return safe === 'jpg' ? 'jpeg' : safe;
  return 'png';
}

async function pollImageResult(accessToken, taskCode) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < REQUEST_TIMEOUT_MS) {
    const result = await requestJson('GET', `${BASE_URL}/agent/ai-image-generation/result/${taskCode}`, {
      headers: { accessToken },
      timeoutMs: 30000,
    });
    const data = result.data || {};
    const status = data.status;
    if (status === 'SUCCESS') return data;
    if (status === 'FAILED') throw new Error(data.failure_reason || data.errorMessage || '图片生成失败');
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`轮询结果超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`);
}

app.get('/api/config', (req, res) => {
  jsonResponse(res, 200, {
    success: true,
    defaultModelName: DEFAULT_MODEL_NAME,
    hasEnvAccessToken: Boolean(envToken),
    hasRuntimeAccessToken: Boolean(runtimeAccessToken),
    tokenSource: runtimeTokenSource,
    activeServerToken: Boolean(getActiveServerToken()),
    envNames: ['NEODOMAIN_ACCESS_TOKEN', 'ACCESS_TOKEN'],
    runtimeEnvFile: '.env.runtime',
  });
});

app.get('/api/auth/status', (req, res) => {
  const manualToken = (req.headers['x-access-token'] || '').trim();
  const activeToken = resolveAccessToken(manualToken);
  let message = '当前没有可用 token，请去 /token 登录获取。';
  if (manualToken) message = '当前将优先使用你页面中填写的 accessToken。';
  else if (runtimeTokenSource === 'runtime_file') message = '服务端正在使用通过 /token 页面保存的 accessToken。';
  else if (envToken) message = '服务端正在使用启动时环境变量中的 accessToken。';
  jsonResponse(res, 200, {
    success: true,
    hasEnvAccessToken: Boolean(envToken),
    hasRuntimeAccessToken: Boolean(runtimeAccessToken),
    hasManualToken: Boolean(manualToken),
    canGenerate: Boolean(activeToken),
    activeSource: manualToken ? 'manual' : runtimeTokenSource,
    message,
  });
});

app.get('/api/health', (req, res) => {
  jsonResponse(res, 200, {
    success: true,
    message: 'nano banana neodomain web ok',
    timeoutSeconds: REQUEST_TIMEOUT_MS / 1000,
    generatedDir: GENERATED_DIR,
    defaultModelName: DEFAULT_MODEL_NAME,
    hasEnvAccessToken: Boolean(envToken),
    hasRuntimeAccessToken: Boolean(runtimeAccessToken),
    activeTokenSource: runtimeTokenSource,
  });
});

app.post('/api/token/save', (req, res) => {
  const { accessToken } = req.body || {};
  if (!accessToken || !String(accessToken).trim()) {
    return jsonResponse(res, 400, { success: false, error: 'accessToken 不能为空' });
  }
  persistRuntimeToken(accessToken);
  return jsonResponse(res, 200, {
    success: true,
    message: 'accessToken 已保存到服务端运行环境，并写入 .env.runtime。当前项目和后续页面都可直接调用。',
    tokenSource: runtimeTokenSource,
  });
});

app.post('/api/token/clear', (req, res) => {
  clearRuntimeToken();
  return jsonResponse(res, 200, {
    success: true,
    message: envToken ? '已清除页面保存的 token，服务端将回退到启动时环境变量 token。' : '已清除服务端保存的 token。',
    tokenSource: runtimeTokenSource,
  });
});

app.post('/api/login/send-code', async (req, res) => {
  try {
    const { contact } = req.body;
    if (!contact) return jsonResponse(res, 400, { success: false, error: 'contact 不能为空' });
    const payload = JSON.stringify({ contact, userSource: 'NEO' });
    const result = await requestJson('POST', `${BASE_URL}/user/login/send-unified-code`, {
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
      timeoutMs: 30000,
    });
    jsonResponse(res, 200, result);
  } catch (error) {
    jsonResponse(res, error.statusCode || 500, normalizeApiError(error, '发送验证码失败'));
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { contact, code, invitationCode = '' } = req.body;
    if (!contact || !code) return jsonResponse(res, 400, { success: false, error: 'contact 和 code 不能为空' });
    const payload = JSON.stringify({ contact, code, invitationCode, userSource: 'NEO' });
    const result = await requestJson('POST', `${BASE_URL}/user/login/unified-login/identity`, {
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
      timeoutMs: 30000,
    });
    if (result?.data?.authorization) persistRuntimeToken(result.data.authorization);
    jsonResponse(res, 200, result);
  } catch (error) {
    jsonResponse(res, error.statusCode || 500, normalizeApiError(error, '登录失败'));
  }
});

app.post('/api/login/select-identity', async (req, res) => {
  try {
    const { contact, userId } = req.body;
    if (!contact || !userId) return jsonResponse(res, 400, { success: false, error: 'contact 和 userId 不能为空' });
    const payload = JSON.stringify({ contact, userId });
    const result = await requestJson('POST', `${BASE_URL}/user/login/select-identity`, {
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
      timeoutMs: 30000,
    });
    if (result?.data?.authorization) persistRuntimeToken(result.data.authorization);
    jsonResponse(res, 200, result);
  } catch (error) {
    jsonResponse(res, error.statusCode || 500, normalizeApiError(error, '选择身份失败'));
  }
});

app.get('/api/models', async (req, res) => {
  try {
    const accessToken = resolveAccessToken(req.headers['x-access-token'] || req.query.accessToken);
    const scenarioType = req.query.scenarioType || '2';
    const userId = req.query.userId;
    if (!accessToken) return jsonResponse(res, 400, { success: false, error: '缺少 accessToken，且服务端也没有可用 token' });
    let url = `${BASE_URL}/agent/ai-image-generation/models/by-scenario?scenarioType=${encodeURIComponent(scenarioType)}`;
    if (userId) url += `&userId=${encodeURIComponent(userId)}`;
    const result = await requestJson('GET', url, { headers: { accessToken }, timeoutMs: 30000 });
    jsonResponse(res, 200, result);
  } catch (error) {
    if (isTokenExpiredError(error)) clearRuntimeToken();
    jsonResponse(res, error.statusCode || 500, normalizeApiError(error, '获取模型失败'));
  }
});

app.post('/api/generate-image', async (req, res) => {
  try {
    const {
      accessToken: bodyAccessToken,
      prompt,
      negativePrompt = '',
      modelName = DEFAULT_MODEL_NAME,
      imageUrls = [],
      aspectRatio = '1:1',
      numImages = '1',
      outputFormat = 'png',
      size = '2K',
      guidanceScale = 7.5,
      safetyTolerance = '5',
      syncMode = false,
      seed,
      showPrompt = true,
    } = req.body;

    const accessToken = resolveAccessToken(bodyAccessToken || req.headers['x-access-token']);
    if (!accessToken) return jsonResponse(res, 400, { success: false, error: '当前没有可用 accessToken。请去 /token 登录获取，或在启动时设置环境变量。' });
    if (!prompt) return jsonResponse(res, 400, { success: false, error: 'prompt 不能为空' });

    const payloadObject = {
      prompt,
      negativePrompt,
      modelName,
      imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
      aspectRatio,
      numImages: String(numImages),
      outputFormat,
      syncMode,
      safetyTolerance: String(safetyTolerance),
      guidanceScale,
      size,
      showPrompt,
    };

    if (seed !== undefined && seed !== null && seed !== '') payloadObject.seed = Number(seed);

    const payload = JSON.stringify(payloadObject);
    const submitResult = await requestJson('POST', `${BASE_URL}/agent/ai-image-generation/generate`, {
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), accessToken },
      body: payload,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    if (!submitResult.success) throw new Error(submitResult.errMessage || '提交生成任务失败');
    const taskCode = submitResult.data?.task_code;
    if (!taskCode) throw new Error('服务端未返回 task_code');

    const shouldPoll = syncMode === true || (!isVercel && syncMode !== false);
    if (!shouldPoll) {
      return jsonResponse(res, 200, {
        success: true,
        taskCode,
        status: 'PENDING',
        message: '任务已提交，请在前端轮询结果',
      });
    }

    const resultData = await pollImageResult(accessToken, taskCode);
    const urls = Array.isArray(resultData.image_urls) ? resultData.image_urls : [];
    const ext = getExtensionFromFormat(outputFormat);
    const savedImages = [];

    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      const filename = `${taskCode}_${i + 1}.${ext}`;
      const filePath = path.join(GENERATED_DIR, filename);
      await downloadFile(url, filePath);
      savedImages.push({ filename, localUrl: `/generated/${filename}`, remoteUrl: url });
    }

    const metadata = {
      taskCode,
      prompt,
      negativePrompt,
      modelName,
      imageUrls,
      aspectRatio,
      numImages: String(numImages),
      outputFormat,
      size,
      guidanceScale,
      safetyTolerance,
      syncMode,
      savedAt: new Date().toISOString(),
      tokenSource: bodyAccessToken ? 'manual' : runtimeTokenSource,
      savedImages,
      rawResult: resultData,
    };

    fs.writeFileSync(path.join(GENERATED_DIR, `${taskCode}.json`), JSON.stringify(metadata, null, 2), 'utf8');
    jsonResponse(res, 200, { success: true, taskCode, status: resultData.status, savedImages, metadata });
  } catch (error) {
    if (isTokenExpiredError(error)) clearRuntimeToken();
    jsonResponse(res, error.statusCode || 500, normalizeApiError(error, '图片生成失败'));
  }
});

app.get('/api/result/:taskCode', async (req, res) => {
  try {
    const accessToken = resolveAccessToken(req.headers['x-access-token'] || req.query.accessToken);
    if (!accessToken) return jsonResponse(res, 400, { success: false, error: '缺少 accessToken，且服务端没有可用 token' });
    const result = await requestJson('GET', `${BASE_URL}/agent/ai-image-generation/result/${encodeURIComponent(req.params.taskCode)}`, {
      headers: { accessToken }, timeoutMs: 30000,
    });
    jsonResponse(res, 200, result);
  } catch (error) {
    if (isTokenExpiredError(error)) clearRuntimeToken();
    jsonResponse(res, error.statusCode || 500, normalizeApiError(error, '查询结果失败'));
  }
});

app.get('/token', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'token.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

if (isVercel) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`Nano Banana Neodomain Web 已启动:`);
    console.log(`- Home:  http://localhost:${PORT}/`);
    console.log(`- Token: http://localhost:${PORT}/token`);
    console.log(`- Active token source: ${runtimeTokenSource}`);
    if (runtimeTokenSource === 'runtime_file') {
      console.log(`- Runtime token file: ${RUNTIME_ENV_FILE}`);
    }
  });
}
