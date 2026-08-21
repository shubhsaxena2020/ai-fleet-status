# Changelog

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
