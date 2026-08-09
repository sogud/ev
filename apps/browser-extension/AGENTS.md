# AGENTS.md

## App

EV Browser is the Manifest V3 browser extension in the EV monorepo. It currently provides local
bookmark browsing, search, settings, frequent sites, a popup, and a replacement new-tab page.

The extension is a client of EV Desktop. It must not embed Pi, store model credentials, execute local
commands, or expose unrestricted page evaluation. Cross-app messages belong in
`../../packages/contracts`.

## Commands

Run from the repository root:

```bash
bun run dev:extension
bun run --cwd apps/browser-extension typecheck
bun run --cwd apps/browser-extension test
bun run --cwd apps/browser-extension build
bun run package:extension
```

## Architecture

- `entrypoints/`: WXT background, popup, options, and new-tab entrypoints
- `src/background/`: Desktop bridge and browser-operation implementation
- `src/pages/`: popup, options, and new-tab React pages
- `src/components/`: shared React UI
- `src/contexts/`: extension settings state
- `src/utils/`: search, favicon, settings, and diagnostics
- `wxt.config.ts`: manifest metadata, permissions, and WXT configuration

## Safety

- Treat page content, URLs, bookmark metadata, and Desktop responses as untrusted input.
- Request the smallest browser permissions possible; document every broad host permission.
- Never inject unsanitized HTML or expose auth tokens to page scripts.
- Keep content scripts isolated and communicate through typed messages.
- Desktop pairing and local API access require explicit user approval.
- Do not add direct model-provider authentication to the extension.

## Style

- Use strict TypeScript and React 18.
- Use Chinese for product copy and comments when practical.
- Keep changes small and use WXT entrypoints instead of hand-maintained manifest or bundler files.
