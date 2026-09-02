# Architecture

AI Fleet Status is a plain CommonJS VS Code extension with **zero runtime npm
dependencies** and no build step. The pipeline is split into small, pure
modules under `lib/` so each can be unit-tested without the `vscode` API or a
live OS process list.

## Data flow

```mermaid
 OS process list
      │   lib/enumerate.js  (listProcesses)
      │   - Windows: one powershell.exe / Win32_Process call, CreationDate captured
      │   - unix: two-stage ps (comm for all, args only for candidates + ancestors)
      ▼
 normalized rows  { ProcessId, ParentProcessId, Name, CommandLine, CreationDate }
      │   lib/detect.js  (compileTools, detect)
      │   - structured detectors (processNames, interpreterHosted, serviceSubcommands, ...)
      ▼
 ProcessGraph + session grouping   lib/process-model.js + lib/sessions.js (buildFleet)
      │   - identifies tool per process
      │   - roots sessions, dedupes, excludes services, builds process chains
      ▼
 Fleet { tools, sessions, toolCount, sessionCount, processCount }
      │   lib/format.js (summarizeStatusBar / summarizeFleet)
      │   lib/lifecycle.js (SessionLifecycle: new / continuing / ended)
      │   lib/terminal.js (TerminalCorrelator: map session root → VS Code terminal)
      │   lib/diagnostics.js (buildDiagnostics / diagnosticsAsText)
      ▼
 UI: status bar + Fleet Explorer Tree View + Quick Pick  (extension.js)
      ▼
 diagnostics: lib/sanitize.js (redacts secrets/prompts before any output)
```

## Modules

| Module | Responsibility |
|--------|----------------|
| `lib/enumerate.js` | OS enumeration. Hardened WQL/PowerShell construction. Two-stage unix `ps`. Normalizes rows. |
| `lib/detect.js` | Tool registry (`compileTools`), `detect(process, detectorOrDetectors)`. Structured matchers; literal tokens, not regex. |
| `lib/process-model.js` | `Process` + `ProcessGraph` (ancestors/descendants, cycle-safe). |
| `lib/sessions.js` | `buildFleet`: identify, session-root grouping, service exclusion, process counts. |
| `lib/format.js` | Compact status-bar string; fleet summary for tooltip/Tree View. |
| `lib/lifecycle.js` | In-memory session lifecycle across polls (bounded recent history). |
| `lib/terminal.js` | Maps session roots to VS Code integrated terminals via `processId`. |
| `lib/sanitize.js` | Redaction of secrets/prompts/paths; safe process labels. |
| `lib/diagnostics.js` | Builds copy-paste diagnostics with everything sensitive stripped. |
| `extension.js` | Wires polling, status bar, Tree View, Quick Pick, commands, disposal. |

## Key design decisions

### Detection is structural, not regex-driven
Custom `aiFleetStatus.tools` entries use **literal token** matchers
(`processNames`, `serviceSubcommands`, `delegatedFlags`, `resumeSubcommands`,
`nodeIdentityFragments`). The older `actionKeywords` field still works but is
migrated to `delegatedFlags` and treated as a *hint*, never as a gate. This
removes the regex-DoS / regex-injection surface the previous design had.

### Windows enumeration is injection-hardened
Candidate process names are restricted to a safe character set
(`/^[A-Za-z0-9._/-]+$/`). Anything with a quote, space, `$`, `(`, or backtick is
rejected before it can reach a WQL filter or PowerShell string. The WQL filter
is built only from those sanitized literals, so no user input can smuggle
operators or break out of the query.

### Privacy-first
Full command lines are never persisted or shown by default. Diagnostics redact
API keys, bearer tokens, passwords, and prompt text. Tool display names are
treated as untrusted and are never placed into trusted (`isTrusted`) Markdown.

### PID-reuse resistance
On Windows, `CreationDate` disambiguates sessions with identical root PIDs.
Session identity is `scope:toolId:rootPid:creationTime`, not PID alone.

### Remote / WSL scope
The extension observes whatever machine the extension host runs on
(`vscode.env.remoteName`). `extensionKind` is `["ui","workspace"]` so it runs in
the host that actually has the processes. An external (non-VS-Code) session is
shown as an OS process and honestly labeled "External / OS process" rather than
fabricating a terminal it cannot focus.

### Hybrid scheduling
Process polling remains the source of truth. VS Code window-state and terminal
events trigger *timely refreshes* on top of the periodic poll, and unfocused
windows poll 3× less often. An in-flight poll is guarded so refreshes cannot
overlap, and the spawned child process is killed on deactivation.

## Testing

- `npm test` runs `node --test` over `test/`. No framework dependency.
- Pure modules are tested directly with adversarial fixtures (`test/fixtures.js`).
- `test/integration.test.js` runs the *real* enumerator against the live OS
  (read-only) as CI evidence that the platform path works, not just fixtures.
- `test/extension.test.js` loads `extension.js` under a minimal `vscode` stub to
  exercise activation, a poll cycle, commands, and disposal without a real host.
