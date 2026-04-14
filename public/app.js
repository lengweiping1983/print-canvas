const state = {
  identities: [],
  gallery: [],
  config: null,
};

const STORAGE_KEY = 'nano_banana_access_token';
const $ = (id) => document.getElementById(id);

const composerSheet = $('composerSheet');
const heroPreview = $('heroPreview');
const galleryGrid = $('galleryGrid');
const galleryCount = $('galleryCount');
const healthText = $('healthText');
const generationStatus = $('generationStatus');

function openComposer() {
  if (composerSheet) composerSheet.classList.remove('hidden');
}

function closeComposer() {
  if (composerSheet) composerSheet.classList.add('hidden');
}

function setStatus(text) {
  if (generationStatus) generationStatus.textContent = text;
}

function getAccessToken() {
  return $('accessTokenInput') ? $('accessTokenInput').value.trim() : '';
}

function setAccessToken(token, persist = true) {
  if ($('accessTokenInput')) $('accessTokenInput').value = token || '';
  if (persist) {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  }
}

function getStoredToken() {
  return localStorage.getItem(STORAGE_KEY) || '';
}

async function syncTokenToServer(token) {
  if (!token) return;
  await fetchJson('/api/token/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: token }),
  });
}

async function clearStoredToken() {
  setAccessToken('', true);
  try {
    await fetchJson('/api/token/clear', { method: 'POST' });
  } catch (error) {
    console.warn(error.message);
  }
  refreshTokenUi();
  checkAuthStatus();
}

function getReferenceUrls() {
  return $('imageUrlsInput')
    ? $('imageUrlsInput').value.split('\n').map((x) => x.trim()).filter(Boolean)
    : [];
}

function addToGallery(images) {
  if (!Array.isArray(images) || images.length === 0) return;
  state.gallery = [...images, ...state.gallery];
  renderGallery();
  const first = images[0];
  const url = first.remoteUrl || first.localUrl;
  if (heroPreview) heroPreview.innerHTML = `<img src="${url}" alt="generated image" />`;
}

function renderGallery() {
  if (!galleryCount || !galleryGrid) return;
  galleryCount.textContent = `${state.gallery.length} 张`;
  if (state.gallery.length === 0) {
    galleryGrid.innerHTML = '<div class="preview-placeholder">还没有生成图片</div>';
    return;
  }
  galleryGrid.innerHTML = state.gallery.map((item) => {
    const url = item.remoteUrl || item.localUrl;
    return `
    <div class="gallery-item">
      <img src="${url}" alt="${item.filename}" />
      <div class="gallery-meta">${item.filename}</div>
    </div>
  `;
  }).join('');
}

async function pollImageResultFrontend(taskCode) {
  const maxAttempts = 200;
  const localToken = getAccessToken() || getStoredToken();
  const outputFormat = $('outputFormatInput') ? $('outputFormatInput').value : 'png';

  for (let i = 0; i < maxAttempts; i += 1) {
    setStatus(`生成中... (${i + 1}/${maxAttempts})`);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const data = await fetchJson(`/api/result/${taskCode}`, {
      headers: localToken ? { 'x-access-token': localToken } : {},
    });
    const resultData = data.data || {};

    if (resultData.status === 'SUCCESS') {
      const urls = Array.isArray(resultData.image_urls) ? resultData.image_urls : [];
      const ext = outputFormat === 'jpg' ? 'jpeg' : (outputFormat || 'png');
      const savedImages = urls.map((url, idx) => ({
        filename: `${taskCode}_${idx + 1}.${ext === 'jpeg' ? 'jpg' : ext}`,
        localUrl: url,
        remoteUrl: url,
      }));
      addToGallery(savedImages);
      setStatus(`生成成功：${taskCode}`);
      return;
    }

    if (resultData.status === 'FAILED') {
      throw new Error(resultData.failure_reason || resultData.errorMessage || '图片生成失败');
    }
  }

  throw new Error('轮询结果超时，请稍后到图库查看');
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok || data.success === false) {
    const error = new Error(data.error || data.errMessage || '请求失败');
    error.tokenExpired = Boolean(data.tokenExpired);
    error.errCode = data.errCode || null;
    throw error;
  }
  return data;
}

