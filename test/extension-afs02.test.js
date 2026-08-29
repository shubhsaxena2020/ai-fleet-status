'use strict';

// Regression test for AFS-02: Tree View session nodes must resolve to the clicked
// session by a UNIQUE stable session id, NOT by a label/mode prefix match.
//
// Without the fix, _findSessionByLabelPrefix returned the FIRST session whose
// `mode` was a prefix of the node label, so two sessions sharing a mode (e.g. two
// `interactive` claude sessions) collided: expanding the SECOND "interactive"
// node showed the FIRST session's member processes, and open/copy actions could
// target the wrong session.
//
// This drives the LIVE FleetTreeDataProvider (via activate, with enumerate
// stubbed so the poll doesn't hit the OS) over the real FIX.fourSessions fixture
// (four claude sessions; two are `interactive` at rootPid 1001 and 1010). It
// asserts the 2nd "interactive" node (a) carries a stable sessionId and (b)
// expands to its OWN members (rootPid 1010), never the first session (1001).

const Module = require('module');
const { FIX } = require('./fixtures');
const { compileTools } = require('../lib/detect');
const { buildFleet } = require('../lib/sessions');

let treeView = null;
const fakeVscode = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', backgroundColor: undefined, show() {}, hide() {}, dispose() {} }),
    createTreeView: (id, opts) => { const v = { id, view: opts.treeDataProvider, reveal() { return Promise.resolve(); }, dispose() {} }; treeView = v; return v; },
    showQuickPick: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    terminals: [], state: { focused: true },
    onDidChangeWindowState: () => ({ dispose() {} }),
    onDidOpenTerminal: () => ({ dispose() {} }),
    onDidCloseTerminal: () => ({ dispose() {} })
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined, _cmds: {} },
  workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }), onDidChangeTextDocument: () => ({ dispose() {} }) },
  env: { clipboard: { writeText: async () => undefined }, remoteName: undefined, appName: 'VS Code' },
  StatusBarAlignment: { Right: 1, Left: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  TreeItem: class { constructor(label, collapsible) { this.label = label; this.collapsibleState = collapsible; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  MarkdownString: class { constructor(s) { this.value = s || ''; } appendMarkdown(t) { this.value += t; return this; } appendText(t) { this.value += t; return this; } },
  EventEmitter: class { constructor() { this._cb = null; this.event = (cb) => { this._cb = cb; return { dispose() {} }; }; } fire(a) { if (this._cb) this._cb(a); } },
  QuickPickItemKind: { Separator: -1 },
  TreeView: class {}
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  if (request.endsWith('lib/enumerate')) return { listProcesses: async () => [], candidateProcessNames: () => new Set(), parseCimDateTime: () => null };
  return origLoad.apply(this, arguments);
};

const ext = require('../extension.js');

function fail(msg) { throw new Error('AFS-02 REGRESSION: ' + msg); }

async function main() {
  ext.activate({ subscriptions: [], extensionMode: 1, extensionPath: __dirname });
  const provider = treeView ? treeView.view : null;
  if (!provider) fail('could not reach the FleetTreeDataProvider');

  const fleet = buildFleet(FIX.fourSessions, compileTools(undefined));
  provider.fleet = fleet;

  // Sanity: fixture yields >=2 interactive sessions.
  const interactiveSessions = fleet.sessions.filter((s) => s.mode === 'interactive');
  if (interactiveSessions.length < 2) {
    fail('fixture no longer yields >=2 interactive sessions: ' + JSON.stringify(fleet.sessions.map((s) => s.mode)));
  }

  const toolNodes = provider.getChildren(null);
  const claudeNode = toolNodes.find((n) => n.contextValue === 'aiFleetTool' && /\bClaude\b/i.test(n.label));
  if (!claudeNode) fail('no claude tool node in tree');

  const sessionNodes = provider.getChildren(claudeNode);
  const interactiveNodes = sessionNodes.filter((n) => String(n.label).startsWith('interactive'));
  if (interactiveNodes.length < 2) fail('expected >=2 interactive session nodes, got ' + interactiveNodes.length);

  // (a) Each interactive node must carry a stable, distinct sessionId.
  const firstSid = interactiveNodes[0].sessionId;
  const secondSid = interactiveNodes[1].sessionId;
  if (firstSid == null || secondSid == null) fail('interactive node missing sessionId');
  if (firstSid === secondSid) fail('two interactive nodes share the same sessionId');

  // (b) The two same-mode nodes must NOT render with identical labels.
  if (interactiveNodes[0].label === interactiveNodes[1].label) {
    fail('two interactive nodes have identical labels ("' + interactiveNodes[0].label + '") — indistinguishable in the tree');
  }

  // (c) Expanding the SECOND interactive node must resolve to its OWN session.
  const second = interactiveNodes[1];
  const members = provider.getChildren(second);
  if (!Array.isArray(members) || members.length === 0) fail('expanding 2nd interactive node returned no members');
  const resolvedPid = members[0].description.match(/PID (\d+)/)[1];
  if (resolvedPid === '1001') fail('expanding 2nd interactive node resolved the FIRST session (1001), not the clicked one');
  if (resolvedPid !== '1010') fail('unexpected resolved pid for 2nd interactive node: ' + resolvedPid);

  // (d) First node also resolves to its own (1001), proving symmetry.
  const firstMembers = provider.getChildren(interactiveNodes[0]);
  const firstPid = firstMembers[0].description.match(/PID (\d+)/)[1];
  if (firstPid !== '1001') fail('expanding 1st interactive node resolved pid ' + firstPid + ', expected 1001');

  console.log('AFS-02 OK: two same-mode sessions resolve to distinct own members via unique sessionId (PID ' + firstPid + ' vs ' + resolvedPid + ').');
  process.exit(0);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
