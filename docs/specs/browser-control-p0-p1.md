# Browser Control P0/P1

Status: implemented

## Goal

EV Browser should complete ordinary browser tasks against the user's existing Chrome without exposing arbitrary JavaScript, CDP methods, Chrome APIs, shell commands, credentials, or browser secrets.

The external seam remains the validated `BrowserCommand` discriminated union in `packages/contracts`. The Host owns orchestration, sessions, retries, backups, and final-result projection. The Extension owns Chrome API and bounded CDP implementation.

## P0: page interaction

New typed actions:

- `page.history`: `back | forward | reload | stop`
- `page.setChecked`: set a checkbox/radio/switch to an explicit boolean state
- `page.select`: select one or more values in a native `<select>`
- `page.drag`: drag one semantic/snapshot target to another
- `page.focus`: focus a target
- `page.inspect`: return bounded element state and attributes
- `page.dialog.respond`: accept or dismiss a JavaScript dialog
- `page.pointer`: deterministic coordinate move/down/up/click fallback for canvas-like surfaces

Existing actions gain bounded fields:

- `page.click`: mouse button and click count
- `page.press`: letters, digits, function keys, and existing navigation keys
- `page.scroll`: target scrolling and bounded x/y deltas
- `page.wait`: target, time, navigation, network-idle, popup, and download conditions
- target/context/snapshot commands: optional `frameId`

`BrowserRun` supports the new P0 actions. Semantic targets are resolved from a fresh snapshot before every attempt. No caller-provided script or selector-generating JavaScript is accepted.

### Hybrid execution

Ordinary actions use fixed `chrome.scripting.executeScript` functions or tabs APIs and do not attach Chrome remote debugging: navigate/history, context/snapshot, normal left click, type/check/select/focus/inspect/scroll, target/time waits, and viewport screenshots.

Advanced variants retain bounded CDP: drag/hover/keyboard/pointer/dialog, `frameId`, navigation/network/popup/download waits, full-page screenshot, upload, frames/media, Console/Network, emulation, and right/middle/double click. The content-script functions are Extension-owned fixed code; callers still cannot submit JavaScript.

Concurrent advanced commands for one tab share one in-flight `chrome.debugger.attach` promise. The same-tab race test records one attach call for three concurrent commands; different tabs use separate attachments.

## P1: browser workspace

New typed actions:

- windows: `windows.list`, `windows.update`, `windows.close`
- tabs: `tabs.get`, `tabs.update`, `tabs.move`, `tabs.duplicate`, `tabs.discard`
- groups: `tabGroups.list`, `tabGroups.add`, `tabGroups.create`, `tabGroups.update`, `tabGroups.ungroup`
- downloads: `downloads.list`, `downloads.pause`, `downloads.resume`, `downloads.cancel`, `downloads.open`, `downloads.show`, `downloads.remove`
- history: `history.search`, `history.getVisits`, `history.remove`
- recently closed: `sessions.recent`, `sessions.restore`
- zoom: `zoom.get`, `zoom.set`

History and download deletion require exact confirmation literals. Extension capabilities and HTTP(S) host access are required permissions and are always enabled. `tabGroups` and `sessions` are declared permissions because they are explicit product capabilities.

## Safety

- Only `http:` and `https:` navigation and history URLs are accepted.
- Public page/window/tab/group/zoom/run actions require `browser.session.command` or `browser.oneShot`.
- Each BrowserSession uses a new unfocused window and one EV tab group; existing user tabs/windows cannot be adopted or targeted.
- Bookmarks, history, downloads, and `sessions.recent` remain explicit profile-global actions; `sessions.restore` is unavailable under isolated operation.
- Raw cookies, passwords, tokens, passkeys, autofill records, and browsing-data dumps are not exposed.
- No caller-provided JavaScript, arbitrary `Runtime.evaluate`, CDP method, Chrome API, shell command, or selector script is accepted.
- Ordinary actions do not call `chrome.debugger.attach`; advanced actions do, and a denied attach is returned without repeated retries.
- BrowserRun remains bounded by its existing step, iteration, retry, atomic-command, and timeout limits.
- Destructive actions use explicit confirmation strings and return bounded summaries.
- Network/log results retain current redaction and bounds.
- Chrome privileged pages, native OS dialogs, CAPTCHA, 2FA, password manager, DRM, and browser policy remain outside the interface.

## Completion criteria

- Contracts reject unknown actions, unbounded input, missing confirmations, and unsupported URLs.
- Extension tests cover each new action family through mocked Chrome/CDP interfaces.
- BrowserRun tests cover target resolution and dispatch for all target-bearing P0 actions.
- Capability output lists only implemented actions.
- CLI aliases normalize every action without adding bespoke execution paths.
- Contracts, Extension, Browser Host, CLI tests, typechecks, lint, quality, build, and `git diff --check` pass without starting Electron or touching real Chrome.
