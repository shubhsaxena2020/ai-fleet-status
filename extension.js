'use strict';

const vscode = require('vscode');
const { listProcesses } = require('./lib/enumerate');
const { compileTools, detect } = require('./lib/detect');
const { buildFleet } = require('./lib/sessions');
const { SessionLifecycle } = require('./lib/lifecycle');
const { TerminalCorrelator } = require('./lib/terminal');
const { summarizeStatusBar, summarizeFleet } = require('./lib/format');
const { safeProcessLabel } = require('./lib/sanitize');
const { buildDiagnostics, diagnosticsAsText } = require('./lib/diagnostics');

const CONFIG_SECTION = 'aiFleetStatus';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const UNFOCUSED_POLL_MULTIPLIER = 3;
const MAX_SHORT_LABEL_LENGTH = 24;
const TREE_VIEW_ID = 'aiFleetStatus.fleetExplorer';

class FleetTreeDataProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.fleet = null;
  }

  refresh(fleet) {
    this.fleet = fleet;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!this.fleet) {
      return [];
    }
    if (!element) {
      // Top level: one node per tool (active first), then idle tools.
      const nodes = [];
      const active = [];
      const idle = [];
      for (const [id, tool] of this.fleet.tools) {
        if (tool.sessions.length > 0) {
          active.push(tool);
        } else {
          idle.push(tool);
        }
      }
      active.sort((a, b) => b.sessions.length - a.sessions.length);
      for (const tool of active) {
        const procTotal = tool.sessions.reduce((acc, s) => acc + s.processCount, 0);
        const node = new vscode.TreeItem(
          `${tool.displayName}`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        node.description = `${tool.sessions.length} session${tool.sessions.length === 1 ? '' : 's'} · ${procTotal} processes`;
        node.iconPath = new vscode.ThemeIcon('sync~spin');
        node.contextValue = 'aiFleetTool';
        node.tooltip = `${tool.displayName}: ${tool.sessions.length} session(s), ${procTotal} process(es)`;
        // Carry the UNIQUE, STABLE tool id so child resolution is unambiguous
        // (AFS-02 family). Two configured tools can share a displayName (e.g. two
        // "Claude" entries); resolving children by label would make the SECOND node
        // expand the FIRST tool's sessions. Resolve by id, never by label.
        node.toolId = tool.id;
        nodes.push(node);
      }
      for (const tool of idle) {
        const node = new vscode.TreeItem(
          `${tool.displayName}`,
          vscode.TreeItemCollapsibleState.None
        );
        node.description = 'idle';
        node.iconPath = new vscode.ThemeIcon('circle-slash');
        node.contextValue = 'aiFleetToolIdle';
        node.toolId = tool.id;
        nodes.push(node);
      }
      return nodes;
    }

    // Under a tool node: show its sessions. Resolve by the carried stable toolId
    // (AFS-02 family): two tools may share a displayName, so matching by label
    // would collapse both nodes onto the first tool.
    const tool = this._findToolById(element);
    if (tool && tool.sessions.length > 0) {
      return tool.sessions.map((s) => {
        const node = new vscode.TreeItem(
          // Label MUST be distinguishable per session, not just the mode. Two
          // sessions with the same mode (e.g. two interactive claude sessions)
          // would otherwise render with identical labels (AFS-02: "labeled only
          // by mode ... indistinguishable"). Append the stable root PID.
          `${s.mode}${s.isNew ? ' (new)' : ''} · PID ${s.rootPid}`,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        const age = s.startAgeMs != null ? `${Math.max(0, Math.round(s.startAgeMs / 1000))}s` : '';
        node.description = `root PID ${s.rootPid} · ${s.processCount} proc · ${age}`;
        node.iconPath = new vscode.ThemeIcon('chevron-right');
        node.contextValue = 'aiFleetSession';
        node.tooltip = `${s.displayName} · ${s.mode} · confidence ${s.confidence}`;
        // Carry the UNIQUE, STABLE session id on the node so member resolution is
        // unambiguous (AFS-02). Two sessions sharing a mode label must NOT resolve
        // to the first match via a prefix check on the mode string.
        node.sessionId = s.id;
        node.command = {
          command: 'aiFleetStatus.openSession',
          title: 'Open session',
          arguments: [s.id]
        };
        return node;
      });
    }

    // Under a session node: show its member processes (SANITIZED labels only).
    // Resolve by the carried stable session id, NOT by a label/mode prefix — the
    // old `_findSessionByLabelPrefix` returned the FIRST session whose mode was a
    // prefix of the label, so two same-mode sessions collided.
    const session = this._findSessionById(element);
    if (session) {
      return session.members.map((m) => {
        const node = new vscode.TreeItem(`${m.name || 'process'}`);
        node.description = `PID ${m.pid} · ${safeProcessLabel(m.commandLine)}`;
        node.iconPath = new vscode.ThemeIcon('circle-outline');
        node.contextValue = 'aiFleetProcess';
        node.tooltip = `PID ${m.pid} (sanitized command line)`;
        return node;
      });
    }

    return [];
  }

  _findToolById(element) {
    const id = element && element.toolId;
    if (id != null) {
      return this.fleet.tools.get(id) || null;
    }
    // Back-compat: if a node somehow lacks toolId (older code path), fall back to
    // an exact displayName match. First-match-by-label is acceptable ONLY as a
    // fallback and is NOT used for the normal (id-carrying) node path.
    const label = element && element.label;
    if (label != null) {
      for (const tool of this.fleet.tools.values()) {
        if (tool.displayName === label) {
          return tool;
        }
      }
    }
    return null;
  }

  _findSessionById(element) {
    const id = element && element.sessionId;
    if (id != null) {
      for (const s of this.fleet.sessions) {
        if (s.id === id) {
          return s;
        }
      }
    }
    return null;
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('AI Fleet Status');
  const statusItem = vscode.window.createStatusBarItem({ alignment: vscode.StatusBarAlignment.Right, id: 'aiFleetStatus.statusBar', priority: 100 });
  statusItem.command = 'aiFleetStatus.showDetails';

  const treeProvider = new FleetTreeDataProvider();
  const treeView = vscode.window.createTreeView(TREE_VIEW_ID, { treeDataProvider: treeProvider });

  const lifecycle = new SessionLifecycle();
  const correlator = new TerminalCorrelator();

  const state = {
    tools: compileConfiguredTools(output),
    lastResult: { fleet: null, checkedAt: null, error: null, lifecycle: null },
    pollInFlight: false,
    pollTimer: null,
    currentChildren: new Set(),
    disposed: false,
    pollLatencyMs: null,
    scope: detectScope(),
    // Real runtime objects the poll/refresh closures need.
    _statusItem: statusItem,
    _output: output,
    _treeProvider: treeProvider,
    _correlator: correlator,
    _treeView: treeView
  };

  refreshStatusBar(statusItem, state);
  treeProvider.refresh(emptyFleet(state.tools));

  // Initial correlation of currently-open terminals.
  correlator.refresh(vscode.window.terminals).catch(() => {});

  context.subscriptions.push(
    statusItem,
    output,
    treeView,
    vscode.commands.registerCommand('aiFleetStatus.showDetails', () => showDetails(state)),
    vscode.commands.registerCommand('aiFleetStatus.refresh', () => schedulePoll(state, 0)),
    vscode.commands.registerCommand('aiFleetStatus.openFleetExplorer', () => {
      vscode.commands.executeCommand('workbench.view.extension.aiFleetStatus');
    }),
    vscode.commands.registerCommand('aiFleetStatus.copyDiagnostics', () => copyDiagnostics(state, output)),
    vscode.commands.registerCommand('aiFleetStatus.openSession', (sessionId) => openSession(state, sessionId)),
    vscode.commands.registerCommand('aiFleetStatus.copyRootPid', (sessionId) => copyRootPid(state, sessionId, output)),
    vscode.commands.registerCommand('aiFleetStatus.revealTerminal', (name) => revealTerminalByName(name)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        state.tools = compileConfiguredTools(output);
        schedulePoll(state, 0);
      }
    }),
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) {
        schedulePoll(state, 0);
      }
    }),
    vscode.window.onDidOpenTerminal(() => { correlator.refresh(vscode.window.terminals).catch(() => {}); }),
    vscode.window.onDidCloseTerminal(() => { correlator.refresh(vscode.window.terminals).catch(() => {}); }),
    { dispose: () => disposeState(state) }
  );

  schedulePoll(state, 0);
}

