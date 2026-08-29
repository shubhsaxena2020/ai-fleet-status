# Changelog

## 0.3.3 (second audit remediation: AFS-01 + AFS-04 hardening + detection-engine robustness)

Second independent audit pass. All five AFS findings were reproduced against the
current `origin/main` with a real run; each is now closed or hardened with a
regression test that FAILS on the old code and PASSES on the fix. Full suite:
**133 tests pass, 0 fail** (was 116 before the first audit pass; the second pass
added 17 regression tests across `detection`, `extension-afs02`, `audit-afs03-05`.

- **Fixed (AFS-01, MEDIUM)**: `detectOne()` assumed `interpreterHosted` entries were
  host objects with `.interpreters.has(...)`. A malformed custom `aiFleetStatus.tools`
  entry (`interpreterHosted: ['oops']`, `{}`, or a scalar) threw, and because
  `compileTools` had no error isolation, ONE bad entry aborted detection for ALL tools
  (the whole poll died). `detectOne()` now coerces the host/set fields to Sets
  defensively, and `compileTools` wraps each spec in try/catch so a malformed entry is
  skipped with a one-time warning. Regression: `test/detection.test.js`
  (`interpreterHosted: ['oops']` → `detect()` returns `null` instead of throwing;
  scalar subcommand/flag fields skip + log; whole poll survives one bad entry).
- **Fixed (AFS-04, LOW) — hardening**: the prior fingerprint fallback
  (`fp:<ppid>:<cmdlineHash>`) already split PID-reuse when a live process exists.
  Added a **monotonic `pollSeq` tiebreaker** for the residual `?` case (no creation
  timestamp AND no process data): distinct polls now yield DISTINCT ids
  (`local:claude:123:?#1` vs `?#2`), so a reused PID no longer collapses two
  invocations into one lifecycle cache entry — the audit's exact "PID reused before a
  creation timestamp exists" scenario. The normal Unix `fp:` path is unchanged, so a
  still-running session keeps the SAME id across polls (continuity preserved). Trade-off
  documented in `AUDIT_REPORT.md` (AFS-04): with no process data at all, a still-running
  session is treated as new each poll — strictly preferable to merging two different
  invocations. Residual (cannot be fully closed without an OS creation timestamp on Unix):
  a PID reused with the same parent + identical command line + no process data still
  collapses. Regression: `test/audit-afs03-05.test.js` (AFS-04 group, 3 tests — pollSeq
  `?#1`/`?#2` distinct; same fingerprint keeps continuity; legacy no-pollSeq call stays `?`).
- **Hardened (adversarial pass)**: `detect(null/undefined)` and `buildFleet([null],
  tools)` / `buildFleet(rows, null)` no longer throw and kill the whole poll — they
  degrade gracefully (skip bad rows / fall back to an empty fleet). `SessionLifecycle.
  reconcile(null/undefined/{})` likewise no longer throws. These are the AFS-01 impact
  class: one malformed input must not abort fleet observation. Regression:
  `test/detection.test.js` (detect/buildFleet null-input tests) and
  `test/audit-afs03-05.test.js` (reconcile null-fleet tolerance test).
- **Docs**: `AUDIT_REPORT.md` now carries an AFS-01 row and an upgraded AFS-04 row;
  this CHANGELOG entry documents the second pass end-to-end with cited test evidence.

## 0.3.2 (cross-platform age + detection hardening)

- **Added**: Unix/Linux session start-time estimation. `ps` gives no wall-clock
  creation time, so every Unix session previously rendered with **no age** in the
  status bar and Fleet Explorer while Windows showed a real one. `listUnixProcesses`
  now derives a start time from `/proc/<pid>/stat` `starttime` + `/proc/uptime`
  (read-only; no process spawn; macOS has no `/proc`, so age stays unavailable
  there as before). This fills in a real display age and does NOT change session
  identity (the AFS-04 content fingerprint still drives PID-reuse disambiguation).
  Regression: `test/unix-age.test.js`.
- **Fixed**: Unix start-time estimate was unstable across polls — it recomputed
  `Date.now() - /proc/uptime` each call, and the coarse uptime granularity let the
  derived boot epoch drift, jittering the start time and risking a session-id flap.
  The boot epoch is now cached for the process lifetime (stable per PID, distinct
  across PIDs). Regression: `test/unix-age-stability.test.js`.
- **Fixed (detection)**: Claude Code's built-in detector could not identify its own
  npm-shim form `node .../@anthropic-ai/claude-code/cli.js` (no `interpreterHosted`
  entry), and Qwen's fragment set included a bare `cli.js` single-segment fragment
  that over-matched any `cli.js` path — together, a Claude shim was mis-classified
  as Qwen, corrupting tool/session counts. Added `interpreterHosted` to the Claude
  Code built-in (path-bounded fragments) and dropped Qwen's bare `cli.js` fragment
  (its real shim is still matched by `@qwen-code/qwen-code`). Regression:
  `test/adversarial-session-count.test.js`.
- **Docs**: corrected README drift — there are **10** built-in detectors (not 9;
  OpenCode 2 was added), documented the Unix session-id fingerprint fallback and the
  Linux age estimation, and aligned the "How detection works" / "Cross-platform"
  sections with the shipping code.

## 0.3.1 (audit remediation: AFS-02 / AFS-03 / AFS-04 / AFS-05)

Independent security/audit remediation pass on the v0.3.0 fleet-observability
release. All findings below were reproduced with a real run, fixed at the root,
and covered by a regression test that FAILS on the old code and PASSES on the
fix. Full suite: **116 tests pass, 0 fail** (was 107 before this pass).

- **Fixed (AFS-02, MEDIUM)**: Fleet Explorer Tree View resolved session/tool tree
  nodes by a **label-prefix match** (`_findSessionByLabelPrefix` used
  `label.startsWith(s.mode)`), so two same-mode sessions (e.g. two `interactive`
  sessions) resolved to the FIRST match — wrong member processes shown and
  open/copy actions targeted the wrong session. Nodes now carry a unique
  `sessionId`/`toolId` and are resolved by exact match; labels are made
  distinguishable (`mode · PID <rootPid>`). Regression:
  `test/extension-afs02.test.js` (FIX.fourSessions — 2nd `interactive` node
  resolves its own members, PID 1010 not 1001).
- **Fixed (AFS-03, MEDIUM)**: `SessionLifecycle.reconcile()` trimmed `this.seen`
  by raw insertion order past 50, but `seen` holds LIVE sessions too, not just
  ended history — the trim deleted the oldest ACTIVE session, causing it to be
  falsely re-reported as newly-started on the next poll (age reset, lifecycle
  history corrupt on large fleets). `seen` now holds ONLY live sessions and is
  never trimmed; ended sessions are promoted to a separate bounded `history` map
  (evict oldest-ended first, capped at `MAX_HISTORY`). Regression:
  `test/audit-afs03-05.test.js` (51 active sessions ⇒ `seen.size===51`, `s0`
  still present, `justStarted.length===0` on next reconcile; 60→5 live keeps the 5).
- **Fixed + documented (AFS-04, LOW)**: on Unix/macOS `ps` supplies no creation
  timestamp, so `sessionId()` fell back to `scope:toolId:rootPid:?` — a PID-only
  identity that collapses two invocations reusing a PID. Added a content
  fingerprint fallback: when `creationTime` is null the id embeds
  `fp:<ppid>:<cmdlineHash>` (FNV-1a of the root command line) instead of `?`, so
  PID reuse with a different parent/argv stays distinct. **Residual limitation
  (documented, cannot be fully closed without an OS creation timestamp on Unix):**
  a PID reused with the *same* parent AND an identical command line still
  collapses. Regression: `test/audit-afs03-05.test.js` (`sessionId` distinct for
  different fingerprints; `buildFleet` keeps two PID-123 invocations distinct
  across polls; identical parent+argv reusing a PID collides as expected).
- **Fixed (AFS-05, LOW)**: the legacy `lib/tool-config.js` `compileTool` still
  compiled user-supplied `actionKeywords` into `new RegExp(...)` verbatim — any
  future consumer importing this still-shipped module could be ReDoS'd by a
  malicious/malformed regex in settings (e.g. `(a+)+$`). Added `sanitizeKeyword`:
  user-supplied keywords are **escaped to literal text** and length-capped (64
  chars) before compilation, so they can never form a backtracking-prone pattern;
  the module now fails closed (empty alternation never matches) on oversized/empty
  input. Trusted built-in defaults (`DEFAULT_TOOLS`) keep real regex syntax via an
  explicit `trusted` flag. Regression: `test/audit-afs03-05.test.js` (malicious
  keyword matches only its literal text; the `(a+)+$` payload returns in <2s
  instead of hanging; oversized keyword rejected).

## 0.3.0

A substantial modernization of AI Fleet Status from a "which AI CLIs are
running?" status-bar poller into a session/process-aware fleet observer.
Backward-compatible with the v0.2.x `aiFleetStatus.tools` setting (the older
`actionKeywords` field is migrated to a mode hint).

- **Added (core model)**: first-class **session count** and **process count**
  distinct from tool count. A session is one independent live invocation; helper
  processes are grouped under their session root and never double-counted
  (lib/sessions.js `buildFleet`).
- **Added (services)**: daemon/server subcommands (`serve`, `acp`, `mcp-server`,
  `dashboard`, `web`, `app-server`) are classified as SERVICES and excluded from
  the session count.
- **Added (Fleet Explorer)**: a native VS Code Tree View (Activity Bar container)
  showing tools → sessions (mode + age) → process chains, with actions to reveal
  the owning terminal, copy a root PID, or copy sanitized diagnostics.
- **Added (Quick Pick)**: multi-stage drill-down (fleet → tool → session →
  detail) replacing the shallow one-row-per-tool picker.
- **Added (terminal correlation)**: sessions are mapped to the integrated VS Code
  terminal that spawned them via `Terminal.processId` + process ancestry;
  external sessions are honestly shown as OS processes
  (lib/terminal.js). Gated by `enableTerminalCorrelation` (default on).
- **Added (lifecycle)**: in-memory session lifecycle across polls
  (new / continuing / ended) with bounded recent history; optional opt-in
  notifications when the fleet gains/loses its first/last session
  (lib/lifecycle.js, `enableSessionNotifications` default off).
- **Added (diagnostics)**: "Copy Sanitized Diagnostics" emitting extension
  version, platform, scope, config, counts, sanitized PID/process topology, poll
  latency, and last error — with secrets/prompts/paths/tokens redacted
  (lib/diagnostics.js, lib/sanitize.js).
- **Security**: detection matchers are now **literal tokens**, not regular
  expressions — eliminates the regex-DoS / regex-injection surface the old
  `actionKeywords`-as-regex design had. Candidate process names are validated to
  a safe character set before WQL/PowerShell construction, so custom tool config
  cannot inject into the query. Tool display names are never placed into trusted
  Markdown.
- **Windows**: now captures `Win32_Process.CreationDate` and uses
  `scope:toolId:rootPid:creationDate` as stable session identity, so a recycled
  PID cannot merge or split sessions. (Fixed a real bug where PowerShell's
  `ConvertTo-Json` serialized `CreationDate` as `/Date(ms)/` and the value was
  silently dropped.)
- **Privacy**: full command lines are never persisted or displayed by default;
  diagnostics redact secrets/prompts; no telemetry, no network calls.
- **Performance**: Windows uses a single `powershell.exe`/`Win32_Process` call
  per poll; macOS/Linux uses a two-stage `ps` (comm for all, args only for
  candidate PIDs + ancestors) to avoid reading every process's command line.
- **Verified CLIs (10 built-in detectors)**: Codex, OpenCode (`opencode`) **and
  OpenCode 2 (`opencode2` — a separate binary per the official V2 docs, no longer
  the same as V1)**, Hermes (including its `python.exe` subprocess identity),
  Antigravity `agy`, Claude Code, Gemini CLI, Qwen Code, Goose, and Kiro CLI
  (bare `kiro-cli` correctly detected without a `chat` token). Each tool's
  full mode set (interactive / delegated `-p` / `-i` prompt-interactive /
  resume / continue / background) is mapped, and management subcommands (`mcp`,
  `update`, `configure`, `login`, …) plus server/daemon modes are excluded so
  they never inflate the live-session count.
- **Testing**: 107 tests pass (the original 27 regression tests remain green; 80
  new tests added, including Wave-B CLI-research reconciliation, Wave-A
  enumeration-parse hardening, and Wave-E security/privacy/perf/compat/lifecycle
  reconciliation). `test/integration.test.js` runs the real enumerator
  read-only against the live OS; `test/extension.test.js` loads `extension.js` under a
  `vscode` stub. CI runs `npm test` on Windows/Ubuntu/macOS with no credentials.
- **Privacy hardening (Wave E)**: the diagnostics redactor now covers
  non-http credential URLs (`postgresql://`, `redis://`, `mongodb://`, `ftp://`, …),
  OpenAI/Stripe underscore-delimited keys (`sk-...-live`, `sk-...-proj`), GitHub fine-grained and
  variant PATs (`github_pat_`, `gho_`/`ghu_`/`ghs_`/`ghr_`), PEM private-key blocks,
  and generic high-entropy tokens. A single-token credential/URL is now hidden
  entirely as `(redacted command line)`. Linux `ps` now reassembles embedded
  newlines in command lines instead of truncating them.
- **Docs**: README, CHANGELOG, `docs/SESSION_MODEL.md`, `docs/ARCHITECTURE.md`,
  and `AUDIT_REPORT.md` rewritten to match.

## 0.2.1

A second independent review pass (after 0.2.0 was already public) found real bugs the
first pass missed — mainly the macOS/Linux cross-platform path, which had never
actually run on a Unix machine:

- **Fixed (critical)**: on macOS, BSD `ps`'s `comm` field reports the full executable
  *path*, not a basename (unlike Linux). Combined with matching logic written assuming
  bare names like `node`/`claude`, this meant every tool would have been silently
  reported as idle 100% of the time on macOS. Paths are now reduced to a basename
  before classification.
- **Fixed (major)**: the single-`ps`-call parser split columns on whitespace, so a
  `comm` value containing a space (routine on macOS — e.g. an app bundle path like
  `/Applications/Visual Studio Code.app/...`) would corrupt both the process name and
  command line. Replaced with two separate `ps` calls (one for `pid,ppid,comm`, one for
  `pid,args`) merged by PID, so a space inside either field is no longer ambiguous.
- **Fixed (major)**: `boundedPathRegex` fragments authored with a forward slash (e.g.
  `bundle/gemini.js`) never matched a real Windows command line, which always uses a
  backslash for that path segment — silently breaking Node-shim detection for Gemini
  CLI (and Claude Code's fallback fragment) on Windows. Fragments now match either
  slash direction.
- **Fixed (minor)**: `buildChains` didn't deduplicate two chains of *equal* length with
  identical PIDs (e.g. a duplicate row from the underlying process listing) — only
  strict-prefix duplicates were caught. Added an exact-signature dedup pass.
- **Fixed (minor)**: `onDidChangeWindowState` triggered an immediate poll on *every*
  focus change, including losing focus — spawning a real OS process on every window
  blur and defeating the point of the unfocused back-off. Now only polls immediately
  on focus gain.
- **Fixed (minor)**: Claude Code's `--print` and Gemini CLI's `--prompt` keywords didn't
  match the attached `--flag=value` form (only space-separated). Extended to match
  both, consistent with how Antigravity's `--print` was already handled.

Found by an independent second-pass review of the actual merged 0.2.0 code (not the
pre-refactor file reviewed in the first pass), adversarially re-verified against the
real source before any fix was applied.

## 0.2.0

- **Fixed**: the installed copy of the extension had drifted out of sync with source
  and was missing a control-character JSON parsing fix, causing a real
  `Bad control character in string literal in JSON` poll failure. Source and installed
  copy are now identical.
- **Added**: user-configurable tool detection via the `aiFleetStatus.tools` setting —
  add any AI CLI without editing code.
- **Added**: cross-platform support (macOS/Linux via `ps`, in addition to the existing
  Windows PowerShell path).
- **Added**: 5 more tools detected by default (Claude Code, Gemini CLI, Qwen Code,
  Goose, Kiro CLI), on top of the original 4 (Codex, OpenCode, Hermes, Antigravity).
- **Added**: `aiFleetStatus.pollInterval` and `aiFleetStatus.hideWhenIdle` settings.
- **Added**: adaptive polling — polls 3x less often while the window is unfocused.
- **Added**: interactive Quick Pick on click (active/idle tools, refresh, open
  settings) instead of a plain information-message dump.
- **Added**: status bar text now collapses to a count ("3 active") instead of an
  unbounded comma list once 3+ tools are active.
- **Added**: a diagnostics output channel ("AI Fleet Status") logging each poll cycle.
- **Added**: unit test suite (`npm test`, `node:test`, zero added dependencies).
- **Fixed**: process-chain deduplication used a string-prefix comparison
  (`"12,345,6".startsWith("12,34")`) that could wrongly drop a legitimate,
  independent process chain sharing a numeric PID prefix with another chain. Now
  compared as arrays of PIDs.
- **Fixed**: an in-flight process-listing call is now killed on extension
  deactivation, instead of its callback firing later against a disposed status bar
  item.
- **Fixed**: the PowerShell-side control-character scrub now covers the process
  `Name` field too, not just `CommandLine`.

## 0.1.0

Initial version: Windows-only, 4 hardcoded tools (Codex, OpenCode, Hermes,
Antigravity), single-file implementation.
