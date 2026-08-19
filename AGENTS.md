# AGENTS.md

Guidance for coding agents working in this repository. Everything below is
grounded in the current code and configuration.

## What this is

Fuel Gauge is a terminal (Ink/React) dashboard that monitors AI coding
service quotas across nine providers. Node.js ≥ 26.4, TypeScript 7
(native), ESM only (`"type": "module"`). Single binary-style CLI in
`src/cli.tsx`; no server.

## Layout

- `src/cli.tsx` — entry point. Interactive Ink app when stdin AND stdout
  are TTYs; otherwise a single cached, token-free snapshot to stdout.
  `--clear-cache` wipes stored accounts and exits.
- `src/runtime.ts` — dependency composition (`createRuntime`): store,
  clock, fetch, browser, subprocess, callback server handed to adapters.
- `src/core/` — storage and domain: `store.ts` (credential store +
  settings schema), `monitor.ts` (`MonitorController` — the observable
  state core), `paths.ts` (config root resolution), `types.ts` (shared
  types, `PROVIDER_ORDER`), `time.ts` (injectable `Clock`), plus oauth,
  jwt, http, subprocess, browser, discovery, callback-server, alerts.
- `src/providers/` — one adapter file per provider plus `provider.ts`
  (adapter contracts) and `index.ts` (registry; `satisfies
  ProviderRegistry`, so a missing provider is a compile error).
- `src/ui/` — `app.tsx` (all routes/overlays), `viewport.ts` (size
  budgets), `accounts-view.ts`, `non-interactive-snapshot.tsx`.
- `test/` — mirrors `src/` (`core/`, `providers/`, `ui/`) using
  `node:test`; `test/e2e/emitted-pty.test.mjs` drives the BUILT CLI in a
  PTY (`npm run build` first, then `npm run test:dist`).

## Verification

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # biome (also: npm run check)
npm test            # unit tests (node --import=tsx --test)
npm run build && npm run test:dist   # e2e against dist
```

Known environment hazard: `test/core/callback-server.test.ts` binds the
fixed port 1455. A locally running Codex process (or any occupant of
1455) fails those tests with EADDRINUSE — not a code regression.

## Conventions

**TypeScript/ESM.** `module`/`moduleResolution: NodeNext`; every relative
import carries a `.js` extension. `verbatimModuleSyntax` is on — type
imports must use `import type`. `strict` +
`noUncheckedIndexedAccess` are on. Files are kebab-case; core is `.ts`,
UI is `.tsx`. Formatting/lint is Biome, 2-space indent
(`files.includes` covers only `src/`, `test/`, and root config files).

**Testing.** `node:test` + `assert` from `node:assert/strict`. No network
in unit tests: fake clocks (`createManualClock`), fake fetch/subprocess/
browser registries. Pure logic that the UI needs is exported from
`src/ui/app.tsx` (e.g. `planSourcesList`, `nextAutoRefresh`) so tests can
exercise it without a PTY. UI tests render via `ink-testing-library` with
a `withApp` harness that waits for a seeded account before driving keys.
E2E asserts leak-freedom: no clock intervals, callback servers, fetches,
or subprocesses survive exit.

**State/store.** `MonitorController` publishes immutable snapshots for
`useSyncExternalStore` — never mutate records in place. Settings and
accounts go through `CredentialStore`: atomic writes (temp file +
rename), 0o600 files, 0o700 directories, serialized write queue. On-disk
shapes are structurally validated (`validateSettings`,
`validateStoredAccount`); unknown fields are ignored; settings schema is
versioned (`SETTINGS_SCHEMA_VERSION`), and providerOrder repair is
additive-only. Defaults live in `DEFAULT_SETTINGS` (deep-frozen);
auto-refresh defaults to ON at 10 minutes with presets off/1m/5m/10m
cycled in Settings (`nextAutoRefresh` in `app.tsx`).

**Credential discipline.** `StoredAccount` (in `types.ts`) is the only
type family carrying raw credentials. Everything the UI/monitor sees is
a token-free `AccountSummary` produced by `storedAccountToSummary`;
summaries additionally pass `redactSensitiveFields` +
`scrubSecretValues`. Error text shown to users goes through
`sanitizeUiError` / `sanitizeErrorText`; long opaque runs are stripped.
Never log or expose token values; tests assert their absence.

**Providers.** New provider = new file in `src/providers/` + entry in
`PROVIDER_ORDER`/`PROVIDER_LABELS` (`types.ts`) + factory registered in
`index.ts` + stored/summary types + validation in `store.ts`. Adapters
receive all dependencies via `RuntimeDependencies`; never import the
runtime directly.

**UI.** Ink only. Each route owns its `useInput` handler; global keys
pause while a field or modal is focused. Every route must fit the
viewport: compute row budgets explicitly (see `planSourcesList`,
Settings' `settingBudget`) — the Claude policy warning must NEVER be
truncated; if it cannot fit, its confirm control must not mount.

## Unresolved

- The package is publish-ready but NOT yet on the npm registry:
  `npm publish` requires an interactive `npm login` first. Package
  `fuel-gauge`, bins `fuel-gauge` + `fgg` (both → `dist/cli.js`),
  `prepublishOnly` runs typecheck + lint + tests + build. Note: the
  unscoped name `fgg` is registry-blocked (unpublished 2020), which is
  why the bin is `fgg` but the package stays `fuel-gauge`.
- `package.json` has no `repository` field (no git remote configured).

Runtime: `ink`, `react`, `@inkjs/ui`, `open`. Dev: `typescript` 7.x
(native), `tsx`, `biome`, `@types/node`, `@types/react`,
`ink-testing-library`. Nothing else — do not add dependencies without
strong justification.

## Unresolved

- No git commits yet (`master` has zero commits); everything is
  untracked. The first commit should include this file.
- Package is not published to a registry; `package.json` has no
  `repository` field.