async function revealTerminalByName(name) {
  for (const t of vscode.window.terminals) {
    if (t.name === name) {
      t.show();
      return;
    }
  }
}

function detectScope() {
  // vscode.env.remoteName: undefined (local), 'wsl', 'ssh-remote', 'dev-container', etc.
  const remote = vscode.env && vscode.env.remoteName;
  if (!remote) {
    return 'local';
  }
  return `remote:${remote}`;
}

function compileConfiguredTools(output) {
  const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get('tools', undefined);
  const compiled = compileTools(configured);
  if (compiled.length === 0) {
    output.appendLine(`[${new Date().toISOString()}] "aiFleetStatus.tools" produced no usable entries; using built-in defaults.`);
    return compileTools(undefined);
  }
  return compiled;
}

function getPollIntervalMs() {
  const configured = Number(vscode.workspace.getConfiguration(CONFIG_SECTION).get('pollInterval', DEFAULT_POLL_INTERVAL_MS));
  return Number.isFinite(configured) && configured >= 1000 ? configured : DEFAULT_POLL_INTERVAL_MS;
}

function getHideWhenIdle() {
  return Boolean(vscode.workspace.getConfiguration(CONFIG_SECTION).get('hideWhenIdle', false));
}

function getEnableTerminalCorrelation() {
  return Boolean(vscode.workspace.getConfiguration(CONFIG_SECTION).get('enableTerminalCorrelation', true));
}

