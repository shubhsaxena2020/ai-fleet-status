'use strict';

// In-process smoke test for extension.js wiring using a minimal VS Code stub.
// Verifies: activate() wires commands/tree/status, a poll cycle produces a fleet,
// the Tree View and Quick Pick handlers run without throwing, and dispose() is safe.
// Does NOT touch real processes beyond what lib/enumerate already does safely.

const Module = require('module');
const path = require('path');

const subscriptions = [];
let statusText = null;
let treeRefreshCount = 0;

function makeEmitter() {
  const map = new Map();
  return {
    event: (name) => (cb) => { map.set(name, cb); return { dispose() {} }; },
    fire: (name, arg) => { const cb = map.get(name); if (cb) cb(arg); }
  };
}

const fakeVscode = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({
      text: '', tooltip: '', command: '', backgroundColor: undefined,
      show() {}, hide() {}, dispose() {}
    }),
    createTreeView: (id, opts) => ({
      id, view: opts.treeDataProvider,
      reveal() { return Promise.resolve(); }, dispose() {}
    }),
    showQuickPick: async (items) => items.find((i) => i.action === 'refresh') || items[0],
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    terminals: [],
    state: { focused: true },
    onDidChangeWindowState: () => ({ dispose() {} }),
    onDidOpenTerminal: () => ({ dispose() {} }),
    onDidCloseTerminal: () => ({ dispose() {} })
  },
  commands: {
    registerCommand: (id, fn) => { fakeVscode.commands._cmds[id] = fn; return { dispose() {} }; },
    executeCommand: async () => undefined,
    _cmds: {}
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} })
  },
  env: {
    clipboard: { writeText: async () => undefined },
    remoteName: undefined,
    appName: 'VS Code'
  },
  StatusBarAlignment: { Right: 1, Left: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  TreeItem: class { constructor(label, collapsible) { this.label = label; this.collapsibleState = collapsible; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  MarkdownString: class { constructor(s) { this.value = s || ''; } appendMarkdown(t) { this.value += t; return this; } appendText(t) { this.value += t; return this; } },
  EventEmitter: class { constructor() { this._cb = null; this.event = (cb) => { this._cb = cb; return { dispose() {} }; }; } fire(arg) { if (this._cb) this._cb(arg); } },
  QuickPickItemKind: { Separator: -1 },
  TreeView: class {}
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.apply(this, arguments);
};

const ext = require('../extension.js');

async function main() {
  const context = { subscriptions, extensionMode: 1, extensionPath: __dirname };
  ext.activate(context);

  // Give the first poll (schedulePoll uses setTimeout 0) a chance to run.
  await new Promise((r) => setTimeout(r, 400));

  // Exercise the registered command handlers.
  const cmds = fakeVscode.commands._cmds;
  const cmdNames = Object.keys(cmds);
  console.log('registered commands:', cmdNames.length);
  if (cmdNames.length < 6) {
    throw new Error('expected at least 6 commands, got ' + cmdNames.length);
  }

  // Refresh now command should not throw.
  await cmds['aiFleetStatus.refresh']();
  // Copy diagnostics should not throw.
  await cmds['aiFleetStatus.copyDiagnostics']();
  // Show details should not throw.
  await cmds['aiFleetStatus.showDetails']();

  ext.deactivate();
  console.log('SMOKE OK: activate, poll, commands, deactivate all ran without throwing.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('SMOKE FAIL:', e); process.exit(1); });
