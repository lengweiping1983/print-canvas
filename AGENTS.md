# AGENTS.md — 项目指南

> 本文档面向 AI 编程助手。如果你第一次接触本项目，请先阅读此文件，再修改代码。

---

## 项目概述

本项目包含**两个独立功能**：

1. **排版工具（`index.html`）** — 一个纯前端、单文件的服装印花排版工具（版本 v28）。
   - 用途：上传布料图，自动加载 S / M / L / XL / XXL 五个尺码的 Mask，并生成「结果预览」「排版图」「布局定位」三组可视化节点。
   - 使用方式：直接在浏览器中打开根目录的 `index.html`，不需要启动服务器。
   - 技术特点：所有 CSS 与 JavaScript 均内嵌在该 HTML 文件中；Mask 图片以 base64 Data URI 形式硬编码在 `EMBEDDED_ASSETS` 变量里。

2. **Nano Banana Neodomain Web（`server.js` + `public/`）** — 一个基于 Node.js + Express 的轻量代理服务。
   - 用途：为前端页面提供登录、Token 持久化、AI 图片生成（调用 `story.neodomain.cn` 的 `gemini-3-pro-image-preview` 模型）等后端能力。
   - 使用方式：运行 `npm run dev` 或 `node server.js`，默认监听 `http://localhost:3000`。

---

## 目录结构

```
print-canvas/
├── index.html              # 排版工具（单文件前端应用）
├── server.js               # Express 后端入口
├── package.json            # Node 项目配置，仅依赖 express
├── package-lock.json
├── README.md               # 面向人类用户的使用说明（中文）
├── AGENTS.md               # 本文件
│
├── public/                 # Express 托管的静态前端（Nano Banana Web）
│   ├── index.html          # 项目入口页（占位，引导到 /token）
│   ├── token.html          # Token 登录与图像生成主页面
│   ├── app.js              # token.html 的交互逻辑
│   └── styles.css          # 暗色风格 UI 样式
│
├── generated/              # 运行时自动生成：AI 生成的图片与元数据
│
├── BFSK26308XCJ01L-*.png   # 五个尺码的 Mask 素材（也被嵌入到根 index.html）
├── default_bg.png
├── default_logo_image.png
└── default_logo_text.png
```

---

## 技术栈

- **前端**：原生 HTML5 / CSS3 / JavaScript（无框架、无构建工具）。
- **后端**：Node.js 20+ + Express 4.x。
- **外部依赖**：
  - `express`（HTTP 服务）
  - `jszip`（排版工具通过 CDN `https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js` 引入）
- **外部 API**：`https://story.neodomain.cn`（图像生成与登录）。

---

## 启动命令

### Nano Banana Web（后端）

```bash
npm install
npm run dev     # 等价于 node server.js
```

- 端口：`process.env.PORT` 或默认 `3000`。
- 关键路由：
  - `GET  /` → `public/index.html`
  - `GET  /token` → `public/token.html`
  - `POST /api/generate-image` → 提交生图任务并轮询结果
  - `GET  /api/health` / `GET /api/config` / `GET /api/auth/status`
  - `POST /api/token/save` / `POST /api/token/clear`

### 排版工具（前端）

直接在浏览器打开文件即可，无需 Node 服务：

```bash
open index.html
```

> 注意：`server.js` 的 catch-all 路由 (`app.get('*')`) 会返回 `public/index.html`，**不会** 返回根目录的排版工具 `index.html`。因此如果你想通过 `localhost:3000/` 访问排版工具，需要手动修改 `server.js` 的路由或反向代理配置。

---

## 代码组织

### `index.html`（排版工具）

全部逻辑集中在单个 `<script>` 标签内，主要模块：

- **State**：全局 `state` 对象，保存画布视口、节点位置、布料图、Mask 分组、Logo 列表等。
- **Node 渲染**：`createNode()` / `renderNodeContent()` / `renderAll()` 负责把 `state.nodes` 渲染为 DOM。
- **图像处理**：
  - `extractPieces()` — 基于 Flood Fill 从 Mask PNG 中分割出各个裁切片。
  - `classifyPieces()` / `filterOutFrontBack()` — 识别「后背」和「前片（左前+右前）」，在布局定位中可选过滤。
  - `drawMask()` / `drawResult()` / `drawLayout()` — 使用 HTML5 Canvas 绘制排版图、结果预览、布局定位。