async function loadConfig() {
  const tokenModeText = $('tokenModeText');
  try {
    const data = await fetchJson('/api/config');
    state.config = data;
    const modelInput = $('modelNameInput');
    if (modelInput && data.defaultModelName) modelInput.value = data.defaultModelName;
    refreshTokenUi();
  } catch (error) {
    if (tokenModeText) tokenModeText.textContent = `配置读取失败：${error.message}`;
  }
}

function refreshTokenUi() {
  const tokenModeText = $('tokenModeText');
  const tokenHelpText = $('tokenHelpText');
  const localToken = getAccessToken() || getStoredToken();
  if (!getAccessToken() && localToken) setAccessToken(localToken, false);

  if (!tokenModeText) return;

  if (localToken) {
    tokenModeText.textContent = '已检测到页面本地 token。登录成功后会自动同步到服务端运行环境，当前项目和其它页面都能直接调用。';
    if (tokenHelpText) tokenHelpText.textContent = '场景 1/3：没有 token 或 token 过期时，在 /token 重新登录即可，服务端会自动更新 .env.runtime。';
    return;
  }

  if (state.config?.tokenSource === 'runtime_file' || state.config?.hasRuntimeAccessToken) {
    tokenModeText.textContent = '服务端已加载通过 /token 页面保存的 token，当前项目和其它页面都可直接调用。';
    if (tokenHelpText) tokenHelpText.textContent = '这个 token 已写入项目内 .env.runtime，并在当前 Node 进程中生效。';
    return;
  }

  if (state.config?.hasEnvAccessToken) {
    tokenModeText.textContent = '服务端已配置启动环境变量 token，代码会自动直接调用模型。';
    if (tokenHelpText) tokenHelpText.textContent = '场景 2：启动前设置 NEODOMAIN_ACCESS_TOKEN 或 ACCESS_TOKEN 即可，无需在页面重复输入。';
    return;
  }

  tokenModeText.textContent = '当前没有可用 token。请在 /token 登录获取，登录成功后会自动写入服务端运行环境。';
  if (tokenHelpText) tokenHelpText.textContent = '场景 1：初次没有 ACCESS_TOKEN 时，验证码登录后即可直接生成。';
}

async function checkHealth() {
  try {
    const data = await fetchJson('/api/health');
    healthText.textContent = `服务正常，超时 ${data.timeoutSeconds} 秒，默认模型 ${data.defaultModelName}，token 来源 ${data.activeTokenSource}`;
  } catch (error) {
    healthText.textContent = error.message;
  }
}

async function checkAuthStatus() {
  try {
    const token = getAccessToken() || getStoredToken();
    const data = await fetchJson('/api/auth/status', {
      headers: token ? { 'x-access-token': token } : {},
    });
    const authStatusText = $('authStatusText');
    if (authStatusText) authStatusText.textContent = data.message;
  } catch (error) {
    const authStatusText = $('authStatusText');
    if (authStatusText) authStatusText.textContent = `认证状态检查失败：${error.message}`;
  }
}

async function sendCode() {
  const contact = $('contactInput').value.trim();
  if (!contact) return alert('请先输入手机号或邮箱');
  try {
    await fetchJson('/api/login/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact }),
    });
    alert('验证码已发送');
  } catch (error) {
    alert(error.message);
  }
}

async function applyFreshToken(token, successText) {
  setAccessToken(token, true);
  await syncTokenToServer(token);
  await loadConfig();
  refreshTokenUi();
  checkAuthStatus();
  alert(successText);
}

async function login() {
  const contact = $('contactInput').value.trim();
  const code = $('codeInput').value.trim();
  if (!contact || !code) return alert('请输入手机号/邮箱 和 验证码');

  try {
    const result = await fetchJson('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact, code }),
    });

    const data = result.data || {};
    if (data.needSelectIdentity) {
      state.identities = data.identities || [];
      const select = $('identitySelect');
      select.innerHTML = state.identities
        .map((item) => `<option value="${item.userId}">${item.nickname || '未命名'} / ${item.enterpriseName || item.userType || ''}</option>`)
        .join('');
      $('identityWrap').classList.remove('hidden');
      alert('检测到多身份，请先选择身份');
      return;
    }

    if (data.authorization) {
      await applyFreshToken(data.authorization, '已获取新 accessToken，并自动写入服务端运行环境。当前项目和其它页面都能直接调用。');
    } else {
      alert('登录成功，但未返回 authorization');
    }
  } catch (error) {
    alert(error.message);
  }
}