function getEnableSessionNotifications() {
  return Boolean(vscode.workspace.getConfiguration(CONFIG_SECTION).get('enableSessionNotifications', false));
}

// Conservative, opt-in notifications: only the FIRST session appearing or the LAST
// session ending generate a notification, so a noisy multi-agent environment does
// not spam. We never claim a task "completed" or "succeeded" — only that a session
// started or ended.
function emitLifecycleNotifications(state, prevFirstSeen, nowFirstSeen, fleet) {
  if (!getEnableSessionNotifications()) {
    return;
  }
  if (state.disposed) {
    return;
  }
  if (prevFirstSeen == null && nowFirstSeen != null) {
    const sample = fleet.sessions[0];
    if (sample) {
      vscode.window.showInformationMessage(`${sample.displayName} session started.`);
    }
  } else if (prevFirstSeen != null && nowFirstSeen == null) {
    vscode.window.showInformationMessage('AI Fleet Status: fleet became idle (last AI session ended).');
  }
}

function schedulePoll(state, delayMs) {
  if (state.disposed) {
    return;
  }
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
  }
  state.pollTimer = setTimeout(() => poll(state), delayMs);
}

function nextDelayMs() {
  const base = getPollIntervalMs();
  const focused = vscode.window.state.focused;
  return focused ? base : base * UNFOCUSED_POLL_MULTIPLIER;
}

