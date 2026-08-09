# AGENTS.md

## Project

- Name: EV (Enhanced Vigilance)
- Workspace directory: `apps/desktop`
- Product: the desktop runtime host in the EV monorepo
- Runtime: Pi CLI RPC (default), Codex app-server, Claude Code / Qoder stream-json
- Current priority: make the desktop app reliable and easy to use
- Deferred: local API, remote service, team collaboration, and a custom model adapter layer

EV Desktop owns the desktop experience, task orchestration, traces, and the
local WebSocket bridge consumed by EV Browser. Pi, Codex, Claude Code and Qoder own their native
execution, sessions, authentication, and configuration; EV projects them through small Runtime
Adapters. Runtime switching lives only in the composer chip row (locked after the first message);
the sidebar is display-only.

## Working rules

- Keep changes small, clear, and directly related to the requested task.
- Prefer each CLI's official structured protocol over embedding or rebuilding its runtime.
- Preserve parallel task execution and independent sessions.
- Keep user data local by default.
- Do not add compatibility code for the old `Agent` or `LLM Gateway` applications.
- Keep local services bound to `127.0.0.1`, require pairing, validate shared contracts, and
  restrict extension origins.
- Update `README.md` and `docs/specs/roadmap.md` when product behavior or priorities change.

## Commands

- Install dependencies: `bun install`
- Start development: `bun run dev`
- Type-check: `bun run typecheck`
- Run tests: `bun run test`
- Check formatting: `bun run format:check`
- Build: `bun run build`
- Package a local macOS app: `bun run pack`
- Build macOS distributions: `bun run dist`

Before delivery, run the smallest relevant checks. For code changes, normally run type-checking,
tests, and a production build. Packaging is only required when packaging behavior or native assets
change.

## Code style

- Use strict TypeScript.
- Use single quotes and semicolons.
- Use 2-space indentation and keep lines within 100 characters where practical.
- Prefer clear names and small focused modules over extra abstractions.
- Use PascalCase for React components and types, camelCase for functions and variables, and
  UPPER_SNAKE_CASE for constants.
- Keep the Electron renderer isolated from Node.js; expose native capabilities through typed preload
  APIs and IPC.
- Follow the current file language for code, comments, and commit messages.

## Architecture

- `src/main/`: Electron lifecycle, runtime adapters, tasks, traces, and
  workspace inspection
- `src/preload/`: typed IPC bridge exposed to the renderer
- `src/renderer/`: React management UI
- `src/shared/`: types shared across Electron processes
- `resources/`: EV icons and native packaging assets

Important entry points:

- `src/main/index.ts`: main process entry
- `src/main/agent-service.ts`: multi-Runtime task orchestration
- `src/main/runtime/`: Pi RPC, Codex app-server, JSONL Process Host, and adapter contracts
- `src/main/management-service.ts`: providers, resources, and application settings
- `src/main/ipc.ts`: IPC handlers
- `src/renderer/src/App.tsx`: renderer root

## Data and safety

- EV task data lives in Electron's EV user-data directory.
- Pi and Codex authentication, models, sessions, Skills, and configuration use their own native data directories.
- Never commit API keys, tokens, credentials, local transcripts, or generated user data.
- Do not delete or overwrite user workspaces or task data during development or migration work.
- Treat workspace-changing commands and Git operations as user-visible actions.
