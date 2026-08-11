# Seedance AI Video Generation

## Project Structure

- `frontend/` — Next.js App Router (port 8111)
- `backend/` — Fastify API server (port 8112)
- `nginx-sd.xingke888.com.conf` — Nginx reverse proxy config

## Frontend

- Next.js 15 with App Router, TypeScript
- CSS Modules for styling (`page.module.css`)
- No auth — standalone project
- API client at `frontend/lib/api.ts` (proxies to backend)

### Key Pages

- `/voiceover-v3` — Main video generation page (script → TTS + storyboard → video)
- `/tasks` — Task list with card layout, click-to-copy task ID
- `/billing` — Billing overview, compact one-line layout
- `/assets/real` — 真人资源 (LivenessFace assets)
- `/assets/virtual` — 虚拟人像 (AIGC assets)
- `/tokens` — Token管理 (hidden from nav)
- `/keys` — 资源密钥 (hidden from nav)

### UI Conventions

- Flat style (no card/box wrappers on main content), similar to tasks page
- Mobile responsive with `@media (max-width: 768px)` breakpoints
- Collapsible sections with useState boolean toggles
- Primary color: `#2563eb` (blue) for action buttons
- Border buttons for secondary actions (e.g. 参数设置)
- Resource boxes: gray border `#e5e7eb`, uniform style
- Sticky params button below nav (top: 44px) on mobile
- TopNav: sticky, 44px height, dark background `#1e293b`

### Components

- `TopNav` — Navigation bar (视频生成, 真人资源, 虚拟人像, 任务列表, 账单)
- `AssetsPanel` — Shared assets panel component (exported from `app/assets/page.tsx`)
- `ParamsPanel` — Video params (model, resolution, voice, style, ratio, toggles)
- `MediaPanel` — Upload and display reference media (button in title row)
- `AssetLibrary` — Collapsible asset library (real/virtual)

### Voiceover-v3 Page Flow

1. **视频需求** — Input script text (or use AI生成 via DeepSeek to auto-generate)
2. **字幕(可选)** — Subtitle text + voice selector + TTS generation (Azure)
3. **参考素材** — Upload images/video/audio, asset library (真人/虚拟头像)
4. **主体定义** — AI analyze subjects from uploaded media (Gemini Vision)
5. **一键生成分镜** — AI generates storyboard shots from script
6. **分镜视频生成** — Submit each shot to Seedance API for video generation
7. **分镜合并** — Merge videos + burn SRT subtitles + overlay TTS audio (ffmpeg)

### Key Features

- **Independent TTS**: Azure Cognitive Services (not Seedance built-in audio)
- **Subtitle burn-in**: ffmpeg burns SRT into merged video
- **Video caching**: Downloaded videos cached locally with metadata (duration)
- **Smart subtitle splitting**: Only breaks at punctuation, each shot audio < video duration
- **State persistence**: localStorage saves work across page refreshes
- **Batch tasks**: PostgreSQL persistence for task history

## Backend

- Fastify with CORS enabled
- Routes: `/voiceover/*`, `/video/*`, `/assets/*`, `/manage/*`, `/upload`, `/batch/*`
- Environment: `.env` file (see `.env.example`)
- PostgreSQL for batch_tasks (JSONB fields for shots/tasks)
- Video cache at `backend/uploads/.video-cache/` (MP4 + JSON metadata)

### Key Backend Endpoints

- `POST /voiceover/generate-script` — AI generate video script (DeepSeek)
- `POST /voiceover/init` — Generate storyboard shots from script
- `POST /voiceover/tts` — Azure TTS audio generation
- `POST /voiceover/merge` — Concat videos + burn subtitles + mux audio
- `POST /voiceover/analyze-subjects` — Gemini Vision subject analysis
- `POST /video/generate` — Submit video generation task to Seedance API
- `GET /video/task/:taskId` — Poll task status (auto-caches on success)

## Development

```bash
cd frontend && npm run dev  # port 8111
cd backend && node src/app.js  # port 8112
```

## Git

- Avatar images (`frontend/public/avatars/`) are in .gitignore (too large for git)
- Remote: https://github.com/xingke2023/seedance
- Azure subtitle version: https://github.com/xingke2023/seedance-azure-subtile
