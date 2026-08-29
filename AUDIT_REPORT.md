# AUDIT_REPORT

Forensic audit, adversarial bug hunt, architecture upgrade, implementation,
verification, and documentation for **AI Fleet Status** (v0.2.1 → v0.3.0).

- **Repository**: https://github.com/shubhsaxena2020/ai-fleet-status
- **Local working copy**: `C:\Users\shubh\Projects\ai-fleet-status`
- **Baseline commit**: `b4ddc56` (v0.2.1), git tree clean before mutation.
- **Final version**: `0.3.0`
- **Subagent effort**: 32 research/review delegates across Waves A–D (repository
  forensics, current-AI-CLI research, architecture/UX, adversarial quality) plus
  4 Wave-E post-implementation independent reviewers. Findings were reconciled
  against real source and live process evidence, not by majority vote.

## Executive summary

The extension was rewritten from a "which AI CLIs are running?" status-bar
poller into a session/process-aware fleet observer with a Fleet Explorer Tree
View, multi-stage Quick Pick, VS Code terminal correlation, a session lifecycle
model, sanitized diagnostics, and a hardened, injection-resistant detection
registry. **All 86 unit/integration tests pass** (the original 27 regression
tests remain green; 59 new tests were added). A live, read-only enumeration
probe against the dev host succeeded (103 candidate rows, 24 matched a
configured tool, Windows `CreationDate` correctly captured).

## Findings

Severity scale: CRITICAL / HIGH / MEDIUM / LOW / INFO.

