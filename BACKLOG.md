# BACKLOG — ai-fleet-status (v0.3.5 → v0.3.6)

> **Provenance note:** This file was *not* present in the repo (verified: local
> tree, `origin/main` Git tree via `gh api`, and all remote branches — none
> contained `BACKLOG.md`). Per the "generate from existing code/audit" fallback,
> it was synthesized from `AUDIT_REPORT.md`, the live `lib/` import graph, and
> `package.json`. Every task below is anchored to a real file or a real,
> reproduced behavior — **no speculative features were invented.** The one
> genuinely open technical gap (macOS start-time, see A3) is the only
> enhancement-like item and is scoped as documentation + a research spike, not a
> silent feature drop.

## Workflow (per task)

1. `git switch -c task/<id> main`
2. Make the change in its own commit (message: `<area>: <id> — <short summary>`).
3. `npm test` must stay green (currently **144 pass / 0 fail**, 8 suites).
4. `git push -u origin task/<id>` → `gh pr create` → `gh pr merge --squash`.
5. After merge: `git switch main && git fetch && git merge --ff-only origin/main`
   (remove the task branch).
6. **Tagging:** no per-task tags. A single semantic version tag + GitHub release
   is cut at Phase E (`v0.3.6`). Intermediate commits ride on `main`.

## Phase A — Spec & documentation truth (A1–A4)

