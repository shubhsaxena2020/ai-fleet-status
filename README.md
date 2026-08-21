# AI Fleet Status

A VS Code status bar item that shows which AI coding CLI agents (Codex, Claude Code,
Gemini CLI, Hermes, and others) currently have a live background process running on
your machine — so you can tell at a glance whether a delegated task is still working,
finished, or never started.

```
$(sync~spin) AI: Codex, Hermes        <- 1-2 tools active, named
$(sync~spin) AI: 3 active             <- 3+ tools active, collapsed to a count
$(circle-slash) AI: idle              <- nothing running
$(warning) AI: poll error             <- the last poll failed; click for the reason
```

Click the status bar item for an interactive breakdown (active tools with their PID/
process chain, idle tools, a refresh action, and a shortcut to settings).

## Why

If you delegate work to CLI-based AI agents in the background (`codex exec`, `claude -p`,
etc.), it's easy to lose track of which ones are still running, especially several
minutes into a long task with no visible output. This polls the OS process list every
few seconds and tells you.

## Supported out of the box

Codex, OpenCode, Hermes, Antigravity (`agy`), Claude Code, Gemini CLI, Qwen Code, Goose,
and Kiro CLI — each detected either by its native binary name, or (for npm-shim installs)
by `node`/`node.exe` running a script whose path contains the tool's identity fragment.

**Add your own tool with zero code changes** via the `aiFleetStatus.tools` setting — see
[Configuration](#configuration) below.

## How detection works

- A process counts as a match only through a structural signal: either its own
  OS-reported name IS one of the tool's configured `processNames`, or it's a
  `node`/`node.exe` process whose command line contains one of the tool's
  `nodeIdentityFragments` (for npm-installed CLIs that run via a JS entrypoint).
- The command line must also contain one of the tool's `actionKeywords` as its own
  whitespace/quote-bounded token — not just anywhere as a substring. `--mode=execute`
  does not match an `exec` keyword; `codex.exe exec "prompt"` does, regardless of where
  in the command line the flag appears.
- Shell wrapper processes (`sh`, `bash`) are never scanned for identity or action on
  their own — their command line is arbitrary wrapped text (e.g. a delegation prompt)
  that could coincidentally mention any tool's name. They only appear in a tooltip as
  part of a process chain when they're a real parent of a process that matched on its
  own terms.
- A single logical task that spans multiple processes (e.g. a shell spawning `node`
  spawning the native binary) is shown as one task with its process chain, not as
  multiple separate running tasks.

## Cross-platform

- **Windows**: polls `Win32_Process` via a spawned `powershell.exe`.
- **macOS / Linux**: polls `ps -eo pid=,ppid=,comm=,args=` with unbounded width so long
  command lines aren't truncated.

Both paths normalize to the same `{ProcessId, ParentProcessId, Name, CommandLine}` shape
before anything else in the pipeline runs, so detection logic is platform-agnostic.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `aiFleetStatus.tools` | 9 built-in tools (see `package.json`) | Array of `{ name, processNames, actionKeywords, nodeIdentityFragments }`. Setting this **replaces** the default list — include the defaults you still want alongside your addition. |
| `aiFleetStatus.pollInterval` | `5000` | Poll interval in ms while the window is focused. Unfocused windows poll 3x less often. |
| `aiFleetStatus.hideWhenIdle` | `false` | Hide the status bar item entirely when nothing configured is running. |

Example — adding a hypothetical `foo` CLI to the defaults:

```jsonc
"aiFleetStatus.tools": [
  // ...paste the 9 defaults from package.json here...
  {
    "name": "Foo",
    "processNames": ["foo.exe", "foo"],
    "actionKeywords": ["run"],
    "nodeIdentityFragments": ["foo-cli"]
  }
]
```

`actionKeywords` are matched as regex source (so you can pass an alternation like
`"--print(?:=.*)?"`), not raw literal text — escape regex-special characters if a
keyword needs to match literally.

## Design notes

- Zero npm runtime dependencies, no build step. `extension.js` requires only Node
  built-ins, the `vscode` module VS Code provides, and the plain CommonJS modules in
  `lib/`.
- The `lib/` modules are pure functions with no dependency on the real `vscode` API or a
  live OS process list, so they're unit-tested directly (`npm test`, `node:test` — no
  test framework dependency either).
- No telemetry.

## Development

```
npm test              # run the unit test suite
```

Press F5 in VS Code (with this folder open) to launch an Extension Development Host for
manual testing — `.vscode/launch.json` is already set up for it.

## License

MIT — see [LICENSE](LICENSE).
