'use strict';

const vscode = require('vscode');
const { listProcesses } = require('./lib/process-list');
const { buildTasksByTool, formatProcessChain } = require('./lib/process-chains');
const { DEFAULT_TOOLS, compileTools } = require('./lib/tool-config');

const CONFIG_SECTION = 'aiFleetStatus';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const UNFOCUSED_POLL_MULTIPLIER = 3;
const MAX_SHORT_LABEL_LENGTH = 24;

function activate(context) {
  const output = vscode.window.createOutputChannel('AI Fleet Status');
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'aiFleetStatus.showDetails';

  const state = {
    tools: compileConfiguredTools(output),
    lastResult: { activeTools: [], idleTools: [], checkedAt: null, error: null },
    pollInFlight: false,
    pollTimer: null,
    currentChild: null,
    disposed: false
  };

  refreshStatusBar(item, state);

  context.subscriptions.push(
    item,
    output,
    vscode.commands.registerCommand('aiFleetStatus.showDetails', () => showDetails(state)),
    vscode.commands.registerCommand('aiFleetStatus.refresh', () => schedulePoll(item, state, output, 0)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        state.tools = compileConfiguredTools(output);
        schedulePoll(item, state, output, 0);
      }
    }),
    vscode.window.onDidChangeWindowState(() => schedulePoll(item, state, output, 0)),
    { dispose: () => disposeState(state) }
  );

  schedulePoll(item, state, output, 0);
}

