# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Diagram Hub - An AI-powered diagram creation platform supporting Mermaid, Excalidraw, and Draw.io engines. Users describe diagrams in natural language and AI generates them.

## Development Commands

```bash
# Install dependencies
pnpm install

# Start dev server (frontend + backend together, http://localhost:8787)
pnpm run dev

# Or run separately:
pnpm run dev:frontend   # Vite only (http://localhost:5173)
pnpm run dev:backend    # Node backend only (http://localhost:8787, tsx watch)

# Build (frontend dist/ + server dist-server/)
pnpm run build

# Start production server
pnpm start            # node dist-server/index.js

# Other commands
pnpm run lint         # ESLint
pnpm run preview      # Preview production build
```

**Note**: 开发时访问 `http://localhost:8787`（Node 进程同源托管前端与 API）。

## Architecture

### Monorepo Structure
- **Root**: React frontend (Vite + React 19 + TypeScript)
- **server/**: Node.js backend (Hono) — API endpoints + static file hosting

### Frontend Architecture

**State Management**: Zustand stores in `src/stores/`
- `editorStore.ts` - Current project, canvas content, unsaved changes tracking
- `chatStore.ts` - Chat messages for AI interaction
- `payloadStore.ts` - OpenAI-compatible message payloads

**Data Layer**: Dexie.js (IndexedDB) in `src/lib/db.ts`
- `projects` table - Project metadata with thumbnails
- `versionHistory` table - Content snapshots per project

**Feature Modules** (`src/features/`):
- `engines/` - Drawing engine integrations (mermaid, excalidraw, drawio)
- `chat/` - AI chat panel components
- `editor/` - Canvas and version history UI
- `project/` - Project management

**Services** (`src/services/`):
- `aiService.ts` - Frontend AI client with SSE streaming support
- `projectRepository.ts` / `versionRepository.ts` - IndexedDB CRUD

### Backend Architecture

Node.js + Hono server (`server/`):
- `index.ts` - Hono app entry, mounts API routes, serves `dist/` static files with SPA fallback
- `routes/chat.ts` - AI chat endpoint (OpenAI/Anthropic proxy with streaming)
- `routes/parse-url.ts` - URL content parsing and markdown conversion
- `routes/health.ts` - Health check endpoint
- `_shared/` - Shared utilities (types, CORS, AI providers, streaming)

The server reads config from `process.env` (loaded via `dotenv` from `.env`). Business logic uses Web-standard APIs (`Request`/`Response`/`fetch`/`TransformStream`), natively supported by Node 18+.

### Key Patterns

**Path Alias**: Use `@/` for imports from `src/` (configured in vite.config.ts and tsconfig)

**Engine Types**: `'mermaid' | 'excalidraw' | 'drawio'` - defined in `src/types/index.ts`

**AI Message Format**: OpenAI-compatible with multimodal support (text + images)

## Environment Setup

Create `.env` file in root directory (see `.env.example`):
```env
AI_API_KEY=your-api-key
AI_BASE_URL=https://api.anthropic.com
AI_PROVIDER=anthropic
AI_MODEL_ID=claude-sonnet-5
PORT=8787
```

For production, configure the same environment variables on the server (systemd/pm2 env, or a `.env` file next to `dist-server/`). The `VITE_API_BASE_URL` is not required — same-origin deployment resolves `/api` automatically.
