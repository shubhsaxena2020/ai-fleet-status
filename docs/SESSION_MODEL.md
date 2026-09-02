# Session Model

This document defines, precisely, what AI Fleet Status means by *tool*, *session*,
*process*, and *process chain*, and how each is counted. These definitions are
the contract behind every number shown in the status bar, the Fleet Explorer
Tree View, and the diagnostics output.

## Definitions

### Tool
A **tool** is an AI CLI product the extension knows how to detect (e.g. Claude
Code, Codex, Hermes, Qwen Code). A tool is identified by a detector with:

- one or more **native binary names** (`processNames`) — the executable
  image name reported by the OS, e.g. `claude.exe`, `claude`;
- optionally one or more **interpreter-hosted identities** (`interpreterHosted`)
  — for npm-shim installs, a `node`/`node.exe` process whose command line
  contains a path fragment like `@anthropic-ai/claude-code` or `cli-entry.js`.

A tool is *active* when at least one live process matches its detector and is
not itself a detected **service** (see below).

### Session
A **session** is one independent live invocation of a tool. Multiple processes
belonging to the same logical invocation are part of *one* session, not several.

A session is rooted at the **session root process**: the highest process in the
ancestry that is itself a tool match (native binary or interpreter-hosted tool
script). Every tool-matching process and every descendant of the root that is
not itself the root of a *different* independent session belongs to that one
session.

Helpers (e.g. a `node` child spawned by Claude, a bundler, a `node` wrapper
running a tool's entrypoint) are counted as members of the session, **not** as
new sessions.

### Process count
The **tool process count** is the number of distinct processes (member PIDs)
that belong to a tool's sessions. Parent shells/wrappers that are *not* tool
matches are part of the *chain* but are not counted as tool-owned processes
unless they themselves matched the tool.

### Process chain
The **process chain** of a session is its full ancestor/descendant tree
(including legitimate parent shells like `powershell.exe`/`bash` that spawned
the tool, and helper children). Shell/wrapper processes appear in the chain for
evidence but do not create sessions on their own.

### Service vs session
Some CLIs have daemon/server modes (`serve`, `acp`, `mcp-server`, `dashboard`,
`web`, `app-server`, `gui`). A process whose tool-matching command line contains
a configured **service subcommand** is classified as a **service**, not a user
session. Services are reported separately and never inflate the interactive/
delegated session count.

## Counting algorithm (conceptual)

1. Enumerate OS processes with PID, PPID, name, command line, and (on Windows)
   `CreationDate`.
2. Build a process graph (parent→child).
3. For each process, identify the tool (native name or interpreter fragment).
4. For each tool match that is *not* a service, find its **session root**: the
   process itself if it has no tool-matching ancestor, otherwise the highest
   tool-matching ancestor.
5. Group members under their session root. Two matches with the same root are
   one session with multiple processes.
6. Disambiguate sessions whose root has the same PID by `CreationDate`
   (Windows) so a recycled PID cannot merge or split sessions incorrectly.

## Stable session identity

A session's runtime id is:

```mermaid
<scope>:<toolId>:<rootPid>:<creationTime>
```

- `<scope>` is `local` for the extension-host machine (or a WSL distro scope if
  WSL enumeration is ever enabled).
- `<rootPid>` is the session root PID.
- `<creationTime>` is the OS creation time of the root process when available
  (defeats PID reuse); `?` when the platform does not provide it.

This id is stable across polls for the same logical session, which is what the
lifecycle model (new-session / continuing / ended) keys on.

## Modes (when reliably detectable)

| Mode | Signal (example) | Meaning |
|------|------------------|---------|
| interactive | native binary, no delegated flag | A live interactive chat |
| delegated | `-p`, `--print`, `-z`, `--prompt`, `codex exec` | One-shot / non-interactive |
| resume | `--resume`, `--continue`, `-c`, `-r` | Continued session |
| service | `serve`, `acp`, `mcp-server`, `dashboard`, `web` | Daemon/server (not a session) |
| unknown | process name matched, no command line | Identity known, mode not |

The extension never claims an agent is "thinking", "stuck", or "finished" from
process liveness alone. Unknown-mode matches are reported as *live*, not
*working*.