- **A1** — Author this `BACKLOG.md` and commit to `main`. *(the file you're reading)*
- **A2** — Reconcile version drift. `README.md`, `CHANGELOG.md`, `AUDIT_REPORT.md`
  must all state the current **v0.3.5** baseline and the true test count (**144**,
  not the stale "132" / "116" strings left in older sections). Add a one-line
  "Current version: 0.3.5 (144 tests green)" banner near the top of `README.md`.
- **A3** — Document the one real remaining gap honestly. `CHANGELOG.md` "Known
  limitations" must state: Linux PID-reuse identity was closed via `/proc`
  starttime (v0.3.4, #17); **macOS still has no `/proc` and no creation-time
  source, so identical-parent+argv PID reuse on macOS can still collapse** (a
  documented, bounded limitation — not a silent bug).
- **A4** — Add a "Status" section to `README.md`: stable at 144 tests; scope =
  extension-host machine only; open items = issue #8 (WSL, human NO-GO) and the
  macOS start-time gap (A3).

## Phase B — Legacy dead-code retirement (B1–B5)

> Evidence: `lib/tool-config.js`, `lib/process-chains.js`, `lib/process-list.js`
> carry `DEPRECATED` banners and are imported **only** by `test/unit.test.js`
> (the original 27-test anchor) and `test/audit-afs03-05.test.js`. The live path
> (`extension.js`) imports only `enumerate, detect, sessions, lifecycle, terminal,
> format, sanitize, diagnostics, process-model, json-parse`. `json-parse` and
> `process-model` are LIVE and must be kept.

- **B1** — Port the `json-parse` regression cases out of `test/unit.test.js` into
  a new `test/json-parse.test.js` (control-char recovery, escaped backslashes,
  non-control rethrows). Assert identical coverage.
- **B2** — Port the `process-list` parsing regression cases (basename,
  parseCommLines, parseArgsLines, mergeUnixRows, macOS spaced-path) into
  `test/parse.test.js`, sourcing the live `lib/enumerate.js` `_internal` exports
  (same functions, live code) so the coverage survives deletion of the legacy module.
- **B3** — Delete `test/unit.test.js`, `lib/tool-config.js`, `lib/process-chains.js`,
  `lib/process-list.js`. Confirm `lib/audit-afs03-05.test.js` no longer imports
  the deleted `tool-config` (migrate its legacy `compileTools` reference to the
  live `lib/detect.js` `compileTools`).
- **B4** — Verify `npm test` is green and the suite count is **preserved or
  increased** after deletion (target ≥ 144). This is the acceptance gate for the
  dead-code removal.
- **B5** — Add `test/guard-legacy.test.js`: statically assert that `extension.js`'s
  `require` graph contains **none** of the deleted legacy paths
  (`tool-config`, `process-chains`, `process-list`), so they cannot silently
  reappear.

## Phase C — Robustness hardening of the live path (C1–C6)

- **C1** — `enumerate.js` `listWindowsProcesses`: safely skip a row whose `Name`
  is `null`/`undefined` (PowerShell can return null `Name` for protected
  processes even with `SilentlyContinue`) instead of risking a match or throw.
  Regression: `test/detection.test.js` feeds a null-`Name` Windows row.
- **C2** — `detect.js` `detectOne`/`identify`: a process row with `null` `Name`
  **and** `null` `CommandLine` is skipped (returns `null`), never throws.
  Regression added.
- **C3** — `sessions.js` `buildFleet`: add regression that `buildFleet([])` and
  `buildFleet(undefined)` return an empty fleet (`{toolCount:0,...}`) with no throw.
- **C4** — `terminal.js` `correlate`: guard when `sessionRootPid` is absent from
  `graph.ancestors(...)` — return `undefined`, never throw. Regression added.
- **C5** — `format.js` `summarizeStatusBar`/`summarizeFleet`: assert they never
  return `undefined` for an empty fleet (return a stable "idle" shape). Regression.
- **C6** — `lifecycle.js` `reconcile`: add regression that `reconcile()` with
  `undefined`/`null`/`[]` fleet is a no-op (no throw, `seen` unchanged).

## Phase D — Detection coverage & fuzzing (D1–D5)

- **D1** — Regression: all **13** built-in detectors (Codex, OpenCode, OpenCode 2,
  Hermes, Antigravity, Claude Code, Gemini CLI, Qwen Code, Goose, Kiro CLI, Aider,
  Amp, Crush, Copilot CLI — confirm the real count in `package.json`) classify a
  **bare interactive invocation (no flags)** as a live session, not idle.
- **D2** — Regression: community CLIs (Aider/Amp/Crush/Copilot CLI, added in v0.3.4
  #9) resolve their known node-shim / script paths (e.g. `@aider-cli/...`,
  `amp`, `crush`, `github-copilot-cli`) through `detect` without throwing.
- **D3** — Add `test/detect-fuzz.test.js`: a **deterministic, seeded** generator
  emits 200 randomized command lines (random tokens, quotes, unicode, control
  chars, empty) and asserts `detect()` never throws and always returns a
  well-formed result. Seed fixed for reproducibility.
- **D4** — Extend the adversarial null-input pass: `identify`/`compileTools`/
  `buildFleet` fed **objects with missing fields** (e.g. `{Name:null}`,
  `{CommandLine:undefined}`) — assert no throw, graceful skip. (Hardens the
  AFS-01 area already covered by v0.3.3 #14.)
- **D5** — Add regression: `sanitize.js` `safeProcessLabel`/`redactSecrets` never
  throw on adversarial command lines (binary bytes, embedded NUL/control, 1 MB
  string). Assert graceful redaction/truncation.

## Phase E — Release (E1–E2)

- **E1** — Bump `package.json` `version` → `0.3.6`. Add a `CHANGELOG.md` "0.3.6"
  section summarizing A–D (dead-code removal, robustness, fuzzing, test count
  → 144+). Commit on its own branch/PR.
- **E2** — Tag `v0.3.6`, push the tag, and create the GitHub release
  "v0.3.6 — backlog A–E cleanup & hardening" with the changelog body. Close no
  issues (only #8 remains open, by design).

## Acceptance

- All 22 tasks merged via squash to `main`; 144+ tests green at `v0.3.6`.
- No speculative features; every change traceable to a task id above.
- `issue #8` stays open (human NO-GO); macOS start-time remains a documented gap.
