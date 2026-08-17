# WebMCP Bridge & Action Visualization

Status: implemented

Independent implementation of the two high-value capabilities identified in the
2026-08-17 ChatGPT extension teardown (`analyses/2026-08-17-chatgpt-extension-teardown`):
letting websites register native tools for the agent (WebMCP), and letting the
user see what the agent is operating on. Written from the public WebMCP concept
and product intent only; no third-party extension code was copied, translated,
or adapted.

## Goal

- Websites can expose bounded, named tools to EV agents through a page-side API.
- Agents can list and call those tools through the existing
  `browser.session.command` / `browser.oneShot` command surface.
- Every element action shows a short-lived highlight so users can see what EV
  is about to touch; the behavior is a settings switch with zero overhead when
  off.

## WebMCP bridge

### Page-side API (MAIN world)

`entrypoints/webmcp-page.content.ts` injects a MAIN-world script at
`document_start` that defines `navigator.modelContext` (leaving any
pre-existing implementation untouched):

```js
const dispose = navigator.modelContext.registerTool({
  name: 'search_products',            // required, [a-zA-Z0-9._-]{1,128}
  description: 'Search the catalog',  // optional, <= 4096 chars
  inputSchema: { type: 'object' },    // optional JSON object
  execute: async args => ({ items: [] }),
});
dispose();                             // or navigator.modelContext.unregisterTool(name)
```

`execute` callbacks never leave the page. Only JSON-safe tool metadata crosses
the world boundary via `window.postMessage`, tagged `ev-webmcp-page` /
`ev-webmcp-host`. A page can register at most 128 tools.

### Content-script registry (ISOLATED world)

`entrypoints/webmcp.content.ts` maintains the per-tab tool table
(`src/webmcp/registry.ts`), validates every inbound message defensively, and
answers background requests over `chrome.runtime.onMessage`:

- `ev-webmcp.listTools` → `{ tools: [{ name, description?, inputSchema? }] }`
  (empty list when the page registered nothing).
- `ev-webmcp.callTool` → round-trips the call into the page, enforces the
  timeout (100ms–60s, default 30s), and resolves with a JSON envelope.
- `ev-action.highlight` → draws the action highlight (below).

### Command surface

Two typed actions in `packages/contracts/src/browser.ts`, both session-scoped
(`page.*`), so they flow through `browser.session.command` and
`browser.oneShot` unchanged and only ever target EV-owned tabs:

- `page.webmcp.listTools` → `BrowserWebMcpListResultSchema`
- `page.webmcp.callTool` (`name`, optional `args`, optional `timeoutMs`) →
  `BrowserWebMcpCallResultSchema`

Tool calls always resolve to a JSON envelope `{ tabId, name, ok, result?, error?, errorCode? }`:
missing tools, timeouts, page-side exceptions, non-serializable results, and a
missing content script (`bridge-unavailable`) are all reported as data, never
as transport failures. `browser.capabilities` advertises both actions without
requiring CDP or `chrome.scripting`.

## Action visualization

Before EV executes an element action (`page.click`, `page.type`,
`page.setChecked`, `page.select`, `page.focus`, `page.hover`, `page.drag`, and
`page.scroll` with a target), the background asks the content script to draw a
highlight on the target element:

- Independent overlay layer: one fixed-position, `pointer-events: none`,
  max-z-index root (`#__ev_action_highlight__`) appended to
  `document.documentElement`; the target element's styles, layout, and hit
  testing are never touched.
- Ring (2px accent border) + `EV · <action>` label; the label flips below the
  element when there is no room above. Each highlight removes itself after
  ~900ms; concurrent highlights are bounded.
- Single rendering source: `drawActionHighlight` in
  `src/content/action-highlight.ts` runs directly in the content script and is
  also serialized via `toString()` into a `Runtime.callFunctionOn` declaration
  for the CDP path, so both execution paths render identically.
- Frame-scoped element actions (`frameId` set) skip highlights (main frame
  only); highlight failures never fail the surrounding action.

### Settings switch

`actionHighlight` in extension settings (`chrome.storage.sync`, default
`true`, toggle on the options page). The background caches the flag and
refreshes it through `chrome.storage.onChanged`; when disabled, element
actions only pay one boolean check — no messaging, no injection.

## Safety

- Page content is untrusted: every window/runtime message is shape-validated;
  tool metadata is sanitized and bounded before it enters the registry.
- The bridge exposes no evaluation surface: only registered `execute`
  callbacks run, and results must survive a JSON round-trip.
- WebMCP commands respect BrowserSession ownership like every other `page.*`
  action; there is no path to call tools on user tabs.
- Content scripts add no new permissions; the manifest already carries the
  documented HTTP(S) host access for page control.
- Highlights are cosmetic, best-effort, and isolated from the action pipeline.

## Completion criteria

- Contracts validate both commands, the tool schema, and both result envelopes
  (success requires `result`, failure requires `error`, error codes bounded).
- Extension tests cover the page API, registry round-trip/timeout/caps,
  overlay rendering/lifetime, background bridge error wrapping, and the
  controller routing for list/call/highlight on both DOM and CDP paths.
- Browser Host tests cover session ownership for `page.webmcp.*`.
- `pnpm --dir apps/browser-extension run build` emits both content scripts and
  declares them in the MV3 manifest (MAIN world page API at `document_start`).