async function poll(state) {
  if (state.disposed || state.pollInFlight) {
    return;
  }
  state.pollInFlight = true;
  const startedAt = Date.now();

  try {
    const processes = await listProcesses(state.tools, (child) => {
      state.currentChildren.add(child);
      // A child that fails to spawn (e.g. ENOENT) emits 'error' but never
      // 'exit', so it must be removed on either event or it leaks until
      // dispose. 'close' covers both.
      const remove = () => state.currentChildren.delete(child);
      child.once('exit', remove);
      child.once('error', remove);
    });

    if (state.disposed) {
      return;
    }

    // Re-correlate terminal pids opportunistically (cheap; processIds cached).
    await correlatorSafeRefresh(state);

    const fleet = buildFleet(processes, state.tools);
    fleet._graph = buildGraph(processes);
    if (getEnableTerminalCorrelation()) {
      applyTerminalCorrelation(state, fleet);
    }
    const prevFirstSeen = state.lifecycle.firstSeen;
    state.lifecycle.reconcile(fleet);
    state.pollLatencyMs = Date.now() - startedAt;

    emitLifecycleNotifications(state, prevFirstSeen, state.lifecycle.firstSeen, fleet);

    state.lastResult = { fleet, checkedAt: new Date(), error: null, lifecycle: state.lifecycle };
    outputSafe(state, `poll ok in ${state.pollLatencyMs}ms — ${processes.length} candidate processes, ${fleet.toolCount} tool(s) active, ${fleet.sessionCount} session(s)`);
  } catch (error) {
    if (state.disposed) {
      return;
    }
    const reason = describePollError(error);
    state.lastResult = { fleet: state.lastResult.fleet, checkedAt: state.lastResult.checkedAt, error: reason, lifecycle: state.lifecycle };
    outputSafe(state, `poll failed: ${reason}`);
  } finally {
    state.pollInFlight = false;
  }

  refreshStatusBar(state._statusItem, state);
  if (state._treeProvider) {
    state._treeProvider.refresh(state.lastResult.fleet || emptyFleet(state.tools));
  }

  if (!state.disposed) {
    schedulePoll(state, nextDelayMs());
  }
}

function buildGraph(processes) {
  // Local import to avoid a cycle at module load; process-model has no deps on us.
  const { ProcessGraph, Process } = require('./lib/process-model');
  const procs = processes.map((p) => new Process(p.ProcessId, p.ParentProcessId, p.Name, p.CommandLine, p.CreationDate, p.scope || 'local'));
  return new ProcessGraph(procs);
}

// These helpers resolve module-level refs the closure above references; we attach
// the view/statusItem onto state for clean access instead.
function statusItemRef(state) {
  return state._statusItem;
}
function outputSafe(state, text) {
  if (state._output && !state.disposed) {
    try { state._output.appendLine(`[${new Date().toISOString()}] ${text}`); } catch { /* ignore */ }
  }
}
async function correlatorSafeRefresh(state) {
  try {
    await state._correlator.refresh(vscode.window.terminals);
  } catch { /* ignore */ }
}
function applyTerminalCorrelation(state, fleet) {
  if (!state._correlator) {
    return;
  }
  for (const session of fleet.sessions) {
    const graph = fleet._graph;
    if (graph) {
      session.terminal = state._correlator.correlate(graph, session.rootPid);
    }
  }
}

function describePollError(error) {
  if (error && (error.killed || error.signal)) {
    return 'process polling timed out';
  }
  const stderrText = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  if (stderrText) {
    return stderrText.slice(0, 500);
  }
  return (error && error.message) ? String(error.message).slice(0, 500) : 'Unknown process polling error';
}

function refreshStatusBar(item, state) {
  const { fleet, error } = state.lastResult;

  if (error) {
    item.show();
    item.text = '$(warning) AI: poll error';
    item.tooltip = buildErrorTooltip(state);
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }

  item.backgroundColor = undefined;

  if (!fleet || fleet.toolCount === 0) {
    if (getHideWhenIdle()) {
      item.hide();
      return;
    }
    item.show();
    item.text = '$(circle-slash) AI: idle';
    item.tooltip = buildTooltip(state);
    return;
  }

  item.show();
  item.text = summarizeStatusBar(fleet);
  item.tooltip = buildTooltip(state);
}