function compileConfiguredTools(output) {
  const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get('tools', DEFAULT_TOOLS);
  const compiled = compileTools(configured);

  if (compiled.length === 0) {
    output.appendLine(`[${new Date().toISOString()}] "${CONFIG_SECTION}.tools" produced no usable entries; falling back to built-in defaults.`);
    return compileTools(DEFAULT_TOOLS);
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

function schedulePoll(item, state, output, delayMs) {
  if (state.disposed) {
    return;
  }

  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
  }

  state.pollTimer = setTimeout(() => poll(item, state, output), delayMs);
}

function nextDelayMs() {
  const base = getPollIntervalMs();
  const focused = vscode.window.state.focused;
  return focused ? base : base * UNFOCUSED_POLL_MULTIPLIER;
}

async function poll(item, state, output) {
  if (state.disposed || state.pollInFlight) {
    return;
  }

  state.pollInFlight = true;
  const startedAt = Date.now();

  try {
    const processes = await listProcesses(state.tools, (child) => {
      state.currentChild = child;
    });
    state.currentChild = null;

    if (state.disposed) {
      return;
    }

    const tasksByTool = buildTasksByTool(processes, state.tools);
    const checkedAt = new Date();
    const activeTools = [];
    const idleTools = [];

    for (const tool of state.tools) {
      const tasks = tasksByTool.get(tool.name) || [];

      if (tasks.length > 0) {
        activeTools.push({ name: tool.name, tasks });
      } else {
        idleTools.push(tool.name);
      }
    }

    state.lastResult = { activeTools, idleTools, checkedAt, error: null };
    output.appendLine(`[${checkedAt.toISOString()}] poll ok in ${Date.now() - startedAt}ms — ${processes.length} candidate processes, ${activeTools.length} tool(s) active`);
  } catch (error) {
    state.currentChild = null;

    if (state.disposed) {
      return;
    }

    const reason = describePollError(error);
    state.lastResult = { activeTools: [], idleTools: [], checkedAt: state.lastResult.checkedAt, error: reason };
    output.appendLine(`[${new Date().toISOString()}] poll failed: ${reason}`);
  } finally {
    state.pollInFlight = false;
  }

  refreshStatusBar(item, state);

  if (!state.disposed) {
    schedulePoll(item, state, output, nextDelayMs());
  }
}

function describePollError(error) {
  if (error && (error.killed || error.signal)) {
    return 'process polling timed out';
  }

  const stderrText = typeof error.stderr === 'string' ? error.stderr.trim() : '';

  if (stderrText) {
    return stderrText;
  }

  return (error && error.message) || 'Unknown process polling error';
}

function refreshStatusBar(item, state) {
  const { activeTools, error } = state.lastResult;

  if (error) {
    item.show();
    item.text = '$(warning) AI: poll error';
    item.tooltip = buildErrorTooltip(state);
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }

  item.backgroundColor = undefined;

  if (activeTools.length === 0) {
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
  item.text = `$(sync~spin) AI: ${summarizeActiveTools(activeTools)}`;
  item.tooltip = buildTooltip(state);
}

function summarizeActiveTools(activeTools) {
  if (activeTools.length <= 2) {
    const joined = activeTools.map((tool) => tool.name).join(', ');

    if (joined.length <= MAX_SHORT_LABEL_LENGTH) {
      return joined;
    }
  }

  return `${activeTools.length} active`;
}

function buildTooltip(state) {
  const { activeTools, idleTools, checkedAt } = state.lastResult;
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportThemeIcons = true;

  md.appendMarkdown('**AI Fleet Status**\n\n');

  if (activeTools.length === 0) {
    md.appendMarkdown('_No delegated AI CLI tasks currently running._\n\n');
  } else {
    for (const tool of activeTools) {
      const detail = tool.tasks.map(formatProcessChain).join('; ');
      md.appendMarkdown(`- $(sync~spin) **${tool.name}** — ${detail}\n`);
    }

    md.appendMarkdown('\n');
  }

  if (idleTools.length > 0) {
    md.appendMarkdown(`_Idle: ${idleTools.join(', ')}_\n\n`);
  }

  if (checkedAt) {
    md.appendMarkdown(`---\nLast checked: ${checkedAt.toISOString()}`);
  }

  return md;
}

function buildErrorTooltip(state) {
  const lines = ['AI Fleet Status poll failed', `Reason: ${state.lastResult.error}`];

  if (state.lastResult.checkedAt) {
    lines.push(`Last successful check: ${state.lastResult.checkedAt.toISOString()}`);
  } else {
    lines.push('No successful process check yet');
  }

  return lines.join('\n');
}

async function showDetails(state) {
  const { activeTools, idleTools, checkedAt, error } = state.lastResult;
  const items = [
    { label: '$(refresh) Refresh now', kind: vscode.QuickPickItemKind.Default, action: 'refresh' },
    { label: '$(gear) Open settings', kind: vscode.QuickPickItemKind.Default, action: 'settings' }
  ];

  if (error) {
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(warning) Poll error: ${error}`, kind: vscode.QuickPickItemKind.Default }
    );
  }

  if (activeTools.length > 0) {
    items.push({ label: 'Active', kind: vscode.QuickPickItemKind.Separator });

    for (const tool of activeTools) {
      items.push({
        label: `$(sync~spin) ${tool.name}`,
        description: tool.tasks.map(formatProcessChain).join('; ')
      });
    }
  }

  if (idleTools.length > 0) {
    items.push({ label: 'Idle', kind: vscode.QuickPickItemKind.Separator });

    for (const name of idleTools) {
      items.push({ label: `$(circle-slash) ${name}`, description: 'idle' });
    }
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: checkedAt ? `Last checked: ${checkedAt.toISOString()}` : 'No successful check yet',
    kind: vscode.QuickPickItemKind.Default
  });

  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'AI Fleet Status' });

  if (picked && picked.action === 'refresh') {
    await vscode.commands.executeCommand('aiFleetStatus.refresh');
  } else if (picked && picked.action === 'settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
  }
}

function disposeState(state) {
  state.disposed = true;

  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  if (state.currentChild) {
    try {
      state.currentChild.kill();
    } catch {
      // Already exited - nothing to do.
    }

    state.currentChild = null;
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  // Exported for tests only - not part of the extension's runtime API surface.
  _internal: { summarizeActiveTools }
};
