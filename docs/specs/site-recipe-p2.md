# SiteRecipe P2

Status: implemented

## Goal

Capture reviewed site-specific browser learnings as local typed data and run them through BrowserSession. SiteRecipe must reduce repeated discovery work without becoming a script loader or bypassing BrowserRun and tab ownership.

P2 ships two built-in approved recipes:

- `x.mute-words`
- `x.read-grok-conversation`

## Ownership

- `packages/contracts`: validates recipe definitions, lifecycle commands, typed inputs, and final results.
- `packages/browser-host`: owns the SiteRecipe registry, local storage, review tokens, domain/path checks, and typed recipe adapters.
- BrowserSession: owns every tab used by a recipe. `browser.recipe.run` requires a live `sessionId`.
- Browser extension: receives only existing typed atomic page commands. It never receives recipe definitions or recipe commands.
- CLI: exposes `recipe.*` aliases and prints only final results.

## Data model

A SiteRecipe is data for one compiled adapter, not executable code. P2 accepts only two kinds:

- `x.mute-words`
- `x.read-grok-conversation`

Adding another kind requires code, contracts, and tests. A stored recipe cannot contain JavaScript, shell commands, expressions, arbitrary Chrome methods, or arbitrary BrowserRun steps.

Common fields:

- `id`: lowercase dotted identifier.
- `version`: positive integer.
- `title` and `description`.
- `kind`: one of the compiled adapters above.
- `domains`: exact hostnames; P2 X adapters accept only `x.com` and `twitter.com`.
- `pathPrefixes`: one or more paths beginning with `/`.
- `source`: `builtin` or `user`.
- `status`: `draft` or `approved`.
- `reviewToken`: SHA-256 digest of the exact normalized definition.

`x.mute-words` data contains only:

- semantic targets for add, input, and save;
- retry attempts and delay;
- wait after each item.

`x.read-grok-conversation` data contains only:

- fixed text scope: `main` or `body`;
- default maximum characters.

## Built-ins

### `x.mute-words`

- domains: `x.com`, `twitter.com`
- path: `/settings/muted_keywords`
- Chinese semantic targets proven against the current X settings UI
- eight attempts, 400 ms delay, 300 ms post-save wait

Input:

```json
{
  "kind": "x.mute-words",
  "words": ["福不黑", "寻固炮"]
}
```

Execution:

1. Fetch a fresh page context and verify exact host and path prefix.
2. Fetch one full snapshot locally.
3. Skip words already present as exact snapshot node names.
4. Run remaining words through one local BrowserRun.
5. Fetch a second snapshot and count a word as added only when it is present.
6. Return only `added`, `skipped`, `failed`, and brief statistics.

### `x.read-grok-conversation`

- domains: `x.com`, `twitter.com`
- paths: `/i/grok/`, `/i/grok/share/`
- fixed `main` text scope
- default 100,000 characters

Input:

```json
{
  "kind": "x.read-grok-conversation",
  "maxChars": 50000
}
```

Execution:

1. Fetch a fresh page context and verify exact host and path prefix.
2. Read the fixed `main` scope through typed `page.context`.
3. Return URL, title, text, capture time, and whether the limit was reached.

The adapter never evaluates recipe-supplied selectors or JavaScript.

## Lifecycle commands

### List and get

```json
{ "action": "browser.recipe.list" }
{ "action": "browser.recipe.get", "recipeId": "x.mute-words" }
```

Both built-ins and user definitions are returned. Built-ins are immutable and approved.

### Save a draft

```json
{
  "action": "browser.recipe.draft.save",
  "recipe": {
    "id": "x.mute-words-english",
    "version": 1,
    "title": "Mute X words in English UI",
    "description": "English semantic labels",
    "kind": "x.mute-words",
    "domains": ["x.com"],
    "pathPrefixes": ["/settings/muted_keywords"],
    "targets": {
      "add": { "role": "button", "name": "Add" },
      "input": { "role": "textbox", "name": "Enter word or phrase" },
      "save": { "role": "button", "name": "Save" }
    },
    "retry": { "attempts": 8, "delayMs": 400 },
    "waitAfterItemMs": 300
  }
}
```

Saving always sets `source: user` and `status: draft`, even when replacing an approved user recipe. Drafts never run.

Built-in IDs cannot be overwritten.

### Approve an exact draft

Draft save/get returns `reviewToken`. Approval requires that exact token and a confirmation string:

```json
{
  "action": "browser.recipe.approve",
  "recipeId": "x.mute-words-english",
  "reviewToken": "64 lowercase hex characters",
  "confirm": "APPROVE_SITE_RECIPE"
}
```

If the draft changes, its token changes and old approval requests fail. Approval is never automatic. Agent workflow must show the normalized definition to the user and obtain explicit approval before sending this command.

### Run

```json
{
  "action": "browser.recipe.run",
  "recipeId": "x.mute-words",
  "sessionId": "uuid",
  "input": {
    "kind": "x.mute-words",
    "words": ["福不黑", "寻固炮"]
  }
}
```

The input kind must match the approved recipe kind.

## Storage

User recipes are stored in:

```text
$EV_HOME/browser-host/site-recipes.json
```

Fallback when `EV_HOME` is unset:

```text
~/.ev/browser-host/site-recipes.json
```

- parent directory mode: `0700`
- file mode: `0600`
- schema version: `1`
- only normalized user definitions and lifecycle state are stored
- no page content, cookies, tokens, transcripts, BrowserRun traces, or Chrome data

Built-ins remain code-owned and are merged at read time. Storage corruption fails recipe management explicitly; it does not silently activate or discard definitions.

## Domain and path enforcement

Before every run, SiteRecipe obtains the current page URL through the session and checks:

1. protocol is HTTP(S);
2. hostname exactly matches one recipe domain;
3. pathname begins with one recipe path prefix.

No wildcard, substring, registrable-domain, redirect, or suffix matching is used. A recipe approved for `x.com` does not match `evilx.com` or `x.com.example.net`.

Checks happen before any mutating recipe command.

## Limits

- user recipes: 100
- definition size: 64 KiB
- title: 200 characters
- description: 2,000 characters
- domains: 8
- path prefixes: 16
- mute words: 100, each 1–100 characters, unique after exact comparison
- result text: 100,000 characters
- draft review token: SHA-256 lowercase hex
- BrowserRun and BrowserSession limits remain unchanged

## Acceptance

1. Built-in recipes list as immutable approved definitions.
2. A saved draft cannot run.
3. Approval succeeds only for the current exact review token and explicit confirmation.
4. Stored definitions cannot contain arbitrary code or arbitrary BrowserRun plans.
5. X recipes reject non-X domains and unmatched paths before mutation.
6. `x.mute-words` skips exact existing words and returns only added/skipped/failed lists plus statistics.
7. `x.read-grok-conversation` returns only bounded main text and metadata.
8. Recipe commands never reach Extension; only atomic page commands do.
9. Every run requires a live BrowserSession and obeys its tab ownership.
10. Tests use temporary `EV_HOME`, move artifacts to Trash, and never access real Chrome.

## Out of scope

- Automatic learning capture from successful runs.
- Automatic draft approval or activation.
- Arbitrary user-authored workflows, JavaScript, selectors, shell, or Chrome API calls.
- Cloud sync or shared recipe marketplace.
- Recipe version migration, rollback, delete, import, or export.
- Locale auto-detection and multilingual built-in target variants.
- Persistent BrowserRun traces.