function buildTooltip(state) {
  const { fleet, checkedAt } = state.lastResult;
  if (!fleet) {
    return 'AI Fleet Status';
  }
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  // NOTE: isTrusted deliberately left FALSE. Tool names are user-configurable and
  // must not be able to inject Markdown/command URIs into the status bar tooltip.
  md.appendMarkdown('**AI Fleet Status**\n\n');

  const summary = summarizeFleet(fleet);
  if (fleet.toolCount === 0) {
    md.appendMarkdown('_No AI CLI sessions currently running._\n\n');
  } else {
    for (const tool of fleet.tools.values()) {
      if (tool.sessions.length === 0) {
        continue;
      }
      const procTotal = tool.sessions.reduce((acc, s) => acc + s.processCount, 0);
      md.appendMarkdown(`- $(sync~spin) **${tool.displayName}** — ${tool.sessions.length} session(s) · ${procTotal} processes\n`);
    }
    md.appendMarkdown('\n');
  }

  md.appendMarkdown(`Total: ${summary.totalTools} tools · ${summary.totalSessions} sessions · ${summary.totalProcesses} processes\n`);
  if (state.scope && state.scope !== 'local') {
    md.appendMarkdown(`Scope: ${state.scope}\n`);
  }
  if (checkedAt) {
    md.appendMarkdown(`---\nLast checked: ${checkedAt.toISOString()}`);
  }
  return md;
}

function buildErrorTooltip(state) {
  const lines = ['**AI Fleet Status** — poll failed', '', `Reason: ${state.lastResult.error}`];
  if (state.lastResult.checkedAt) {
    lines.push(`Last successful check: ${state.lastResult.checkedAt.toISOString()}`);
  } else {
    lines.push('No successful process check yet');
  }
  const md = new vscode.MarkdownString(lines.join('\n'));
  return md;
}

async function showDetails(state) {
  const { fleet, checkedAt, error } = state.lastResult;
  const items = [
    { label: '$(refresh) Refresh now', action: 'refresh' },
    { label: '$(search) Open Fleet Explorer', action: 'explorer' },
    { label: '$(gear) Open settings', action: 'settings' },
    { label: '$(clippy) Copy sanitized diagnostics', action: 'diagnostics' }
  ];

  if (error) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: `$(warning) Poll error: ${error}`, action: 'none' });
  }

  if (fleet && fleet.toolCount > 0) {
    items.push({ label: 'Active', kind: vscode.QuickPickItemKind.Separator });
    for (const tool of fleet.tools.values()) {
      if (tool.sessions.length === 0) {
        continue;
      }
      const procTotal = tool.sessions.reduce((acc, s) => acc + s.processCount, 0);
      items.push({
        label: `$(sync~spin) ${tool.displayName}`,
        description: `${tool.sessions.length} session(s) · ${procTotal} process(es)`,
        action: 'tool',
        toolId: tool.id
      });
    }
  }

  if (fleet) {
    const idle = [];
    for (const tool of fleet.tools.values()) {
      if (tool.sessions.length === 0) {
        idle.push(tool.displayName);
      }
    }
    if (idle.length > 0) {
      items.push({ label: 'Idle', kind: vscode.QuickPickItemKind.Separator });
      for (const name of idle) {
        items.push({ label: `$(circle-slash) ${name}`, description: 'idle', action: 'none' });
      }
    }
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: checkedAt ? `Last checked: ${checkedAt.toISOString()}` : 'No successful check yet', action: 'none' });

  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'AI Fleet Status' });
  if (!picked) {
    return;
  }
  if (picked.action === 'refresh') {
    schedulePoll(state, 0);
  } else if (picked.action === 'explorer') {
    vscode.commands.executeCommand('workbench.view.extension.aiFleetStatus');
  } else if (picked.action === 'settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
  } else if (picked.action === 'diagnostics') {
    copyDiagnostics(state, state._output);
  } else if (picked.action === 'tool') {
    await showToolSessions(state, picked.toolId);
  }
}

