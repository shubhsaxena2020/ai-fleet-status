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
```

**Note:** The extension includes 15 built-in tools by default (Codex, Claude Code, OpenCode, etc.). rag-service is now the highest-priority added tool.

## Core Flows

### 1. Ingest (Process Enumeration + Detection)

The extension periodically polls your OS processes and identifies AI CLIs:

```javascript
const { compileTools, detect } = require('aiFleetStatus/lib/detect');
const tools = compileTools(); // → 15 built-in tools (includes rag-service)
```

### 2. Query (Tool Detection from Process)

Detect which tool a process belongs to:

```javascript
const { detect } = require('aiFleetStatus/lib/detect');
const process = { pid: 1234, name: 'rag-service', commandLine: 'rag-service serve' };
const detector = detect(process, 'BUILTIN_SPECS');
// → { id: 'rag-service', displayName: 'RAG Service', kind: 'service' }
```

### 3. Job Status (Session Lifecycle)

View your fleet's session state:

```javascript
const { buildFleet } = require('aiFleetStatus/lib/sessions');
const fleet = buildFleet(processes, tools);
// → { tools, sessions, toolCount, sessionCount, processCount }
```

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
```

## rag-Service Detection Behavior

| Command | Result |
|---|---|
| `rag-service serve` | `{ kind: 'service' }` — excluded from session counts |
| `rag-service chat` | `{ kind: 'session', mode: 'interactive' }` |
| `rag-service --help` | `null` — utility exit, not a live session |

## Fleet Summary (Status Bar)

The extension displays compact status bar text:

```
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
