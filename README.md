# Nano Banana Pro Web（Neodomain 版）

当前项目已支持 3 种 token 场景：

1. **没有 ACCESS_TOKEN**
   - 打开 `http://localhost:3000/token`
   - 用手机号/邮箱 + 验证码登录
   - 登录成功后，新的 `accessToken` 会：
     - 自动保存到浏览器 localStorage
     - 自动写入服务端项目根目录 `.env.runtime`
     - 自动注入当前 Node 进程运行环境
   - 之后当前项目和其它页面都可以直接调用 `gemini-3-pro-image-preview`

2. **启动前已经设置 ACCESS_TOKEN 环境变量**
   - 启动前设置：
   ```bash
   export NEODOMAIN_ACCESS_TOKEN="你的accessToken"
   # 或
   export ACCESS_TOKEN="你的accessToken"
   npm run dev
   ```
   - 启动后代码会自动直接调用模型

3. **ACCESS_TOKEN 过期或被撤销**
   - 生成接口如果识别到 token 过期，会自动清掉服务端保存 token
   - 页面会提示你重新去 `/token` 登录
   - 登录成功后会自动覆盖 `.env.runtime` 与当前运行环境
   - 随后代码会继续自动调用模型

## 启动

```bash
cd nano-banana-neodomain
npm install
npm run dev
```

## 默认模型

默认模型是：

```bash
gemini-3-pro-image-preview
```

如需修改默认模型：

```bash
export DEFAULT_MODEL_NAME="gemini-3-pro-image-preview"
```

## 路由

- `http://localhost:3000/`
- `http://localhost:3000/token`
- `http://localhost:3000/api/health`
- `http://localhost:3000/api/config`
- `POST /api/token/save`
- `POST /api/token/clear`
- `POST /api/generate-image`

## 其它页面如何复用

其它页面直接 POST：

```http
POST /api/generate-image
Content-Type: application/json

{
  "prompt": "high-end fashion textile background",
  "modelName": "gemini-3-pro-image-preview",
  "aspectRatio": "1:1",
  "numImages": "1",
  "outputFormat": "png",
  "size": "2K",
  "imageUrls": []
}
```

只要服务端已经有以下任一 token 来源，别的页面就不需要重复传 `accessToken`：

- 启动时环境变量 `NEODOMAIN_ACCESS_TOKEN`
- 启动时环境变量 `ACCESS_TOKEN`
- `/token` 页面登录后自动写入的 `.env.runtime`

## 说明

严格来说，Web 页面**不能修改你终端外层 shell 的全局环境变量**。因此这里采用的是更可用的实现：

- 写入项目内 `.env.runtime`
- 同时更新当前 Node 进程的 `process.env`

对这个项目本身来说，效果等同于“自动设置环境变量”，而且无需你重新手动复制 token。