- **交互**：支持拖拽节点（`nodeDrag`）、平移画布（`panDrag`）、拖拽/旋转裁切片（`objectDrag`）、上传 Logo。
- **AI 生图**：通过 `fetch('/api/generate-image', ...)` 调用本地 Express 服务生成布料图。

### `server.js`

一个单文件 Express 应用，职责：

1. **静态资源托管**：`public/` 与 `generated/`。
2. **Token 管理**：
   - 读取优先级：请求 Header `x-access-token` > `.env.runtime` 文件 > 环境变量 `NEODOMAIN_ACCESS_TOKEN` / `ACCESS_TOKEN`。
   - `/api/token/save` 可把 Token 写入 `.env.runtime` 并注入 `process.env`。
3. **登录代理**：`/api/login/send-code`、`/api/login`、`/api/login/select-identity`。
4. **生图代理**：`/api/generate-image`：提交任务 → 轮询结果 → 下载图片到 `generated/` → 返回本地 URL。
5. **辅助路由**：健康检查、模型列表、查询任务结果等。

### `public/app.js`

`token.html` 的客户端逻辑：

- `localStorage` 键名：`nano_banana_access_token`。
- 登录成功后会调用 `/api/token/save` 把 Token 同步到服务端。
- 生成图片后结果会展示在 `heroPreview` 与 `galleryGrid` 中。

---

## 开发约定

- **语言**：所有 UI 文案与注释均使用**简体中文**。
- **编码**：UTF-8。
- **无构建流程**：没有 Webpack、Vite、Babel 等工具，直接编辑 HTML/JS/CSS 即可生效。
- **无测试框架**：项目中没有单元测试、E2E 测试或测试脚本。
- **无 Lint/格式化配置**：没有 ESLint、Prettier、Biome 等配置文件。
- **Node 版本**：代码中使用 `dns.setDefaultResultOrder('ipv4first')`，建议 Node.js 18+。

---

## 测试与验证

- 修改 `server.js` 后，重启服务进行验证：
  ```bash
  node server.js
  ```
  然后访问 `http://localhost:3000/api/health` 检查服务状态。
- 修改 `index.html`（排版工具）后，直接在浏览器中刷新页面验证。
- 若修改了 Mask 图片，需要同时更新根目录 `index.html` 中 `EMBEDDED_ASSETS` 里的 base64 数据，否则直接打开 `index.html` 时不会加载新图。

---

## 安全注意事项

1. **Token 明文存储**：服务端会把 `accessToken` 以明文形式写入项目根目录的 `.env.runtime` 文件，并保留在 `process.env` 中。
2. **无 CORS 限制**：`server.js` 没有配置 CORS，在公开网络部署时请注意风险。
3. **无输入校验**：API 仅做了简单的空值检查，没有严格的参数校验或转义。
4. **文件下载**：`downloadFile()` 直接将远程 URL 内容写入本地磁盘，没有额外的文件类型校验。
5. **请求体大小限制**：Express 配置了 `limit: '20mb'`，可处理较大的 JSON 或 base64 图片。

---

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | Express 监听端口 | `3000` |
| `NEODOMAIN_ACCESS_TOKEN` / `ACCESS_TOKEN` | Neodomain API 的访问令牌 | 空 |
| `DEFAULT_MODEL_NAME` | 默认生图模型 | `gemini-3-pro-image-preview` |

---

## 修改建议（给 AI 助手的提示）

- **不要引入复杂构建工具**：当前项目 intentionally 保持零构建，若引入 TypeScript / Vite 等，需要同时更新 `README.md` 与运行方式。
- **保持单文件特性**：若优化排版工具，尽量继续把 CSS/JS 保留在 `index.html` 内部，方便用户直接双击打开。
- **谨慎修改 `server.js` 中的 Token 逻辑**：多个页面（`token.html`、排版工具）依赖 `/api/generate-image` 和 `/api/token/save`，改动时需确保向后兼容。
- **新增 API 路由时**：请遵循现有的 `jsonResponse(res, status, payload)` 封装格式，统一返回 `{ success: true/false, ... }` 结构。
