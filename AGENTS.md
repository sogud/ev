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

## AgentSpace context

- This repository is a specialist execution entry: start the agent from the EV directory so these
  product rules and the repository Git boundary apply naturally.
- When checked out under AgentSpace, `../../harness context --json` must resolve this directory as
  the `ev` repo-project; the root workspace remains the control plane for general and cross-project
  work.
- AgentSpace may start an EV agent through Herdr with this repository as its cwd. The parent agent
  should pass only the task and necessary cross-project context; this file remains the EV authority.
- The shared stable user profile is `../../USER.md` when that parent workspace is present. EV remains
  usable as a standalone clone when it is absent.

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

- 通用页面打开/截图优先用 EV 自己的浏览器能力(`ev browser oneShot` / `session.command`),顺带 dogfood 浏览器链路;agent-browser 只在 EV 不可用时兜底。
- 开发期 UI 调试优先在 web 形态(`pnpm dev:web` + 浏览器)进行,桌面端只做同步验证
  (2026-08-16 用户定案:浏览器能同时 debug 与调 UI,优于 Electron 链路)。
- Electron CDP + `agent-browser` on port 9333; 9222 is the user's Chrome, never touch it.
- Assert UI with `agent-browser eval` text assertions; do not read full-size screenshots
  (root `AGENTS.md` red line).
- After clicking a history task, wait 5-6s before asserting: runtime cold start exceeds 1s and a
  transient empty state is not a render bug.
- If CDP snapshot refs go stale, click by stable DOM text via eval instead of retrying stale refs.
- On cleanup, only kill `dist/Electron.app` instances this session started.

## Git safety

- This repository is the source of truth for every EV app and shared package.
- Treat workspace-changing commands and Git operations as user-visible actions.
- Do not commit build output, local settings, API keys, tokens, or browser profile data.

## 测试与验证红线

- UI 验证禁止启动 Electron：renderer 是纯 Web 客户端，一律用 agent-browser 自带浏览器
  测 server 服务的 Web 形态（`/?port&token`），视口用 `agent-browser set viewport`。
- 任何自动化测试必须 `EV_HOME` 临时目录隔离，结束（含失败）把临时目录移入
  `~/.Trash`，永不读写用户真实 `~/.ev`。
- 铁律：不 `rm -rf` 任何目录/文件；删除一律移入垃圾桶（`~/.Trash`）。
