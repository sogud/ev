# BrowserSession P1

Status: implemented

## Goal

Every EV page and browser-workspace operation runs inside an ephemeral BrowserSession over the user's existing Chrome. Each session creates a new unfocused Chrome window and one EV tab group. All EV-created tabs in that session remain in the same group. EV never adopts, targets, moves, focuses, or closes an existing user tab/window.

P1 does not create a standalone browser or separate Chrome profile. Bookmarks, history, downloads, and recently closed sessions remain profile-global and therefore require explicit top-level commands.

## Ownership

- `packages/contracts`: validates session, one-shot, scoped workspace, and group commands at the control socket seam.
- `packages/browser-host`: owns session state, tab/window/group checks, per-session serialization, BrowserRun scoping, re-grouping, and release behavior.
- Browser extension: executes typed Chrome operations only. It does not know BrowserSession IDs or persist ownership.
- CLI and Skill: require `session.command` or `oneShot` for page/workspace actions.

BrowserSession state is memory-only. Restarting Browser Host invalidates every session. Ownership is never reconstructed from Chrome state because that could misidentify user tabs.

## Commands

### Create

```json
{
  "action": "browser.session.create",
  "url": "https://example.com"
}
```

Creates one `focused: false` Chrome window, groups the initial tab, and returns:

- `sessionId`
- dedicated `windowId`
- dedicated `groupId`
- `ownedTabIds`
- `activeTabId`

No borrowed/adopted tab concept exists.

### One-shot

```json
{
  "action": "browser.oneShot",
  "url": "https://example.com",
  "command": { "action": "page.context", "maxChars": 20000 }
}
```

Creates a temporary BrowserSession, executes one scoped command, releases EV-owned tabs, and returns the normal `BrowserSessionCommandResult`. It is for operations that do not need later refs or page state.

### Open an owned tab

```json
{
  "action": "browser.session.open",
  "sessionId": "uuid",
  "url": "https://example.com/docs",
  "active": true
}
```

The tab is created inside the dedicated window and immediately added to the session's existing group. If grouping fails, Host closes only that newly created tab and returns an error.

### Execute a scoped command

```json
{
  "action": "browser.session.command",
  "sessionId": "uuid",
  "command": {
    "action": "page.snapshot",
    "mode": "interactive"
  }
}
```

Allowed command families:

- typed `page.*`
- `browser.run`
- `zoom.get/set`
- owned tab operations: list/get/update/move/duplicate/discard/close/activate
- the session window: list/update
- the session group: list/update

Commands without `tabId` use the session's active tab. Explicit tab/window/group IDs must belong to that session. BrowserRun applies the same ownership check to every emitted atomic command. Ordinary page commands use fixed content-script/tabs APIs; advanced commands attach bounded CDP only when required, with concurrent same-tab attaches coalesced.

The following are rejected because they break isolation or the one-group invariant:

- adopting or targeting an existing user tab
- direct top-level page/window/tab/group/zoom/run actions
- pinned session tabs
- creating a second group or ungrouping session tabs
- closing the final tab instead of releasing the session
- `sessions.restore`, because its restored target is not scoped to EV ownership

### Release

```json
{ "action": "browser.session.release", "sessionId": "uuid" }
```

Release refreshes live tab state, closes only EV-owned tabs, and removes Host ownership. It never closes the window directly. If the user manually moved an unrelated tab into the dedicated window, that unknown tab survives.

## Group invariant

- Session creation makes one group titled `EV`.
- Every later owned tab is added to that group before ownership is recorded.
- Before commands and snapshots, Host refreshes live tabs.
- If an EV-owned tab was moved or ungrouped, Host adds it back to the original group, which also restores it to the dedicated window.
- Unknown tabs are never added, adopted, closed, or reported as session-owned.

The Extension action `tabGroups.add` exists only as a typed Host primitive. It is not a public top-level workspace action.

## Profile-global actions

These cannot be isolated by a Chrome window and remain top-level only when explicitly requested:

- bookmarks
- downloads and download records
- history
- `sessions.recent` read access

Destructive bookmark/history/download operations retain backup and confirmation requirements. `sessions.restore` is unavailable under isolated operation.

## Concurrency and limits

- Commands within one BrowserSession are serialized.
- Different BrowserSessions execute concurrently.
- Ownership creation is serialized across sessions.
- At most 32 sessions per Host and 32 owned tabs per session.
- A release waits for earlier commands in the same session.
- Unknown, released, stale, or empty sessions fail explicitly.

## Acceptance

1. Session creation opens a new unfocused Chrome window and creates one EV group.
2. Every session-created or duplicated tab is in the same window and group.
3. A scoped command cannot target any user tab, window, or group.
4. There is no adopt/borrowed-tab API.
5. A moved or ungrouped EV tab is restored to the session group before use.
6. Direct public workspace actions are rejected; `oneShot` creates and releases a temporary session.
7. BrowserRun and SiteRecipe remain inside session ownership.
8. Release closes only EV-owned tabs and preserves unknown user tabs.
9. Tests use fake Chrome bridges and never touch real Chrome.

## Out of scope

- Persistent sessions or restart recovery.
- Separate Chrome profiles, incognito sessions, cookie isolation, or credential isolation.
- Controlling Chrome privileged pages or native OS windows.
- Restoring recently closed user sessions.
- BrowserSession UI in Desktop.
