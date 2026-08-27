# EV — Enhanced Vigilance

**A local-first desktop agent that puts your existing coding runtimes — Pi,
Codex, Claude Code, Qoder — behind one calm interface, on your Mac and on
your phone.**

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![ci](https://img.shields.io/badge/ci-verify%20%2B%20lint%20%2B%20golden-green.svg)](.github/workflows/ci.yml)

## Why EV

- **One inbox for every runtime.** Switch Pi / Codex / Claude Code / Qoder,
  or opt into Experimental DeepSeek Harness per task; auth stays native to each tool — EV never stores credentials.
- **Local by design.** A headless local server on `127.0.0.1`; the Electron
  shell, the CLI and the mobile web app are thin clients of the same
  contract.
- **Phone access without a cloud.** Optional remote bind to your LAN or
  Tailscale address with token tiers (observer read-only / operator), so
  your agent follows you to the couch.
- **Honest observability.** Live transcripts, per-turn traces, workspace
  diffs and a read-only inspector instead of opaque "agent did things".

## Features

- Task list with per-task runtime, model and thinking effort; locked after
  the first message to keep sessions honest.
- Streaming transcript with tool calls, changed-files cards and turn
  footnotes; workspace diff inspector (diff-first by design).
- Runtime health drawer: native auth status (read-only), config paths,
  model catalog — EV displays, never writes, native configs.
- Experimental DeepSeek Harness adapter: official stdio JSON-RPC, one isolated process per task, streamed reasoning/tools/subagents, explicit no-cold-resume behavior, and terminal process-level stop.
- Browser bridge: paired extensions over `127.0.0.1` (several Chrome profiles can stay online at once, each with its own identity); every page/workspace operation runs in a new Agent-owned BrowserSession window with one EV tab group, never the user's current tabs; ordinary DOM work avoids remote debugging while advanced diagnostics attach bounded CDP on demand; includes Host-local BrowserRun, reviewed SiteRecipes, bounded subtitle reading/downloading for yt-dlp-supported public pages, safe profile-global bookmark/history/download actions, and a bilingual optional bookmark New Tab.
- Mobile web entry at `/m`: task list, chat, model switch — nothing else.
- i18n: English (default) and 中文, following your system locale with a
  per-user override in Settings → General → Language.

## Quick start

Requirements: [pnpm](https://pnpm.io) ≥ 10 and Node.js ≥ 22.

```bash
# install and build everything
pnpm install
pnpm run build

# run the desktop app (starts the local server automatically)
pnpm run dev:desktop

# or package a local build
pnpm run pack                  # Electron app
pnpm run package:extension     # browser extension
```

The CLI ships with the app and self-hosts the server when the desktop is
closed:

```bash
ev status                     # local/remote URLs + token guidance
ev task create --runtime pi
ev task prompt <id> "say hi"
ev task follow <id> --until-idle

ev browser check
ev browser session.create --payload '{"url":"https://example.com"}' --compact
ev browser session.command --payload '{"sessionId":"UUID","command":{"action":"page.snapshot"}}' --compact
ev browser session.command --payload '{"sessionId":"UUID","command":{"action":"page.subtitles","operation":"read","language":"en"}}' --compact
ev browser oneShot --payload '{"url":"https://example.com","command":{"action":"page.context"}}' --compact
ev browser recipe.list --compact
# bookmark mutations auto-back up to ~/.ev/backups/bookmarks/
ev browser bookmarks.export --output ~/Documents/ev-bookmarks.json
```

### Phone access (optional)

```bash
ev remote on                  # bind localhost + private LAN/Tailscale IPs
ev token create --tier observer   # read-only token, printed once
ev status                     # shows lanUrl / tailscaleUrl + masked mobile URL
```

Open the printed `/m/?port=…&token=…` URL on your phone. LAN is plain HTTP —
use it on networks you trust; use Tailscale elsewhere. Revoke with
`ev token revoke <id>`, disable with `ev remote off`.

## Architecture

```text
apps/desktop        Electron shell + renderer (thin client)
apps/server         headless local server; built-in capabilities compose as static Cordis plugins
apps/cli            ev … command-line client
apps/browser-extension  paired browser bridge
apps/mobile         standalone mobile web entry (/m)
packages/contracts  the only shared package: RPC registry + wire types
packages/locales    i18next resources (en/zh), single source of truth
```

- [Server/client split](docs/specs/server-client-split-v1.md) — why the
  renderer is a pure HTTP+WS client.
- [Server Plugin Architecture](docs/specs/server-plugin-architecture-v1.md) — static Cordis composition and migration invariants.
- [Agent runtime adapters](docs/agent-runtime-adapters.md) — Runtime plugin seam and the add-a-runtime checklist.
- [Roadmap](docs/specs/roadmap.md) — what is in flight and what retired.

Server and CLI output is English by design; the UI ships in English and
中文 (`packages/locales`).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it covers setup, the
validation gates, and the AI-contribution policy (disclosure + human review

- comment density). The community follows the
  [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

EV binds localhost only by default; remote access is opt-in, token-gated and
never `0.0.0.0`. Credentials belong to your runtimes, not to EV. If you find
a vulnerability, please open a private issue or contact the maintainers
before public disclosure.

## License

[Apache License 2.0](LICENSE)
