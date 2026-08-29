# Changelog

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
