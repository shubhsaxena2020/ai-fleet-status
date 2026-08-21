# Changelog

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