async function selectIdentity() {
  const contact = $('contactInput').value.trim();
  const userId = $('identitySelect').value;
  if (!contact || !userId) return alert('请选择身份');

  try {
    const result = await fetchJson('/api/login/select-identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact, userId }),
    });
    const data = result.data || {};
    if (data.authorization) {
      $('identityWrap').classList.add('hidden');
      await applyFreshToken(data.authorization, '身份确认完成，新的 accessToken 已自动写入服务端运行环境。');
    } else {
      alert('身份确认成功，但未返回 authorization');
    }
  } catch (error) {
    alert(error.message);
  }
}

async function generateImage() {
  const prompt = $('promptInput').value.trim();
  if (!prompt) return alert('请输入提示词');

  const localToken = getAccessToken() || getStoredToken();
  if (localToken) {
    try {
      await syncTokenToServer(localToken);
    } catch (error) {
      alert(`服务端保存 token 失败：${error.message}`);
      return;
    }
  }

  if (!localToken && !state.config?.activeServerToken && !state.config?.hasEnvAccessToken && !state.config?.hasRuntimeAccessToken) {
    alert('当前没有可用的 accessToken。请先去 /token 登录获取，登录成功后代码会自动调用模型。');
    return;
  }

  setStatus('图像生成中，最长可能等待 10 分钟...');
  $('generateBtn').disabled = true;

  try {
    const result = await fetchJson('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: localToken,
        prompt,
        syncMode: false,
        modelName: $('modelNameInput').value.trim() || 'gemini-3-pro-image-preview',
        aspectRatio: $('aspectRatioInput').value,
        numImages: $('numImagesInput').value,
        size: $('sizeInput').value,
        outputFormat: $('outputFormatInput').value,
        imageUrls: getReferenceUrls(),
      }),
    });

    if (result.status === 'PENDING' && result.taskCode) {
      await pollImageResultFrontend(result.taskCode);
    } else {
      addToGallery(result.savedImages || []);
      setStatus(`生成成功：${result.taskCode}`);
    }
  } catch (error) {
    if (error.tokenExpired) {
      await clearStoredToken();
      setStatus('token 已过期，请重新登录获取新的 accessToken。');
      alert('当前 ACCESS_TOKEN 已过期或被撤销。请在 /token 重新获取，成功后会自动覆盖服务端运行环境。');
    } else {
      setStatus(`生成失败：${error.message}`);
      alert(error.message);
    }
  } finally {
    $('generateBtn').disabled = false;
  }
}

if ($('openComposer')) $('openComposer').addEventListener('click', openComposer);
if ($('closeComposer')) $('closeComposer').addEventListener('click', closeComposer);
if ($('sheetCloseBtn')) $('sheetCloseBtn').addEventListener('click', closeComposer);
if ($('checkHealthBtn')) $('checkHealthBtn').addEventListener('click', checkHealth);
if ($('sendCodeBtn')) $('sendCodeBtn').addEventListener('click', sendCode);
if ($('loginBtn')) $('loginBtn').addEventListener('click', login);
if ($('selectIdentityBtn')) $('selectIdentityBtn').addEventListener('click', selectIdentity);
if ($('generateBtn')) $('generateBtn').addEventListener('click', generateImage);
if ($('clearTokenBtn')) $('clearTokenBtn').addEventListener('click', clearStoredToken);
if ($('accessTokenInput')) $('accessTokenInput').addEventListener('input', async () => {
  const value = getAccessToken();
  if (value) localStorage.setItem(STORAGE_KEY, value);
  else localStorage.removeItem(STORAGE_KEY);
  refreshTokenUi();
});

setAccessToken(getStoredToken(), false);
renderGallery();
checkHealth();
loadConfig().then(checkAuthStatus);
