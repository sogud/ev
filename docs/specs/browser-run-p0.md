# BrowserRun P0

Status: implemented

## Goal

Let an Agent submit one bounded browser plan and receive one final result. Browser Host owns sequencing, semantic target resolution, loops, retries, and failure aggregation. Extension remains an atomic Chrome/CDP executor.

The first acceptance case is adding a list of X muted words without returning intermediate snapshots to the Agent.

## Ownership

- `packages/contracts`: validates plans and results at the control socket seam.
- `packages/browser-host`: executes BrowserRun locally through the existing `BrowserCommandExecutor` interface.
- Browser extension: unchanged atomic actions; it must never execute `browser.run` directly.
- CLI: submits a plan and prints only `BrowserRunResult`.

## Command

```json
{
  "action": "browser.run",
  "tabId": 123,
  "steps": [
    {
      "kind": "forEach",
      "id": "add-words",
      "items": ["福不黑", "寻固炮"],
      "onError": "continue",
      "steps": [
        {
          "kind": "command",
          "command": {
            "action": "page.click",
            "target": {
              "role": "link",
              "name": "添加隐藏的字词或短语"
            }
          },
          "retry": { "attempts": 8, "delayMs": 400 }
        },
        {
          "kind": "command",
          "command": {
            "action": "page.type",
            "target": {
              "role": "textbox",
              "name": "输入字词或短语"
            },
            "text": { "from": "item" },
            "clearFirst": true
          },
          "retry": { "attempts": 8, "delayMs": 400 }
        },
        {
          "kind": "command",
          "command": {
            "action": "page.click",
            "target": { "role": "button", "name": "保存" }
          }
        },
        { "kind": "wait", "timeMs": 300 }
      ]
    }
  ]
}
```

## P0 plan language

Top-level steps:

- `command`: one supported atomic page command.
- `wait`: local delay; no extension round-trip.
- `forEach`: bounded list of strings; children may contain `command` and `wait`, never another loop.

Supported commands:

- `page.navigate`
- `page.click`
- `page.type`
- `page.press`

`page.click` and `page.type` accept a target:

- `{ "selector": "@e1" }` or CSS selector.
- `{ "role": "button", "name": "保存", "exact": true, "index": 0 }`.

A semantic target is resolved from a fresh interactive snapshot on every attempt. This prevents stale snapshot refs from leaking into plans.

`page.type.text` is either a literal string or `{ "from": "item" }` inside `forEach`.

## Retry and failure semantics

- `attempts` includes the first attempt; default `1`, maximum `10`.
- `delayMs` is fixed delay between attempts; default `0`, maximum `10_000`.
- Each retry resolves semantic targets again.
- Top-level failure stops the run and returns `status: failed`.
- `forEach.onError: continue` records the failed item and continues.
- `forEach.onError: stop` stops on the first failed item.
- A partial run returns `status: partial`, not a transport error.

## Limits

- Top-level steps: 50.
- Items per loop: 100.
- Child steps per loop: 20.
- Total attempted atomic commands: 2,000.
- Local wait: 10 seconds per step.
- Plan payload remains inside the existing 1 MiB control request limit.
- No nested loops, arbitrary expressions, shell commands, DOM JavaScript, or `page.eval`.

## Result

```json
{
  "runId": "uuid",
  "status": "partial",
  "summary": {
    "commands": 89,
    "iterations": 31,
    "retries": 3,
    "durationMs": 18230
  },
  "failures": [
    {
      "stepId": "add-words",
      "itemIndex": 30,
      "item": "单身弟弟",
      "message": "Semantic target not found: link 添加隐藏的字词或短语"
    }
  ]
}
```

Intermediate snapshots and command responses are not returned. P0 does not persist a trace; a later version may add a local trace artifact without changing the default result.

## Acceptance

1. One `browser.run` command can iterate 31 X muted words with local retries.
2. The bridge receives only existing atomic commands, never `browser.run`.
3. Semantic targets are re-resolved after every snapshot and retry.
4. One failed item can be reported while later items continue.
5. CLI output contains only `BrowserRunResult`; no snapshot nodes or page text.
6. Existing atomic `ev browser <action>` commands remain compatible.

## Out of scope

- BrowserSession and dedicated Chrome window ownership.
- Recipe registry and learning capture.
- Persistent trace, cancellation, pause/resume, DAGs, nested loops, and arbitrary variables.