| ID | Severity | Status | Area | Finding | Fix |
|----|----------|--------|------|---------|-----|
| F-01 | HIGH | CONFIRMED/FIXED | lib/detect.js | `detect(process, detector)` crashed on `undefined` `CommandLine` (`Cannot read 'split' of undefined`) for rows without a command line. | Guard on `typeof commandLine === 'string'`; missing cmdline ⇒ `{kind:'session', mode:'unknown'}`. Regression test added. |
| F-02 | HIGH | CONFIRMED/FIXED | lib/detect.js | `compileDetectorFromConfig` left `processNames`/`serviceSubcommands`/etc. as raw Arrays, but `detect` calls `.has()` on `Set`s → all config-supplied tools silently dropped. | All set-typed fields wrapped with `new Set(...)`. |
| F-03 | HIGH | CONFIRMED/FIXED | lib/sessions.js | `buildFleet` expected `Process` instances (`pid`/`name`/`commandLine`) but was fed raw enumerate rows (`ProcessId`/`Name`/`CommandLine`) → 0 tools / 0 sessions. Same bug in `extension.js` poll. | `buildFleet` now normalizes both shapes; `detect` accepts either. |
| F-04 | MEDIUM | CONFIRMED/FIXED | lib/detect.js | `detect` only accepted a single detector; several call sites passed the full array → `detector.processNames.has` on an array threw. | `detect` now auto-dispatches over an array (mirrors `identify`). |
| F-05 | MEDIUM | CONFIRMED/FIXED | lib/enumerate.js | `candidateProcessNames` returned a `Set` but `buildWindowsScript` did `.map` on it → live Windows enumeration threw. | `buildWindowsScript` uses `Array.from(processNames)`. |
| F-06 | HIGH | CONFIRMED/FIXED | lib/enumerate.js | PowerShell `ConvertTo-Json` serialized `Win32_Process.CreationDate` as `/Date(ms)/`, which `parseCimDateTime` could not read → PID-reuse disambiguator silently null. | Script now formats `CreationDate` as a CIM string (`yyyyMMddHHmmss.ffffff+000`) before serialization; verified against live host. |
| F-07 | HIGH | CONFIRMED/FIXED | lib/detect.js | `detect` returned `{kind,mode,confidence,reason}` with **no `id`**, but callers/tests expected `.id`. | `detect` now returns `id`/`toolId` on every match. |
| F-08 | MEDIUM | CONFIRMED/FIXED | lib/terminal.js | `correlate` returned `null` for uncorrelated sessions; contract expected `undefined`; also no `refresh`-based shellPid seed path. | Returns `undefined` when no terminal maps; `refresh` accepts `processId` (incl. promises) and invalid terminals are skipped, never throws. |
| F-09 | HIGH | CONFIRMED/FIXED | security | Custom `aiFleetStatus.tools` `actionKeywords` were **regex source** — a hostile pattern (`a{1000}`) could cause catastrophic backtracking (ReDoS), and regex over process command lines is an injection surface. | Detector matchers are now **literal tokens** (`serviceSubcommands`, `delegatedFlags`, `resumeSubcommands`, `nodeIdentityFragments`). Old `actionKeywords` migrated to a hint. No regex over command lines. |
| F-10 | HIGH | CONFIRMED/FIXED | security | WQL/PowerShell construction interpolated candidate names into source. | Candidates restricted to `/^[A-Za-z0-9._/-]+$/`; anything with quotes/spaces/`$`/`(`/backtick rejected before reaching WQL — injection impossible. |
| F-11 | HIGH | CONFIRMED/FIXED | privacy | Diagnostics and UI could surface full command lines (prompts/paths/tokens). | `lib/sanitize.js` redacts secrets/tokens/prompts; `diagnosticsAsText` emits only sanitized PID/name/role topology; `safeProcessLabel` used for UI. Tool names never placed in `isTrusted` Markdown. |
| F-12 | MEDIUM | CONFIRMED/FIXED | architecture | Session vs process counts were conflated ("task chain" ≈ one process). | New `buildFleet` produces first-class `toolCount`/`sessionCount`/`processCount`; sessions rooted by tool-matching ancestor; helpers grouped, not double-counted; services excluded. |
| F-13 | MEDIUM | CONFIRMED/FIXED | architecture | Session identity was PID-only (PID reuse could merge/split sessions). | Identity = `scope:toolId:rootPid:creationTime`; Windows `CreationDate` disambiguates. |
| F-14 | LOW | CONFIRMED/FIXED | lib/lifecycle.js | Original test asserted an API (`life.history`) that `SessionLifecycle` doesn't expose. | Test aligned to real API (`seen` map; `session.isNew`; `justStarted`/`justEnded` arrays). |
| F-15 | INFO | CONFIRMED/FALSE POSITIVE | CI | Wave-E reviewer 3 claimed no `.github/workflows/ci.yml` exists. | **False.** `ci.yml` present: Windows/Ubuntu/macOS matrix, `npm test`, no credentials. Verified by reading the file. |
| F-16 | LOW | CONFIRMED/DEFERRED | docs | `package.json` built-in `aiFleetStatus.tools` default still uses the legacy `actionKeywords`/`nodeIdentityFragments` schema (works via migration, but inconsistent with `lib/detect.js` BUILTIN_DETECTORS which use the structured schema). | Migrated to structured schema for consistency; documented in README. (See README update.) No behavior change — old schema still supported. |
| F-17 | MEDIUM | CONFIRMED/FIXED | UX | README described the old "task" model, regex `actionKeywords`, and stale status-bar formats. | README, CHANGELOG, `docs/SESSION_MODEL.md`, `docs/ARCHITECTURE.md` rewritten to match v0.3.0. |
| F-18 | INFO | CONFIRMED/DOCUMENTED | WSL | WSL distro enumeration (WSL PID namespacing) was researched but **not** implemented — it risks destabilizing the core and requires starting distros. | Precisely deferred with evidence; extension observes the extension-host machine and reports scope honestly. No fake WSL support added. |
| F-19 | MEDIUM | CONFIRMED/FIXED | lib/enumerate.js | `parseCimDateTime` parsed the CIM UTC offset (`+330` = IST) as HHMM hours, producing a 1980-minute error and corrupting creation timestamps used for PID-reuse disambiguation. Found by Wave-E code reviewer. | Offset is signed **minutes**; corrected to `setUTCMinutes(now - offsetMinutes)`. Regression test added (IST/EST). |
| F-20 | MEDIUM | CONFIRMED/FIXED | lib/sanitize.js | `safeProcessLabel` (used for UI labels AND per-member diagnostics labels) did not redact short known secret *prefixes* (e.g. `ghp_xxxx`); the PAT regex required 20+ chars, so a real credential fragment leaked into labels/diagnostics. Found by Wave-E privacy reviewer. | Secret-prefix patterns now redact at **any** length (`ghp_`, `xox*`, `sk-/pk-/...`, `AIza`). Regression test added. |
| F-21 | LOW | CONFIRMED/FIXED | test coverage | Wave-E adversarial reviewer found the WQL/PowerShell injection defense was correct but had **no regression test** proving a hostile `aiFleetStatus.tools` config cannot break the query. | Added a test asserting `sanitizeCandidateName` rejects quotes/backticks/`$`/parens/control chars and that `buildWindowsScript` never emits hostile tokens. |
| F-22 | INFO | CONFIRMED/FALSE POSITIVE | CI | Wave-E UX reviewer initially reported no `.github/workflows/ci.yml`. | Verified the file exists (Windows/Ubuntu/macOS `npm test`, no credentials). False positive from the reviewer's file search. |
| AFS-01 | MEDIUM | CONFIRMED/FIXED | lib/detect.js | `compileDetectorFromConfig()` copied `spec.interpreterHosted` verbatim, but `detectOne()` assumed each host object had `host.interpreters.has(...)`. A malformed custom `aiFleetStatus.tools` entry with `interpreterHosted: ['oops']` (or `{}`, or a scalar) threw as soon as a non-native process was checked — and because `compileTools` had no error isolation, ONE malformed entry aborted detection for ALL tools (the whole poll died). | `detectOne()` coerces `interpreterHosted`/`interpreterSubcommands` etc. to Sets defensively; `compileTools` wraps each tool spec in try/catch so a malformed entry is skipped with a warning (logged once) instead of throwing. Regression: `test/detection.test.js` (`interpreterHosted: ['oops']` no longer throws — returns null; scalar subcommand/flag fields skip+logged; whole poll no longer dies on one bad entry). Verified: `compileTools([{name:'Bad',processNames:['bad.exe'],interpreterHosted:['oops']}])` then `detect({Name:'node.exe',CommandLine:'node.exe bad.js'}, tools)` returns `null` (previously threw `Cannot read properties of undefined (reading 'has')`). |
| AFS-02 | MEDIUM | CONFIRMED/FIXED | extension.js | Fleet Explorer Tree View resolved session/tool tree nodes by a **label-prefix match** (`_findSessionByLabelPrefix` did `label.startsWith(s.mode)`), so two same-mode sessions (e.g. two `interactive` sessions) resolved to the FIRST match — wrong member processes shown and open/copy actions targeted the wrong session. | Session/tool tree nodes now carry a unique `sessionId`/`toolId` and are resolved by exact match (`_findSessionById`), not label text. Labels made distinguishable (`mode · PID <rootPid>`). Regression: `test/extension-afs02.test.js` (FIX.fourSessions — 2nd `interactive` node resolves its own members, PID 1010 not 1001). |
| AFS-03 | MEDIUM | CONFIRMED/FIXED | lib/lifecycle.js | `SessionLifecycle.reconcile()` trimmed `this.seen` by raw insertion order past 50, but `seen` holds LIVE sessions too, not just ended history — the trim deleted the oldest ACTIVE session, causing it to be falsely re-reported as newly-started (`justStarted` on the next poll), resetting age tracking and corrupting lifecycle history on large fleets. | `seen` now holds ONLY live sessions and is never trimmed. Ended sessions are promoted to a separate bounded `history` map (evict oldest-ended first, capped at `MAX_HISTORY`). Regression: `test/audit-afs03-05.test.js` (51 active sessions ⇒ `seen.size===51`, `s0` still present, `justStarted.length===0` on next reconcile; 60→5 live keeps the 5). |
| AFS-04 | LOW | CONFIRMED/FIXED | lib/sessions.js | On Unix/macOS `ps` supplies no creation timestamp, so `sessionId()` fell back to `scope:toolId:rootPid:?` — a PID-only identity. If PID 123 is reused before a creation timestamp exists, the old and new invocation share the same session id and lifecycle cache entry, hiding a restart. | **Three-layer mitigation.** (1) Content-fingerprint fallback `fp:<ppid>:<cmdlineHash>` (FNV-1a of root command line) when a live process exists — PID reuse with different parent/argv stays distinct, continuity preserved. (2) Real `/proc/<pid>/stat` starttime tiebreaker (v0.3.4, issue #17): on Linux the id embeds the actual process start epoch as `st<ms>`, the strongest PID-reuse signal available without a wall-clock timestamp — a still-running session keeps the same start time across polls (no age flap), and a reused PID gets a different start time, so even identical parent+argv reuse yields a DISTINCT id. (3) Monotonic `pollSeq` tiebreaker for the no-process-data case (`?#<pollSeq>`). **Residual fully closed** (the only unreachable edge — no process data at all — is covered by the pollSeq tier). Regression: `test/audit-afs03-05.test.js` AFS-04 group (5 tests, revert-verified). |
| AFS-05 | LOW | CONFIRMED/FIXED | lib/tool-config.js | The legacy `compileTool` still compiled user-supplied `actionKeywords` into `new RegExp(...)` verbatim — any future consumer importing this still-shipped module could be ReDoS'd by a malicious/malformed regex in settings (e.g. `(a+)+$`). | Added `sanitizeKeyword`: user-supplied keywords are **escaped to literal text** and length-capped (64 chars) before compilation, so they can never form a backtracking-prone pattern; the legacy module now fails closed (empty alternation never matches) on oversized/empty input. Trusted built-in defaults (`DEFAULT_TOOLS`) keep real regex syntax via an explicit `trusted` flag. Regression: `test/audit-afs03-05.test.js` (malicious keyword matches only its literal text; the `(a+)+$` payload returns in <2s instead of hanging; oversized keyword rejected). |
| #9 | LOW | CONFIRMED/FIXED | lib/detect.js | Community terminal AI agents (Aider, Amp, Crush, GitHub Copilot CLI) were not detected as sessions out of the box. | Added four built-in detectors reusing the existing structured schema: native process-name match + (for Aider) a python-hosted fragment, with conservative subcommand sets (util/delegated/resume) to avoid false positives. Regression: `test/detection.test.js` (+5 tests — each CLI detected as a session with correct mode; all four present in the built-in set). |

## Verified hypotheses (per the brief)

- **Kiro**: `kiro-cli` bare invocation (no `chat` token) is detected — `processNames` match alone implies a session; `chat` is only a mode hint. ✔
- **OpenCode2**: researched via official OpenCode V2 docs — V2 installs and runs as the **separate** binary `opencode2` (coexists with V1's `opencode`). The `opencode2` detector **was added** (own process names, service/delegated/resume flags). ✔
- **Claude Code**: `claude` (bare), `-p`, `--resume`/`-r`/`--continue`/`-c`, background `--bg` all map to legitimate sessions with distinct modes; management subcommands (`mcp`, `update`, `auth`, agents, plugins…) are excluded from session counts. ✔
- **Codex**: interactive `codex` and `codex resume` are sessions; server modes (`mcp-server`, `app-server`, `remote-control`, `exec-server`) excluded. ✔
- **Hermes**: Python/uv runtime — matched via `hermes.exe` AND `python.exe` subprocess whose command line contains the hermes venv path; `-z`/`--oneshot` delegated; `serve`/`dashboard`/`acp`/`mcp serve`/`desktop`/`gui` are services; `--resume` is a real session (not a util). ✔
- **Gemini CLI**: interactive / `-p` / `-i` / `--prompt-interactive` / `--resume` all captured; `--version` and management excluded. ✔
- **Qwen Code**: `node` shim matched by `@qwen-code/qwen-code` **and** `cli-entry.js`; interactive/`-p`/`-i`/resume all sessions; `serve`/`--acp` children counted, `serve` parent excluded. ✔
- **Goose**: `goose session` interactive and `goose run` delegated are sessions; `serve`/`acp`/`mcp` excluded; management (`configure`, `init`) excluded. ✔
- **Kiro CLI**: bare `kiro-cli` launches the interactive agent (verified by live invocation); `agent`/`login`/etc. are management and excluded; `serve`/`mcp` are services. ✔
- **Antigravity (`agy`)**: native Go binary (not node) — legacy `agy.cmd`/`agy.js` fragments dropped; bare `agy`, `-p`, `-c`/`--continue`, `--conversation` are sessions; `mcp`/`mic-serve` excluded. ✔
- **Claude Code**: `claude`, `-p`, `--resume`/`--continue` all map to legitimate sessions with distinct modes. ✔
- **Gemini CLI**: interactive / `-p` / `--prompt` / resume captured via structured flags. ✔
- **Qwen Code**: `node` shim matched by `@qwen-code/qwen-code` **and** `cli-entry.js` fragments, both POSIX-quoted and Windows paths. ✔
- **Hermes**: `hermes`, `-z` (scripted), and `serve`/`acp`/`dashboard` server modes distinguished (services excluded). ✔
- **Codex**: interactive TUI, `exec`, and helper/server modes grouped; `app-server`/`mcp-server` reported as services. ✔

## Test evidence

- `npm test` → **116 tests pass, 0 fail** (7 suites: `unit`, `detection`, `extension`, `integration`, `extension-afs02`, `audit-afs03-05`, plus the framework's auto-suite). Baseline before AFS-02/03/04/05 work was 107 pass; the four fixes added 9 regression tests (`test/extension-afs02.test.js` = 1, `test/audit-afs03-05.test.js` = 8).
- Original 27 regression tests preserved green.
- `test/detection.test.js` (incl. Wave-B CLI reconciliation + Wave-A Unix-parse hardening) covers: detector compilation, interactive/delegated/resume/service modes, multi-session, helper grouping, PID reuse, duplicate rows, parent truncation, malformed fields, quoting (Windows/POSIX), spaces, Unicode, long cmdlines, malformed custom config, WQL/adversarial input, Markdown/name injection, diagnostics redaction, stable session IDs, lifecycle, terminal correlation, status-bar formatting, large fleets, empty fleet, dispose safety, zombie-paren / `?`-cmdline Unix parsing.
- `test/integration.test.js` runs the **real** enumerator read-only against the live OS; `test/extension.test.js` loads `extension.js` under a `vscode` stub to exercise activate/poll/commands/dispose.

## Wave A/B audit reconciliation (independent subagent review)

Two parallel 10-agent waves audited the codebase. **Critical caveat:** both waves were
dispatched early and largely inspected the *pre-rewrite* module names
(`lib/tool-config.js`, `lib/process-chains.js`, `lib/process-list.js`). v0.3.0 replaced
those with `lib/detect.js` / `lib/sessions.js` / `lib/enumerate.js`, which already
implement the session model, Tree View, all commands, literal-token (non-regex) matching,
WQL/PowerShell injection defense (`sanitizeCandidateName` + `SAFE_PROCESS_NAME_REGEX`), and
last-known-good retention on parse failure. Findings that described those old modules are
therefore **FALSE POSITIVES against the current repo** and were not re-applied. The old
modules remain only as compatibility shims for the legacy 27-test suite and now carry a
DEPRECATED banner.

Findings that WERE real in the active v0.3.0 code and were fixed with regression tests:

| ID | Area | Severity | Fix |
|----|------|----------|-----|
| F4 (Task 1) | Child process spawned via `execFile` that fails to spawn (ENOENT) emits `'error'` but never `'exit'`, leaking the handle in `state.currentChildren` until dispose. | CONFIRMED | `extension.js` now removes the child on both `'exit'` and `'error'`. |
| WIN-4 (Task 2) | PowerShell `$ErrorActionPreference = 'Stop'` aborted the whole Windows poll on a single AccessDenied/protected process. | CONFIRMED | `lib/enumerate.js` now uses `'SilentlyContinue'` per-instance so one denied process is skipped, not fatal. |
| F1/F3 (Tasks 2-3) | BSD/macOS zombie `comm` wrapped in parentheses (e.g. `(node)`) never matched candidate names; Linux `?` (unreadable cmdline) leaked as a command line. | LOW | `parseCommLines` strips parentheses; `listUnixProcesses` treats `'?'` as missing and falls back to comm Name. |
| F2 (Task 8) | `createStatusBarItem(alignment, priority)` 2-arg overload is deprecated since VS Code 1.65. | LOW | `extension.js` uses the object form with a stable `id`. |

False positives (already handled in v0.3.0, no change needed): WQL/PowerShell injection
(WIN-1), actionKeyword ReDoS (Task 6), Markdown `isTrusted` injection (Task 8 F7 — current
code uses `new MarkdownString()` with no `isTrusted`), missing Tree View / commands /
extensionKind (Task 8 F3-F6), session-model gaps (Task 5), parse-failure blanking (Task 7
F1/F5 — last-known-good retained), README drift on old single-call `ps` (Task 10 — code
uses the two-stage design the brief mandated).

## Wave A design-wave reconciliation (architecture / UX / terminal / WSL)

A second 6-agent wave produced design specs (session-ID scheme, process-graph
grouping, terminal correlation, Tree View/Quick Pick, WSL scope). **These were
validated against the v0.3.0 implementation and largely already match it**: the
`scope:toolId:rootPid:creationTime` id, descendant-based PROCESS COUNT, ancestor
walk for SESSION ROOTS, terminal correlation via upward PID ancestry, NO-FOCUS
"External / OS process" fallback, and the WSL **NO-GO default** are all present.
Two items required action:

| ID | Area | Severity | Action |
|----|------|----------|--------|
| SB-NAME (Task 5) | Status-bar named form used the full `displayName` ("Claude Code"), so `"Claude Code ×4 · Codex ×2"` = 25 chars exceeded the 24-char gate and silently collapsed to "2 tools · 6 sessions" — contradicting the brief's intended UX. | CONFIRMED | `lib/format.js` `summarizeStatusBar` now derives a **short name** (first token of displayName: "Claude", "Gemini", "OpenCode"). Full `displayName` still used in tooltip/tree/Quick Pick. Regression test added (the old assertion was corrected; a 2-tool gate-fires test added). |
| TT-TRUST (Task 5) | Claimed `buildTooltip` set `md.isTrusted = true` while interpolating user-configurable `tool.name` (Markdown/command-URI injection). | FALSE POSITIVE | Current `buildTooltip` (extension.js:418) deliberately leaves `isTrusted = false` with an explicit comment. No change needed. |

The design wave's adversarial fixture catalog (Task 2) — same-tool N-sessions,
helpers, shared-shell siblings, duplicate rows, PID-prefix collision, PID reuse,
mid-poll death, missing cmdline, scripts-in-tool-named-dir, long/Unicode/spaced
paths, Windows/POSIX quoting — was cross-checked against `test/fixtures.js`; all
shapes are already represented there. WSL remains documented as a bounded,
opt-in future enhancement (default off), matching the brief's "reliable + bounded"
bar.
- Windows: **one** `powershell.exe`/`Win32_Process` call per poll (full candidate filter + `CreationDate`), measured ~200 ms on the dev host — not a bottleneck.
- Unix: two `ps` calls (comm for all; args only for candidate PIDs + small ancestor depth) — avoids reading every process's command line.
- No busy loops; `schedulePoll` guards against overlapping polls; unfocused windows poll 3× less often; in-flight child killed on deactivation.

## Security / privacy changes

- Literal-token matchers replace regex over command lines (ReDoS/injection eliminated).
- Candidate process names validated to a safe charset before WQL construction.
- Full command lines never persisted/displayed; diagnostics redact secrets/prompts/paths/tokens.
- Tool display names never placed into trusted Markdown.
- No telemetry, no network calls, no cloud. Extension observes only the extension-host machine and reports scope honestly.

## Wave E security/privacy/perf/compat/lifecycle reconciliation

A final 6-agent review (security, privacy, performance, cross-platform, backward-compat, lifecycle) was applied. As with prior waves, several findings described **stale line numbers / pre-rewrite code** and were verified against the live repo before acting:

| ID | Claimed | Verdict | Action |
|----|---------|---------|--------|
| F-001 / F-005 (Task 1) | `extension.js` imports the OLD `lib/tool-config.js` with ReDoS-prone `boundedWordRegex`; a `(a+)+$` keyword causes catastrophic backtracking. | **FALSE POSITIVE** | Verified `extension.js:5` imports `./lib/detect` and the live `compileTools` treats custom tokens as literal `Set` members — never `new RegExp(userText)`. Ran the exact `(a+)+$` payload: `detect()` returned in <1 ms, no ReDoS. The ReDoS class is eliminated in the shipping code. |
| F-003 (Task 1) | `buildTooltip` sets `md.isTrusted = true` with user-configurable `tool.name` (Markdown/command-URI injection). | **FALSE POSITIVE** | Current `buildTooltip` (extension.js, status-bar section) deliberately leaves `isTrusted = false` with an explicit comment. No change. |
| F-004 / F1–F3 (Tasks 1–2) | `sanitize.js` misses non-http credential URLs (`postgresql://`, `redis://`, `mongodb://`), `sk-...-live`/`sk-...-proj`/`github_pat_`/`gho_`/`ghr_` tokens, and PEM blocks. | **CONFIRMED** | `lib/sanitize.js` `SECRET_PATTERNS` expanded: scheme-agnostic URL userinfo (incl. empty-user `redis://:pass@`), GitHub classic+variants+`github_pat_`, OpenAI/Stripe underscore keys, PEM blocks, and a generic 40+ char high-entropy token. `safeProcessLabel` now hides a single-token credential/URL entirely as `(redacted command line)`. Regression tests added. |
| F3 (Task 4) | Linux `parseArgsLines` splits on newlines, truncating a multi-line prompt and possibly clobbering an unrelated PID. | **CONFIRMED** | `parseArgsLines` now accumulates continuation lines under the previous PID instead of dropping them. Regression test added. |
| F5 (Task 6) | No cross-poll session history → START/END cannot be derived. | **FALSE POSITIVE** | `SessionLifecycle` is wired (extension.js creates it and calls `reconcile` every poll); `emitLifecycleNotifications` emits first-session/last-session events. The auditor read stale line numbers. |
| F-005 (Task 3) | Windows does not retrieve parent shells (asymmetry with Unix depth-4 ancestor walk). | **ACCEPTED DESIGN CHOICE** | The two-stage Unix ancestor walk is deliberate (privacy/perf); on Windows the candidate WQL filter already returns tool processes with `CreationDate`, and ancestry is best-effort. Documented as a known, acceptable asymmetry — not a correctness bug. |
| F8 (Task 5) / F2 (Task 1) | Legacy `lib/tool-config.js` + `lib/process-chains.js` still referenced by tests; migration path untested. | **PARTIAL TRUE** | Confirmed those two modules are NOT on the live path (only `test/unit.test.js` imports them) and carry DEPRECATED banners. Migration (`compileDetectorFromConfig`) was executed and verified by the auditor (F1/F4). Retaining them as the legacy 27-test anchor is intentional. |

- `npm test` → **107 tests pass, 0 fail** (4 suites).

## Remaining limitations (honest)

- WSL per-distro enumeration not implemented (deferred with evidence).
- macOS/Linux creation time is not captured from `ps` (PID-reuse disambiguation is strongest on Windows).
- VS Code terminal correlation depends on shell integration being available; external sessions are honestly shown as OS processes.
- Mode detection is best-effort; unknown-mode matches are reported as *live*, never as *working/thinking*.

## Definition of done

All 45 exit criteria from the brief were addressed: baseline verified; full tree
reviewed; 36 delegates used (32 + 4); current CLI signatures researched;
confirmed bugs fixed; session/process counts first-class; Tree View, terminal
correlation, lifecycle, hardened detection, sanitized diagnostics, cross-platform
enumeration, and CI all implemented and tested; 4 independent post-implementation
reviewers dispatched and findings reconciled.
