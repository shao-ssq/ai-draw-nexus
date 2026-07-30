## 本地开发

### 1. 克隆项目并安装依赖

```bash
git clone https://github.com/your-name/WeDraw
cd WeDraw
pnpm install
```

### 2. 配置环境变量

在根目录下创建 `.env` 文件（参考 `.env.example`）：

```env
AI_API_KEY=your-api-key
AI_BASE_URL=https://api.anthropic.com
AI_PROVIDER=anthropic
AI_MODEL_ID=claude-sonnet-5
PORT=8787
```

> 支持 OpenAI 协议与 Anthropic 协议及任何兼容服务。base URL 是否带 `/v1` 均可，代码会自动适配。

### 3. 启动开发服务器

```bash
# 同时启动前端和后端
pnpm run dev
# 访问 http://localhost:8787

# 或者分别启动：
pnpm run dev:frontend   # 仅 Vite (http://localhost:5173)
pnpm run dev:backend    # 仅 Node 后端 (http://localhost:8787)
```

**注意**：开发时访问 `http://localhost:8787`（Node 进程同源托管前端与 API）。

## 生产部署

### 1. 构建

```bash
pnpm run build        # TypeScript 检查 + Vite 构建 + 编译 server
```

产出 `dist/`（前端静态资源）与 `dist-server/`（后端 JS）。

### 2. 配置环境变量

在部署环境中配置与 `.env.example` 相同的变量（`AI_API_KEY` 等），可通过服务器环境变量或 `.env` 文件注入。

### 3. 启动

```bash
PORT=8787 node dist-server/index.js
```

建议使用 pm2 或 systemd 守护进程。单 Node 进程同源托管前端静态资源与 `/api/*`。

### 支持的 AI 服务

| 服务商       | AI_PROVIDER        | AI_BASE_URL               | 推荐模型              |
|-----------|--------------------|---------------------------|-------------------|
| OpenAI    | openai             | https://api.openai.com/v1 | gpt-5             |
| Anthropic | anthropic          | https://api.anthropic.com | claude-sonnet-4-5 |
| 其他兼容服务    | openai / anthropic | 自定义 URL                   | -                 |

## 技术栈

- 前端：React 19 + Vite + TypeScript + Tailwind CSS
- 状态管理：Zustand
- 本地存储：Dexie.js (IndexedDB)
- 后端：Node.js + Hono

## 开源协议

MIT
