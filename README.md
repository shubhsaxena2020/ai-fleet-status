# AI Fleet Status

A VS Code status bar item **and Fleet Explorer Tree View** that show which AI
coding CLI agents (Codex, Claude Code, Gemini CLI, Hermes, Qwen Code, and more)
are currently alive on your machine — how many **independent live sessions** each
one has, how many **processes** belong to those sessions, and (when possible)
which **VS Code terminal** owns the session.

```
$(sync~spin) AI: Claude ×4              <- one tool, 4 sessions
$(sync~spin) AI: Claude ×4 · Codex ×2  <- two tools, short enough to name
$(sync~spin) AI: 5 tools · 12 sessions <- large fleet, collapsed to counts
$(circle-slash) AI: idle               <- nothing running
$(warning) AI: poll error              <- the last poll failed; click for the reason
```

Click the status bar item (or open the **Fleet Explorer** in the Activity Bar)
for a drill-down: active tools → their sessions → process chains, plus actions to
reveal the owning terminal, copy a root PID, or copy sanitized diagnostics.

## Why

If you delegate work to CLI-based AI agents in the background (`codex exec`,
`claude -p`, etc.), it's easy to lose track of which ones are still running —
and how many separate sessions you actually have open. This polls the OS process
list and tells you, at a glance and in detail.

## Supported out of the box

Codex, OpenCode **and OpenCode 2 (`opencode2`)**, Hermes, Antigravity (`agy`),
Claude Code, Gemini CLI, Qwen Code, Goose, and Kiro CLI — each detected either
by its native binary name, or (for npm-shim installs) by a `node`/`node.exe`
process whose command line contains the tool's identity fragment (e.g.
`@anthropic-ai/claude-code`, `@qwen-code/qwen-code`, `cli-entry.js`). Hermes is
matched even when it appears as a `python.exe` subprocess of its launcher.

**Server / daemon modes are excluded** (`serve`, `app-server`, `mcp-server`,
`dashboard`, `acp`, `web`, …) so they never inflate your live-session count.
**Management subcommands** (`mcp list`, `update`, `configure`, `login`, …) are
also excluded — only live agent sessions are counted.

