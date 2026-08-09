# AGENTS.md

## Project

EV is a personal, local-first Agent product organized as a lightweight Bun monorepo.

- `apps/desktop/`: Electron desktop app and Pi runtime host
- `apps/browser-extension/`: browser extension, CDP execution host, bookmarks, and browser context
- `apps/cli/`: app-bundled `ev browser` command-line client
- `packages/contracts/`: runtime-validated contracts shared across EV apps
- `skills/ev-browser/`: bundled browser-operation workflow for Pi and external runtimes

Pi owns model execution, providers, sessions, Skills, and Extensions. EV owns the user experience,
tasks, traces, runtimes, browser integration, and local access control.

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
bun install
bun run dev:desktop
bun run dev:extension
bun run verify
bun run typecheck
bun run test
bun run format:check
bun run build
bun run pack
bun run package:extension
bun run release --dry-run patch
```

Run the smallest relevant checks while developing. Before delivery, run type-checking, tests, and
builds for every affected workspace.

## UI verification operations

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
