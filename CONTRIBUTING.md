# Contributing to EV

Thanks for investing time in EV. This document covers how to set up a
development environment, how changes are validated, and the bar we hold code
to — including work produced with AI assistance.

## Development setup

Requirements: [pnpm](https://pnpm.io) ≥ 10 (package manager) and
Node.js ≥ 20 (the server runtime).

```bash
pnpm install
pnpm run dev:desktop      # Electron app with hot reload
pnpm run dev:extension    # browser extension in watch mode
```

The desktop app owns a headless local server (`apps/server`); the CLI
(`ev …`) and the renderer are pure clients of it. See
[docs/specs/server-client-split-v1.md](docs/specs/server-client-split-v1.md)
for the architecture and
[docs/agent-runtime-adapters.md](docs/agent-runtime-adapters.md) before
touching runtime integration code.

## Validation

Every change must pass the three gates before review:

```bash
pnpm run verify          # format check + typecheck + tests + build
pnpm run lint            # ESLint (typescript-eslint recommended + quality rules)
pnpm run quality         # knip (dead code/deps) + madge (circular imports)
bash scripts/golden-path.sh   # end-to-end regression on an isolated port
```

Run the smallest relevant subset while iterating; run the full set before
asking for review. The golden path uses port 9344 and cleans up after itself
— never point it at a user instance.

## Pull request guidelines

- One concern per PR. Split refactors from behavior changes.
- Keep package boundaries real: cross-app wire formats belong in
  `packages/contracts`; the desktop renderer and the mobile web app are
  clients and must not import each other.
- UI primitives come from Base UI (`@base-ui/react`). Do not introduce other
  headless component libraries.
- User-visible strings go through i18next resources in
  `packages/locales` (`en.json` is the source of truth, `zh.json` mirrors
  it). Server and CLI output is English by design.
- Comments are English, high-signal, and explain _why_: constraints,
  invariants, and non-obvious behavior. Comments that restate the code are
  removed in review.
- Do not commit credentials, transcripts, browser profile data, or generated
  user data. Local services must stay on `127.0.0.1` and require pairing.

## AI contribution policy

AI-assisted contributions are welcome when the author takes responsibility for
the result. Concretely:

1. **Disclosure** — state in the PR description which parts were produced
   with AI tooling and which prompts/workflows were used.
2. **Human review bar** — the author must understand and be able to defend
   every changed line. PRs that read as unreviewed model output (wrong
   abstractions, speculative features, slop patterns) are closed.
3. **Comment density** — AI-generated comments tend toward narration. We keep
   comments that document constraints and rationale only; PRs that add
   boilerplate or self-evident comments are asked to remove them.
4. **Validation evidence** — include the commands you ran and their results.
   Claims without evidence ("tests pass") are treated as unverified.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