async function showToolSessions(state, toolId) {
  const fleet = state.lastResult.fleet;
  if (!fleet) {
    return;
  }
  const tool = fleet.tools.get(toolId);
  if (!tool) {
    return;
  }
  const items = tool.sessions.map((s) => ({
    label: `$(sync~spin) ${s.mode}${s.isNew ? ' (new)' : ''}`,
    description: `root PID ${s.rootPid} · ${s.processCount} processes`,
    action: 'session',
    sessionId: s.id
  }));
  if (tool.services.length > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    for (const sv of tool.services) {
      items.push({ label: `$(warning) service (PID ${sv.pid})`, description: 'daemon/server mode — not a user session', action: 'none' });
    }
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: `${tool.displayName} sessions` });
  if (picked && picked.action === 'session') {
    openSession(state, picked.sessionId);
  }
}

async function openSession(state, sessionId) {
  const fleet = state.lastResult.fleet;
  if (!fleet) {
    return;
  }
  const session = fleet.sessions.find((s) => s.id === sessionId);
  if (!session) {
    vscode.window.showInformationMessage('AI Fleet Status: session no longer active.');
    return;
  }
  const term = session.terminal;
  const terminalLabel = term ? `${term.integrated ? 'integrated' : 'external'}: ${term.name}` : 'OS process (not mapped to a VS Code terminal)';
  const items = [
    { label: `$(info) ${session.displayName} · ${session.mode}`, action: 'none' },
    { label: `Root PID: ${session.rootPid}`, description: terminalLabel, action: 'none' },
    { label: `Processes: ${session.processCount} · confidence: ${session.confidence}`, action: 'none' }
  ];
  if (term && term.integrated) {
    items.push({ label: '$(arrow-right) Reveal terminal', action: 'reveal' });
  }
  items.push({ label: '$(clippy) Copy root PID', action: 'copypid' });
  items.push({ label: '$(clippy) Copy sanitized diagnostics', action: 'diag' });
  items.push({ label: '$(refresh) Refresh', action: 'refresh' });

  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Session details' });
  if (!picked) {
    return;
  }
  if (picked.action === 'reveal') {
    await revealTerminal(term);
  } else if (picked.action === 'copypid') {
    await vscode.env.clipboard.writeText(String(session.rootPid));
    vscode.window.showInformationMessage(`Copied root PID ${session.rootPid}`);
  } else if (picked.action === 'diag') {
    copyDiagnostics(state, state._output);
  } else if (picked.action === 'refresh') {
    schedulePoll(state, 0);
  }
}

async function revealTerminal(termMeta) {
  if (!termMeta) {
    return;
  }
  await revealTerminalByName(termMeta.name);
}

async function copyRootPid(state, sessionId, output) {
  const fleet = state.lastResult.fleet;
  const session = fleet && fleet.sessions.find((s) => s.id === sessionId);
  if (session) {
    await vscode.env.clipboard.writeText(String(session.rootPid));
    vscode.window.showInformationMessage(`Copied root PID ${session.rootPid}`);
  }
}

async function copyDiagnostics(state, output) {
  const diag = buildDiagnostics({
    version: require('./package.json').version,
    platform: process.platform,
    arch: process.arch,
    scope: state.scope,
    tools: state.tools,
    fleet: state.lastResult.fleet || emptyFleet(state.tools),
    lastError: state.lastResult.error,
    pollLatencyMs: state.pollLatencyMs,
    wslScanned: false
  });
  const text = diagnosticsAsText(diag);
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage('Sanitized AI Fleet Status diagnostics copied to clipboard.');
  if (output) {
    output.appendLine(`[${new Date().toISOString()}] diagnostics copied (sanitized; no command lines, prompts, or secrets)`);
  }
}

function emptyFleet(tools) {
  const map = new Map();
  for (const detector of tools) {
    map.set(detector.id, { id: detector.id, displayName: detector.displayName, sessions: [], services: [] });
  }
  return { tools: map, sessions: [], toolCount: 0, sessionCount: 0, processCount: 0, totalMemberProcesses: 0, _graph: null };
}

function disposeState(state) {
  state.disposed = true;
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  for (const child of state.currentChildren) {
    try {
      child.kill();
    } catch { /* already exited */ }
  }
  state.currentChildren.clear();
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _internal: { summarizeStatusBar, buildTooltip, emptyFleet, detectScope }
};
