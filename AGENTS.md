# AGENTS.md

## Project

EV is a personal, local-first Agent product organized as a lightweight pnpm monorepo.

- `apps/desktop/`: Electron desktop app and Pi runtime host
- `apps/browser-extension/`: browser extension, CDP execution host, bookmarks, and browser context
- `apps/cli/`: app-bundled `ev browser` command-line client
- `packages/contracts/`: runtime-validated contracts shared across EV apps
- `skills/ev-browser/`: bundled browser-operation workflow for Pi and external runtimes

Pi owns model execution, providers, sessions, Skills, and Extensions. EV owns the user experience,
tasks, traces, runtimes, browser integration, and local access control.

## Workspace embedding

- EV works as a standalone clone. When checked out inside a larger multi-repo workspace, this file
  remains the authority for EV-specific rules; the parent workspace owns only cross-project
  coordination.
- Agents working on EV should start from this directory so these rules and the repository Git
  boundary apply naturally.

## Working rules

- Read the nearest nested `AGENTS.md` before changing an app.
- Keep package boundaries real: only extract code after at least two consumers need it.
- Put cross-app wire formats in `packages/contracts`; do not import Desktop implementation into the
  browser extension.
- Keep user data local by default and never commit credentials, transcripts, or generated user data.
- Browser inputs and local API requests are untrusted and must be validated at the boundary.
- Local services must listen only on `127.0.0.1`, require pairing, and restrict allowed origins.
- Runtimes plug in only through the `AgentRuntimeAdapter` contract (registry + descriptor-driven
  UI); see `docs/agent-runtime-adapters.md` for the plugin levels and add-runtime checklist. No
  ad-hoc per-runtime special cases in UI or services.
- UI primitives come from Base UI (`@base-ui/react`); do not introduce Radix or other headless
  libraries.
- Update `README.md` and `docs/specs/roadmap.md` when product behavior or priorities change.
- Simplicity first: add a feature only for a current need; delete dead code in the same change.
  Prefer few, modular surfaces (view-model maps, components present, services own state) over
  complete-but-unused. 高性能、简单、好维护、好迭代。

## Commands

```bash
pnpm install
pnpm run dev:desktop
pnpm run dev:web
pnpm run dev:extension
ev server start|stop|restart|status|logs
pnpm run verify
pnpm run typecheck
pnpm run test
pnpm run format:check
pnpm run build
pnpm run pack
pnpm run package:extension
pnpm run release --dry-run patch
```

Run the smallest relevant checks while developing. Before delivery, run type-checking, tests, and
builds for every affected workspace.

## UI verification operations

- Prefer EV's own browser capabilities (`ev browser oneShot` / `session.command`) for opening pages
  and taking screenshots; third-party browser automation tools are only a fallback when EV is
  unavailable.
- During development, prefer the web form (`pnpm dev:web` + a browser) for UI debugging; use the
  desktop app for parity checks only.
- When driving Chrome via CDP, never attach to the user's running Chrome profile; use a dedicated
  EV-owned window.
- Assert UI with DOM/text assertions instead of reading full-size screenshots into the model
  context.
- After clicking a history task, wait 5-6s before asserting: runtime cold start exceeds 1s and a
  transient empty state is not a render bug.
- If CDP snapshot refs go stale, click by stable DOM text instead of retrying stale refs.
- On cleanup, only terminate app instances started by the current session.

## Git safety

- This repository is the source of truth for every EV app and shared package.
- Treat workspace-changing commands and Git operations as user-visible actions.
- Do not commit build output, local settings, API keys, tokens, or browser profile data.

## 测试与验证红线

- UI 验证禁止启动 Electron：renderer 是纯 Web 客户端，一律用浏览器自动化工具
  测 server 服务的 Web 形态（`/?port&token`）。
- 任何自动化测试必须 `EV_HOME` 临时目录隔离，结束（含失败）把临时目录移入
  `~/.Trash`，永不读写用户真实 `~/.ev`。
- 铁律：不 `rm -rf` 任何目录/文件；删除一律移入垃圾桶（`~/.Trash`）。