**Add your own tool with zero code changes** via the `aiFleetStatus.tools`
setting — see [Configuration](#configuration) below. Optional community CLIs
(Aider, Amp, Crush, GitHub Copilot CLI) are documented as copy-paste example
entries rather than built in, to keep the default lean until verified against a
real local install.

## How detection works

- A process counts as a match only through a **structural** signal: either its
  own OS-reported name IS one of the tool's configured `processNames`, or it's a
  `node`/`node.exe` process whose command line contains one of the tool's
  `nodeIdentityFragments` (for npm-installed CLIs that run via a JS entrypoint).
- A **session** is one independent live invocation. Multiple processes belonging
  to the same logical invocation (a shell → `node` → native binary chain, helper
  children) count as **one session with several processes**, never as several
  sessions.
- **Services** (e.g. `hermes serve`, `codex app-server`, `mcp-server`,
  `dashboard`) are detected and reported **separately** from interactive/
  delegated user sessions, so a daemon never inflates your session count.
- Shell-wrapper processes (`sh`, `bash`, `powershell`) are never treated as
  sessions on their own; they only appear in a process chain as evidence of
  ancestry.
- Session identity is `scope:toolId:rootPid:creationTime` (Windows `CreationDate`
  disambiguates recycled PIDs), not PID alone. On Unix/macOS `ps` gives no
  creation timestamp, so the id embeds a content fingerprint `fp:<ppid>:<cmdlineHash>`
  (parent PID + command-line hash) instead of `?` — PID reuse with different
  parent/argv stays distinct. (If a PID is reused with the SAME parent and an
  identical command line, the two invocations still collapse — a documented
  residual limitation.)

## Status bar and Fleet Explorer

- The status bar is the glanceable layer (compact counts only).
- The **Fleet Explorer** Tree View is the deeper observability layer: each tool
  expands to its sessions (with mode + age), and each session expands to its
  process chain. Click a session to reveal its terminal, copy its root PID, or
  copy sanitized diagnostics.
- External sessions (running outside VS Code — Windows Terminal, WSL, tmux, SSH)
  appear as OS-observed processes and are honestly labeled rather than given a
  fake terminal.

## Cross-platform

- **Windows**: polls `Win32_Process` via one spawned `powershell.exe`, capturing
  `CreationDate` for PID-reuse resistance.
- **macOS / Linux**: two-stage `ps` — `comm` for every process (cheap), then
  `args` only for candidate PIDs and required ancestors (privacy/perf: avoids
  reading every command line on the machine). On Linux, a session's start time
  (and therefore its displayed age) is estimated from `/proc/<pid>/stat`
  `starttime` + `/proc/uptime` (read-only; macOS has no `/proc`, so age is shown
  as unavailable there, same as before).
- Both paths normalize to the same
  `{ProcessId, ParentProcessId, Name, CommandLine, CreationDate}` shape before
  detection logic runs, so detection is platform-agnostic.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `aiFleetStatus.tools` | 10 built-in tools (see `package.json`) | Array of tool descriptors (see schema below). Setting this **replaces** the default list — include the defaults you still want alongside your addition. |
| `aiFleetStatus.pollInterval` | `5000` | Poll interval in ms while the window is focused. Unfocused windows poll 3× less often. |
| `aiFleetStatus.hideWhenIdle` | `false` | Hide the status bar item entirely when nothing configured is running. |
| `aiFleetStatus.enableTerminalCorrelation` | `true` | Map AI sessions to the integrated terminal that spawned them (needs shell integration). External sessions still shown. |
| `aiFleetStatus.enableSessionNotifications` | `false` | OPT-IN non-spammy notification when the fleet gains/loses its first/last session. Off by default. |

Tool descriptor schema:

```jsonc
{
  "name": "Foo",                       // display name (user-configurable; treated as untrusted text)
  "processNames": ["foo.exe", "foo"],  // REQUIRED — native binary image names
  "nodeIdentityFragments": ["foo-cli"],// OPTIONAL — path fragments for npm-shim installs
  "serviceSubcommands": ["serve"],     // OPTIONAL — server/daemon subcommands (reported as SERVICES, not sessions)
  "delegatedFlags": ["-p"],            // OPTIONAL — flags marking non-interactive/delegated mode
  "resumeSubcommands": ["--resume"]    // OPTIONAL — flags marking a resumed session
}
```

`actionKeywords` (the older field) is still accepted and migrated to
`delegatedFlags`; it is a **hint only**, never a gate — a matching process name
already implies a session. All matchers are **literal tokens**, not regular
expressions, so a custom tool cannot cause a regex denial-of-service.

## Privacy

- Full command lines are **never** persisted or shown by default.
- "Copy Diagnostics" strips API keys, bearer tokens, passwords, and prompt text;
  it reports only sanitized PID/name/role topology, counts, timing, and config.
- The extension makes **no network calls** and collects **no telemetry**.

## Design notes

- Zero npm runtime dependencies, no build step. `extension.js` requires only Node
  built-ins, the `vscode` module VS Code provides, and plain CommonJS modules in
  `lib/`.
- The `lib/` modules are pure functions with no dependency on the real `vscode`
  API or a live OS process list, so they're unit-tested directly (`npm test`,
  `node:test` — no test framework dependency either).
- `extensionKind` is `["ui","workspace"]`: the extension observes whatever machine
  the extension host runs on (`vscode.env.remoteName`).

## Development

```
npm test              # run the unit + integration test suite (node:test)
```

Press F5 in VS Code (with this folder open) to launch an Extension Development
Host for manual testing — `.vscode/launch.json` is already set up for it.

## License

MIT — see [LICENSE](LICENSE).
