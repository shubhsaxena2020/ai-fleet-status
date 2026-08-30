# BACKLOG — ai-fleet-status (v0.3.7 → v0.3.8)

> **Provenance:** Synthesized from `AUDIT_REPORT.md`, live `lib/` import graph, `package.json`, and the current test suite (182 pass / 0 fail, 23 suites). Every task below is anchored to a real file or a real, reproduced behavior — **no speculative features invented.** The one genuinely open technical gap (WSL per-distro enumeration, issue #8) remains a documented NO-GO with human decision gate.

## Workflow (per task)

1. `git switch -c task/<id> main`
2. Make the change in its own commit (message: `<area>: <id> — <short summary>`).
3. `npm test` must stay green (currently **182 pass / 0 fail**).
4. `git push -u origin task/<id>` → `gh pr create` → `gh pr merge --squash`.
5. After merge: `git switch main && git fetch && git merge --ff-only origin/main` (remove the task branch).
6. **Tagging:** no per-task tags. A single semantic version tag + GitHub release is cut at Phase E (`v0.3.8`). Intermediate commits ride on `main`.

## Phase A — Built-in detector parity (A1–A3)

> Evidence: v0.3.4 (#9) added four community CLIs (Aider, Amp, Crush, GitHub Copilot CLI) as **test-only** detectors with full `test/detection.test.js` coverage (+5 tests). The README still documents them as copy-paste examples (`aiFleetStatus.tools` user config) rather than built-in defaults. The detectors are implemented, tested, and conservative (native binary + conservative subcommand sets) — promoting them to the default list is a one-line `package.json` change with zero code risk.

- **A1** — Promote the four community CLIs to built-in defaults in `package.json` `aiFleetStatus.tools.default`. Update the README "Supported out of the box" list and detector count (10 → 14). Ensure the `nodeIdentityFragments` for Aider (`@aider-cli/aider` or equivalent) and the native binary names (`aider`, `amp`, `crush`, `copilot`) are correct per their current install methods.
- **A2** — Add a regression test asserting all 14 built-in detectors classify a bare interactive invocation as a live session (extends D1 from the previous backlog to the new count). File: `test/detect-bare-interactive.test.js`.
- **A3** — Update `CHANGELOG.md` "Known limitations" to reflect that community CLIs are now built-in (no longer copy-paste only). Remove the "Optional community CLIs" note from README Configuration.

## Phase B — Robustness hardening (B1–B5)

- **B1** — `enumerate.js` `listWindowsProcesses`: add a regression that a row with `CreationDate` present but unparsable (malformed CIM string) falls back gracefully instead of throwing or producing `null` that corrupts session identity. Feed a live-shaped row with `CreationDate: "garbage"` through the parser.
- **B2** — `detect.js` `identify`: a detector object missing `processNames` (or `processNames: null/undefined/[]`) is skipped with a debug log, never throws. The AFS-01 fix added error isolation for malformed *config* entries; this hardens the *compiled* detector shape. Regression added to `test/detect-adversarial-fields.test.js`.
- **B3** — `sessions.js` `buildFleet`: regression that `buildFleet(rows, null)` and `buildFleet(rows, undefined)` return an empty fleet (`{toolCount:0, sessionCount:0, processCount:0, tools:[], sessions:[], services:[]}`) with no throw. (The adversarial pass in v0.3.3 covered `buildFleet(null, tools)` and `buildFleet(rows, null)` at the top level; this asserts the *detector array* argument is also guarded.)
- **B4** — `terminal.js` `correlate`: regression that `correlate(sessions, {terminals: undefined})` and `correlate(sessions, null)` return `[]` (no correlations) without throwing. The v0.3.3 fix guarded `sessionRootPid` absence; this guards the terminal map argument itself.
- **B5** — `lifecycle.js` `reconcile`: regression that `reconcile(fleet, {terminalCorrelations: undefined})` and `reconcile(fleet, null)` are no-ops (no throw, `seen` unchanged). Extends C6 from the previous backlog to the full options object.

## Phase C — Diagnostics & observability (C1–C3)

- **C1** — `diagnostics.js` `buildDiagnostics`: add a `pollLatencyMs` histogram (p50/p95/p99 over the last 20 polls) to the emitted diagnostics object. This is a pure-data addition — no UI change, just richer "Copy Diagnostics" output for debugging poll performance regressions.
- **C2** — `extension.js` poll loop: wrap the enumeration + detection + fleet build + correlate + reconcile sequence in a `performance.now()` timer and feed the latency to `lifecycle.reconcile(..., {pollLatencyMs})` so the histogram in C1 is populated. Regression: assert the histogram updates on each poll.
- **C3** — `sanitize.js` `redactSecrets`: add a regression that a command line containing **only** a secret token (e.g. `ghp_xxxxxxxxxxxx` with no other args) is fully replaced with `(redacted command line)` rather than leaving an empty string that could confuse downstream consumers. Extends the "single-token credential" logic added in Wave E (F-004).

## Phase D — UX polish (D1–D3)

- **D1** — `format.js` `summarizeStatusBar`: when `toolCount === 1` but `sessionCount > 1`, the current format shows `"ToolName ×N"` (e.g. `"Claude ×4"`). Add a regression that the short name (first token of `displayName`) is used correctly for all 14 built-in tools, including the new community CLIs ("Aider ×2", "Amp ×1", "Crush ×3", "Copilot ×1"). No behavior change — just lock in the short-name derivation for the new tools.
- **D2** — `extension.js` Fleet Explorer tree: the session node label currently shows `"mode · PID <rootPid>"` (e.g. `"interactive · PID 1234"`). Add a regression that the label is stable across polls for the same session (same `sessionId` → same label) and that two sessions of the same mode under the same tool have distinct labels (different root PIDs). This locks in the AFS-02 fix (exact `sessionId` match) at the UI layer.
- **D3** — `extension.js` status bar tooltip: add a regression that the tooltip (Quick Pick drill-down) never throws when a session has `startAgeMs: null` (macOS / unreadable `/proc` / no creation time). The tooltip should show `"age: unknown"` instead of crashing or showing `NaN`.

## Phase E — Release (E1–E2)

- **E1** — Bump `package.json` `version` → `0.3.8`. Add a `CHANGELOG.md` "0.3.8" section summarizing A–D (community CLIs promoted to built-in, robustness hardening, diagnostics latency histogram, UX polish, test count → 182+). Commit on its own branch/PR.
- **E2** — Tag `v0.3.8`, push the tag, and create the GitHub release "v0.3.8 — community CLIs built-in + hardening + diagnostics" with the changelog body. Close no issues (only #8 remains open, by design).

## Acceptance

- All 15 tasks merged via squash to `main`; 182+ tests green at `v0.3.8`.
- No speculative features; every change traceable to a task id above.
- `issue #8` stays open (human NO-GO); macOS fully-degenerate PID-reuse case remains a documented limitation.