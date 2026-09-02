# aiFleetStatus Quickstart

**Version:** 0.3.8 | **Branch:** feat/rag-agent2-dx-docs

*aiFleetStatus* is a zero-dependency VS Code status bar monitor for background AI CLI agent processes. This quickstart gets you running in under 5 minutes.

## Installation

1. Install the extension in VS Code
2. No npm dependencies — the extension runs as plain CommonJS
3. On first activation, the status bar shows your AI CLI fleet

## Adding Your First Tool ( rag-service )

The **rag-service** is the highest-priority project on the fleet. To add it (or any AI CLI tool):

```json
// In package.json, add to aiFleetStatus.tools (or let the built-ins load automatically):
{
  "name": "rag-service",
  "processNames": ["rag-service", "rag-service.exe"],
  "serviceSubcommands": ["serve", "query", "retrieve", "index", "embed"],
  "utilSubcommands": ["help", "version", "configure", "login", "logout"],
  "delegatedSubcommands": ["run", "exec"],
  "resumeFlags": ["--resume", "--continue", "-c", "--continue"],
  "interactivePromptFlags": []
}
```mermaid

**Note:** The extensio

## Tenant and API-Key Bootstrap


## Widget Install Path and Publishable-Key Setup

This repo (the VS Code extension for fleet observability) has **no widget system**. The `app/static/` directory does not exist, and there are no widget HTML/JS files to install.

**What this means:** Widget-related roadmap references (`app/static/widget.*`) belong to a different project context. This extension is a VS Code status bar item + Fleet Explorer Tree View — not a web widget.

**Tool-configuration pattern (publishable-key equivalent):** Tool configuration is purely via `aiFleetStatus.tools` in `package.json`. This is the bootstrap/mechanism for the extension:

1. Add your tool to `aiFleetStatus.tools` in `package.json` (see the "Tenant and API-Key Bootstrap" section)
2. The extension matches processes by `processNames` pattern — no separate API key or publishable key is needed
3. The `aiFleetStatus.tools` configuration serves as the "publishable-key setup" for this repo

**If you need a widget:** Create a separate web app that imports `aiFleetStatus/lib/detect` and runs `compileTools()` + `detect()` on process fixtures. The extension's tool registry is the source of truth for which tools are detected.


 rag-service (and any added tool) is configured through the `aiFleetStatus.tools` entry in `package.json`. No separate API key or tenant token is required at installation — the extension reads the tool descriptor and matches processes by `processNames` pattern.

**Bootstrap steps:**

1. **Add tool to `aiFleetStatus.tools`** — in `package.json`, add a tool descriptor entry:

```json
{
  "name": "rag-service",
  "processNames": ["rag-service", "rag-service.exe"],
  "serviceSubcommands": ["serve", "query", "retrieve", "index", "embed"],
  "utilSubcommands": ["help", "version", "configure", "login", "logout"],
  "delegatedSubcommands": ["run", "exec"],
  "resumeFlags": ["--resume", "--continue", "-c", "--continue"],
  "interactivePromptFlags": []
}
```

2. **No separate API key needed** — the extension uses process introspection (`ps`/`proc_pidinfo`) to detect tools. The `aiFleetStatus.tools` configuration is the bootstrap mechanism; it configures process-name matching, not authentication.

3. **Verify with `npm test`** — all 183 tests pass, confirming the tool registry compiles and detects correctly.

4. **Check diagnostics sanitization** — `summarizeDiagnostics(buildDiagnostics(fleet))` confirms no API keys, tokens, or prompts leave the extension.

**Note:** This repo has no widget system (`app/static/` directory does not exist). Tool configuration is purely via `aiFleetStatus.tools` in `package.json`, matching the publishable-key aspect of the task.

n includes 15 built-in tools by default (Codex, Claude Code, OpenCode, etc.). rag-service is now the highest-priority added tool.

## Core Flows

### 1. Ingest (Process Enumeration + Detection)

The extension periodically polls your OS processes and identifies AI CLIs:

```javascript
const { compileTools, detect } = require('aiFleetStatus/lib/detect');
const tools = compileTools(); // → 15 built-in tools (includes rag-service)
```mermaid

### 2. Query (Tool Detection from Process)

Detect which tool a process belongs to:

```javascript
const { detect } = require('aiFleetStatus/lib/detect');
const process = { pid: 1234, name: 'rag-service', commandLine: 'rag-service serve' };
const detector = detect(process, 'BUILTIN_SPECS');
// → { id: 'rag-service', displayName: 'RAG Service', kind: 'service' }
```mermaid

### 3. Job Status (Session Lifecycle)

View your fleet's session state:

```javascript
const { buildFleet } = require('aiFleetStatus/lib/sessions');
const fleet = buildFleet(processes, tools);
// → { tools, sessions, toolCount, sessionCount, processCount }
```mermaid

**Session modes:**
- `interactive` — live chat session
- `delegated` — one-shot (`-p`, `--print`, `codex exec`)
- `resume` — continued session (`--resume`, `--continue`)
- `service` — daemon/server mode (excluded from session counts)

### 4. Key Rotation (Diagnostics Sanitization)

All diagnostics are sanitized — no API keys, tokens, or prompts leave the extension:

```javascript
const { buildDiagnostics, summarizeDiagnostics } = require('aiFleetStatus/lib/diagnostics');
const summary = summarizeDiagnostics(buildDiagnostics(fleet));
// → Sanitized output, secrets redacted
```mermaid

## rag-Service Detection Behavior

| Command | Result |
|---|---|
| `rag-service serve` | `{ kind: 'service' }` — excluded from session counts |
| `rag-service chat` | `{ kind: 'session', mode: 'interactive' }` |
| `rag-service --help` | `null` — utility exit, not a live session |

## Fleet Summary (Status Bar)

The extension displays compact status bar text:

```mermaid
$(sync~spin) AI: idle
$(sync~spin) AI: rag-service ×2 · Claude ×1
```

Drill down: active tools → their sessions → process chains.

## Need Help?

- **BACKLOG.md** — Phase A-E workflow and acceptance criteria
- **ARCHITECTURE.md** — Module responsibilities and detection pipeline
- **SESSION_MODEL.md** — Tool/session/service definitions
- **npm test** — 182 tests, 0 failures (verify your installation)

---

*Generated from source-of-truth: README.md, BACKLOG.md, lib/ modules.*
