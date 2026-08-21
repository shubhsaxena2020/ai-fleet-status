Build a minimal, self-contained VS Code extension (plain JavaScript, no build step, no external npm runtime dependencies) at this exact location: C:\Users\shubh\Projects\ai-fleet-status

GOAL: A status bar item, always visible, that shows which of 4 AI CLI tools currently have a live background process running on this Windows machine: Codex, OpenCode, Hermes, Antigravity.

FILES TO CREATE:

1. package.json — VS Code extension manifest:
   - name: "ai-fleet-status", publisher: "local", version "0.1.0"
   - engines.vscode: "^1.85.0"
   - main: "./extension.js"
   - activationEvents: ["onStartupFinished"]
   - no "contributes" needed beyond what's created in code
   - no dependencies field needed (use only Node built-ins + the `vscode` module provided by the host)

2. extension.js — the extension logic:
   - On activate(context): create a StatusBarItem (right side, priority 100), show it immediately with text "$(circle-slash) AI: idle", and start a setInterval poll every 5000ms. Push the item + interval disposal into context.subscriptions.
   - Poll function: run this PowerShell command via child_process.exec (with a 4-second timeout), Windows only:
     powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
   - Parse stdout as JSON (it may be a single object if only one process exists — handle both array and single-object cases). Guard every step in try/catch; on any error, just leave the status bar item unchanged rather than crashing.
   - For each process entry, check its CommandLine field (may be null — skip those) against these 4 case-insensitive regex patterns, one per tool:
     - Codex: /codex(\.exe)?\s+exec\b/i
     - OpenCode: /opencode(\.cmd|\.exe)?\s+run\b/i
     - Hermes: /hermes(\.exe)?\s+-z\b/i
     - Antigravity: /\bagy(\.exe)?\s+(-p\b|--print\b)/i
   - Build a list of which tools matched (dedupe by tool, but track PIDs of matching processes per tool).
   - Update the status bar item:
     - If none matched: text = "$(circle-slash) AI: idle", tooltip = "No delegated AI CLI tasks currently running"
     - If some matched: text = "$(sync~spin) AI: " + comma-joined list of matched tool names (e.g. "AI: Codex, Hermes"), tooltip = a multi-line string listing each matched tool with its PID(s), plus the non-matched tools shown as idle. Include a "Last checked: <ISO timestamp>" line at the bottom of the tooltip.
   - Register a command "aiFleetStatus.showDetails" bound to clicking the status bar item, that shows the same detail as an information message (vscode.window.showInformationMessage) when clicked — reuse the last poll result, don't re-poll on click.

3. README.md — 10-15 lines: what this does, that it's Windows-only, how it detects each tool (the 4 regex patterns in plain English), and that it has no telemetry and isn't published to the marketplace (local-only).

CONSTRAINTS:
- Do not add a build step, bundler, linter config, test framework, or any npm dependency — this must run directly as plain CommonJS JavaScript with zero `npm install` required, since VS Code loads `main` directly.
- Do not touch any files outside C:\Users\shubh\Projects\ai-fleet-status.
- Do not attempt to install or reload the extension yourself — just write the files. I will install and test it myself afterward.
- Keep the whole thing under ~150 lines of actual code (excluding README/package.json). No speculative configuration options, no settings.json contributions, no multi-tool abstraction layer beyond a plain inline array of {name, pattern} objects if that's simpler than 4 hardcoded checks.

When done, print a short summary of the files you created.
