'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FIX, withCreation } = require('./fixtures');

const { compileTools, detect } = require('../lib/detect');
const { buildFleet } = require('../lib/sessions');
const { sanitizeCommandLine, safeProcessLabel, redactDiagnosticsProcesses, redactSecrets, REDACT_SECRET } = require('../lib/sanitize');
const { summarizeStatusBar, summarizeFleet } = require('../lib/format');
const { SessionLifecycle } = require('../lib/lifecycle');
const { TerminalCorrelator } = require('../lib/terminal');
const { _internal: enumerateInternal } = require('../lib/enumerate');
const { sanitizeCandidateName, buildWindowsScript } = enumerateInternal;
const { ProcessGraph, Process } = require('../lib/process-model');
const { buildDiagnostics, diagnosticsAsText } = require('../lib/diagnostics');
const { candidateProcessNames, listProcesses } = require('../lib/enumerate');

// ---------------------------------------------------------------------------
// Tool adapter / config compilation
// ---------------------------------------------------------------------------
test('compileTools falls back to built-ins when config null', () => {
  const tools = compileTools(undefined);
  assert.ok(tools.length >= 9);
  const ids = new Set(tools.map((t) => t.id));
  for (const expected of ['codex', 'opencode', 'hermes', 'antigravity', 'claude', 'gemini', 'qwen', 'goose', 'kiro']) {
    assert.ok(ids.has(expected), `missing detector ${expected}`);
  }
});

test('compileTools drops malformed custom entries and keeps valid ones', () => {
  const custom = [
    { name: 'Good Tool', processNames: ['good.exe', 'good'] },
    { name: 'No ProcessNames' }, // invalid
    { name: 5, processNames: ['x'] }, // invalid
    'not an object',
    { processNames: ['x'] }, // missing name
    { name: 'Empty', processNames: [] } // empty processNames
  ];
  const tools = compileTools(custom);
  const ids = new Set(tools.map((t) => t.id));
  assert.ok(ids.has('Good Tool'));
  assert.equal(ids.has('No ProcessNames'), false);
  assert.equal(ids.has('Empty'), false);
  assert.equal(tools.length, 1);
});

test('compileTools accepts new structured fields (serviceSubcommands etc.) without error', () => {
  const custom = [{
    name: 'Custom',
    processNames: ['custom.exe'],
    serviceSubcommands: ['serve'],
    delegatedFlags: ['-p'],
    resumeFlags: ['--resume'],
    nodeIdentityFragments: ['custom-cli']
  }];
  const tools = compileTools(custom);
  assert.equal(tools.length, 1);
  assert.ok(tools[0].serviceSubcommands.has('serve'));
  assert.ok(tools[0].delegatedFlags.has('-p'));
  assert.ok(tools[0].resumeFlags.has('--resume'));
  assert.ok(Array.isArray(tools[0].interpreterHosted) && tools[0].interpreterHosted.length === 1);
});

// ---------------------------------------------------------------------------
// Identity vs mode separation
// ---------------------------------------------------------------------------
test('bare interactive CLI is detected as a session (identity != mode)', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'claude.exe', CommandLine: 'claude.exe' }, tools);
  assert.ok(det, 'bare claude.exe must be detected');
  assert.equal(det.mode, 'interactive');
});

test('delegated one-shot is detected as delegated, not missed', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'claude.exe', CommandLine: 'claude.exe -p "do thing"' }, tools);
  assert.ok(det);
  assert.equal(det.mode, 'delegated');
});

test('resume subcommand yields resume mode', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'claude.exe', CommandLine: 'claude.exe --resume' }, tools);
  assert.ok(det);
  assert.equal(det.mode, 'resume');
});

test('service modes are NOT classified as user sessions', () => {
  const tools = compileTools(undefined);
  const serve = detect({ Name: 'hermes.exe', CommandLine: 'hermes.exe serve --port 9120' }, tools);
  assert.equal(serve.kind, 'service', 'serve must be reported as a service, not a session');
  const chat = detect({ Name: 'hermes.exe', CommandLine: 'hermes.exe chat' }, tools);
  assert.ok(chat, 'chat must be a session');
  assert.equal(chat.mode, 'interactive');
});

test('codex app-server is a service, bare codex is a session', () => {
  const tools = compileTools(undefined);
  const app = detect({ Name: 'codex.exe', CommandLine: 'codex.exe app-server' }, tools);
  assert.equal(app.kind, 'service');
  const bare = detect({ Name: 'codex.exe', CommandLine: 'codex.exe' }, tools);
  assert.ok(bare);
});

test('kiro bare invocation is detected (no chat token required)', () => {
  const tools = compileTools(undefined);
  const bare = detect({ Name: 'kiro-cli.exe', CommandLine: 'kiro-cli.exe' }, tools);
  const tui = detect({ Name: 'kiro-cli', CommandLine: 'kiro-cli --tui' }, tools);
  assert.ok(bare, 'kiro bare must be detected');
  assert.ok(tui, 'kiro --tui must be detected');
});

test('qwen via node shim matches by path fragment, both entrypoints', () => {
  const tools = compileTools(undefined);
  const cli = detect({ Name: 'node.exe', CommandLine: 'node.exe C:/x/@qwen-code/qwen-code/cli.js -p hi' }, tools);
  assert.ok(cli, 'cli.js entrypoint must match');
  assert.equal(cli.id, 'qwen');
  const entry = detect({ Name: 'node.exe', CommandLine: 'node.exe C:/x/@qwen-code/qwen-code/dist/cli-entry.js' }, tools);
  assert.ok(entry, 'cli-entry.js must match');
});

test('non-AI node script in a tool-named directory is NOT a session', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'node.exe', CommandLine: 'node.exe C:/repos/claude-wrapper/script.js' }, tools);
  assert.equal(det, null, 'a script merely in a dir named like the tool must not match');
});

test('a node script in a qwen-forks directory is NOT qwen', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'node.exe', CommandLine: 'node.exe C:/repos/qwen-forks/myapp.js' }, tools);
  assert.equal(det, null);
});

// --- Reconciliation tests from current-CLI research (Wave B) ---

test('opencode2 is detected as its own tool (verified V2 binary)', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'opencode2.exe', CommandLine: 'opencode2.exe' }, tools);
  assert.ok(det, 'opencode2 native binary must match');
  assert.equal(det.id, 'opencode2');
  // opencode (V1) must NOT be classified as opencode2.
  const v1 = detect({ Name: 'opencode.exe', CommandLine: 'opencode.exe run "x"' }, tools);
  assert.equal(v1.id, 'opencode');
});

test('management/utility subcommands are NOT counted as sessions (no false positives)', () => {
  const tools = compileTools(undefined);
  const cases = [
    ['claude.exe', 'claude.exe mcp list', 'claude'],
    ['claude.exe', 'claude.exe update', 'claude'],
    ['agy.exe', 'agy.exe update', 'antigravity'],
    ['goose.exe', 'goose.exe configure', 'goose'],
    ['kiro-cli.exe', 'kiro-cli.exe agent list', 'kiro'],
    ['kiro-cli.exe', 'kiro-cli.exe login', 'kiro'],
    ['qwen.exe', 'qwen.exe sessions ls', 'qwen'],
    ['qwen.exe', 'qwen.exe mcp list', 'qwen'],
    ['codex.exe', 'codex.exe mcp list', 'codex'],
    ['opencode.exe', 'opencode.exe session list', 'opencode'],
    ['hermes.exe', 'hermes.exe doctor', 'hermes']
  ];
  for (const [name, cmd, toolId] of cases) {
    const det = detect({ Name: name, CommandLine: cmd }, tools);
    assert.equal(det, null, `management subcommand must not be a session: ${cmd}`);
  }
});

test('hermes --resume is a real session (not a util subcommand)', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'hermes.exe', CommandLine: 'hermes.exe --resume last' }, tools);
  assert.ok(det, 'hermes --resume must match');
  assert.equal(det.kind, 'session');
  assert.equal(det.mode, 'resume');
});

test('hermes python-subprocess identity is detected via interpreter-hosted fragment', () => {
  const tools = compileTools(undefined);
  const det = detect({
    Name: 'python.exe',
    CommandLine: 'C:/Users/shubh/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe "C:/Users/shubh/AppData/Local/hermes/hermes-agent/venv/Scripts/hermes.exe" chat'
  }, tools);
  assert.ok(det, 'hermes python subprocess must match via hermes fragment');
  assert.equal(det.id, 'hermes');
});

test('service subcommands still excluded from sessions', () => {
  const tools = compileTools(undefined);
  const cases = [
    ['codex.exe', 'codex.exe app-server'],
    ['opencode.exe', 'opencode.exe serve'],
    ['opencode2.exe', 'opencode2.exe serve'],
    ['hermes.exe', 'hermes.exe serve --port 9120'],
    ['hermes.exe', 'hermes.exe dashboard'],
    ['hermes.exe', 'hermes.exe acp'],
    ['qwen.exe', 'qwen.exe serve --http-bridge'],
    ['goose.exe', 'goose.exe serve'],
    ['goose.exe', 'goose.exe acp'],
    ['kiro-cli.exe', 'kiro-cli.exe serve'],
    ['agy.exe', 'agy.exe mic-serve']
  ];
  for (const [name, cmd] of cases) {
    const det = detect({ Name: name, CommandLine: cmd }, tools);
    assert.ok(det && det.kind === 'service', `must be a service, not a session: ${cmd}`);
  }
});

test('bare interactive invocations are detected as sessions (no flag required)', () => {
  const tools = compileTools(undefined);
  const cases = [
    ['claude.exe', 'claude.exe'],
    ['codex.exe', 'codex.exe'],
    ['qwen.exe', 'qwen.exe'],
    ['kiro-cli.exe', 'kiro-cli.exe'],
    ['agy.exe', 'agy.exe'],
    ['goose.exe', 'goose.exe session'],
    ['opencode.exe', 'opencode.exe']
  ];
  for (const [name, cmd] of cases) {
    const det = detect({ Name: name, CommandLine: cmd }, tools);
    assert.ok(det && det.kind === 'session', `bare interactive must be a session: ${cmd}`);
    assert.equal(det.mode, 'interactive');
  }
});

// ---------------------------------------------------------------------------
// Session counting (the core mandate)
// ---------------------------------------------------------------------------
test('single session fixture -> 1 session, 1 process', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.oneSession, tools);
  assert.equal(fleet.toolCount, 1);
  assert.equal(fleet.sessionCount, 1);
  assert.equal(fleet.processCount, 1);
});

test('four independent sessions of same tool -> 4 sessions', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.fourSessions, tools);
  const claude = fleet.tools.get('claude');
  assert.equal(claude.sessions.length, 4, 'should be 4 sessions, not 1');
  assert.equal(fleet.sessionCount, 4);
});

test('one session with helpers is NOT over-counted', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.oneSessionHelpers, tools);
  const claude = fleet.tools.get('claude');
  assert.equal(claude.sessions.length, 1, 'helpers must not inflate session count');
  assert.equal(claude.sessions[0].processCount, 3, 'but all 3 procs counted as members');
});

test('nested shell -> node -> AI binary yields one session', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.nestedShell, tools);
  assert.equal(fleet.toolCount, 1);
  assert.equal(fleet.sessionCount, 1);
});

test('two independent sessions sharing a shell ancestor remain separate', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.sharedAncestor, tools);
  assert.equal(fleet.toolCount, 2);
  const claude = fleet.tools.get('claude');
  const codex = fleet.tools.get('codex');
  assert.equal(claude.sessions.length, 1);
  assert.equal(codex.sessions.length, 1);
  assert.equal(fleet.sessionCount, 2);
});

test('duplicate OS rows do not double-count a session', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.duplicateRows, tools);
  const claude = fleet.tools.get('claude');
  assert.equal(claude.sessions.length, 1);
});

test('PID prefix collision is not treated as same PID', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.pidPrefix, tools);
  assert.equal(fleet.toolCount, 2);
  assert.equal(fleet.sessionCount, 2);
});

test('dead parent mid-poll does not crash', () => {
  const tools = compileTools(undefined);
  assert.doesNotThrow(() => buildFleet(FIX.deadParent, tools));
  const fleet = buildFleet(FIX.deadParent, tools);
  assert.equal(fleet.sessionCount, 1);
});

test('missing command line still classifies by process name', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.missingCmdline, tools);
  assert.equal(fleet.sessionCount, 1);
});

test('malformed PID fields handled gracefully', () => {
  const tools = compileTools(undefined);
  assert.doesNotThrow(() => buildFleet(FIX.malformed, tools));
  const fleet = buildFleet(FIX.malformed, tools);
  assert.ok(fleet.sessionCount >= 1);
});

test('control characters in command line do not crash detection', () => {
  const tools = compileTools(undefined);
  assert.doesNotThrow(() => buildFleet(FIX.controlChars, tools));
  assert.equal(buildFleet(FIX.controlChars, tools).sessionCount, 1);
});

test('very long command line does not crash or hang', () => {
  const tools = compileTools(undefined);
  assert.doesNotThrow(() => buildFleet(FIX.longCmdline, tools));
  assert.equal(buildFleet(FIX.longCmdline, tools).sessionCount, 1);
});

test('unicode paths in node shim are matched', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'node.exe', CommandLine: FIX.unicodePath[0].CommandLine }, tools);
  assert.ok(det, 'qwen unicode-path shim must match');
  assert.equal(det.id, 'qwen');
});

test('paths with spaces (quoted) are matched', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'node.exe', CommandLine: FIX.spacedPath[0].CommandLine }, tools);
  assert.ok(det, 'qwen spaced-path shim must match');
});

test('windows quoting / backslashes matched', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'hermes.exe', CommandLine: FIX.windowsQuoting[0].CommandLine }, tools);
  assert.ok(det);
  assert.equal(det.id, 'hermes');
});

test('posix quoting matched', () => {
  const tools = compileTools(undefined);
  const det = detect({ Name: 'node', CommandLine: FIX.posixQuoting[0].CommandLine }, tools);
  assert.ok(det);
  assert.equal(det.id, 'qwen');
});

test('service modes excluded but interactive sessions counted', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.serviceModes, tools);
  const hermes = fleet.tools.get('hermes');
  assert.equal(hermes.sessions.length, 1, 'only chat is a session');
  assert.equal(hermes.services.length, 1, 'serve is a service');
  const codex = fleet.tools.get('codex');
  assert.equal(codex.services.length, 1, 'app-server is a service');
  const opencode = fleet.tools.get('opencode');
  assert.equal(opencode.services.length, 1, 'opencode serve is a service');
});

test('multiple tools simultaneously', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.multiTool, tools);
  assert.equal(fleet.toolCount, 4);
  assert.equal(fleet.sessionCount, 4);
});

test('qwen shim both entrypoints counted as 2 sessions', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.qwenShim, tools);
  const qwen = fleet.tools.get('qwen');
  assert.equal(qwen.sessions.length, 2);
});

test('kiro bare counted', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.kiroBare, tools);
  assert.equal(fleet.tools.get('kiro').sessions.length, 2);
});

test('opencode (V1) and opencode2 (V2) are detected as separate tools', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.opencodeVariants, tools);
  assert.equal(fleet.tools.get('opencode').sessions.length, 1, 'V1 opencode is a session');
  // Research (2026-08-29, official OpenCode V2 docs): V2 installs and runs as
  // `opencode2`, a SEPARATE binary from V1's `opencode`, so both coexist. The
  // `opencode2` process in the fixture must now be classified as its own tool.
  assert.equal(fleet.tools.has('opencode2'), true, 'opencode2 detector now registered');
  assert.equal(fleet.tools.get('opencode2').sessions.length, 1, 'opencode2 is a session');
});

test('full real-evidence fixture: 6 tools, 9 sessions', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.realEvidence, tools);
  assert.equal(fleet.toolCount, 6, `expected 6 tools, got ${fleet.toolCount}`);
  // Claude: roots 1001+helpers, 1010, 1011, 1020 = 4; Codex bare = 1; Hermes chat = 1;
  // Qwen = 1; Kiro = 1; Antigravity = 1 => 9.
  assert.equal(fleet.sessionCount, 9, `expected 9 sessions, got ${fleet.sessionCount}`);
  const claude = fleet.tools.get('claude');
  assert.equal(claude.sessions.length, 4, 'claude should have 4 sessions');
  // session 1001 has 3 members (claude + node + bash)
  const root = claude.sessions.find((s) => s.rootPid === 1001);
  assert.ok(root);
  assert.equal(root.processCount, 3);
  const hermes = fleet.tools.get('hermes');
  assert.equal(hermes.services.length, 1, 'hermes serve is a service');
  const codex = fleet.tools.get('codex');
  assert.equal(codex.services.length, 1, 'codex app-server is a service');
});

// ---------------------------------------------------------------------------
// Stable session IDs / PID reuse (CreationDate basis)
// ---------------------------------------------------------------------------
test('stable id survives across polls for same root + creation time', () => {
  const tools = compileTools(undefined);
  const fleetA = buildFleet(withCreation(FIX.oneSession, 1700000000000), tools);
  const fleetB = buildFleet(withCreation(FIX.oneSession, 1700000000000), tools);
  assert.equal(fleetA.sessions[0].id, fleetB.sessions[0].id);
});

test('PID reuse (same root pid, different creation time) => different session id', () => {
  const tools = compileTools(undefined);
  const fleetA = buildFleet(withCreation(FIX.oneSession, 1700000000000), tools);
  const fleetB = buildFleet(withCreation(FIX.oneSession, 1700009999000), tools);
  assert.notEqual(fleetA.sessions[0].id, fleetB.sessions[0].id);
});

// ---------------------------------------------------------------------------
// Session lifecycle reconciliation
// ---------------------------------------------------------------------------
test('lifecycle: new -> continuing -> ended transitions', () => {
  const tools = compileTools(undefined);
  const life = new SessionLifecycle();
  const f1 = buildFleet(withCreation(FIX.oneSession, 1000), tools);
  life.reconcile(f1);
  assert.equal(f1.sessions[0].isNew, true, 'first sighting is new');
  assert.equal(life.seen.has(f1.sessions[0].id), true);

  const f2 = buildFleet(withCreation(FIX.oneSession, 1000), tools);
  life.reconcile(f2);
  assert.equal(f2.sessions[0].isNew, false, 'same id seen again => not new');

  // Empty fleet => the previously-seen session is removed from `seen` (ended).
  const empty = buildFleet([], tools);
  life.reconcile(empty);
  assert.equal(life.seen.size, 0, 'ended session removed from history');
  assert.equal(life.justEnded.length, 1, 'ended session recorded for optional notification');
});

test('lifecycle history is bounded', () => {
  const life = new SessionLifecycle();
  for (let i = 0; i < 200; i++) {
    life.seen.set(`s${i}`, { id: `s${i}`, lastSeen: i });
  }
  // Drive a reconcile with an empty fleet so the trim logic runs against `seen`.
  life.reconcile(buildFleet([], compileTools(undefined)));
  assert.ok(life.seen.size <= 50 + 1, 'history should be trimmed to MAX_HISTORY');
});

// ---------------------------------------------------------------------------
// Terminal correlation
// ---------------------------------------------------------------------------
test('terminal correlation maps a descendant of a shell pid to the terminal', async () => {
  // Graph: shell pid 500 -> claude 1001. Terminal shellPid = 500.
  const rows = [
    { ProcessId: 500, ParentProcessId: 1, Name: 'powershell.exe', CommandLine: 'powershell.exe' },
    { ProcessId: 1001, ParentProcessId: 500, Name: 'claude.exe', CommandLine: 'claude.exe' }
  ];
  const graph = new ProcessGraph(rows.map((r) => new Process(r.ProcessId, r.ParentProcessId, r.Name, r.CommandLine)));
  const correlator = new TerminalCorrelator();
  await correlator.refresh([{ name: 'Terminal 1', processId: Promise.resolve(500), exitStatus: undefined }]);
  const result = correlator.correlate(graph, 1001);
  assert.ok(result, 'session should map to terminal');
  assert.equal(result.name, 'Terminal 1');
  assert.equal(result.integrated, true);
});

test('external session (no matching terminal) returns undefined', async () => {
  const rows = [
    { ProcessId: 1001, ParentProcessId: 999, Name: 'claude.exe', CommandLine: 'claude.exe' }
  ];
  const graph = new ProcessGraph(rows.map((r) => new Process(r.ProcessId, r.ParentProcessId, r.Name, r.CommandLine)));
  const correlator = new TerminalCorrelator();
  await correlator.refresh([{ name: 'Terminal 1', processId: Promise.resolve(500), exitStatus: undefined }]);
  const result = correlator.correlate(graph, 1001);
  assert.equal(result, undefined);
});

test('correlator.refresh is safe with terminals lacking processId', async () => {
  const corr = new TerminalCorrelator();
  const badTerminal = { name: 'Terminal X', processId: Promise.reject(new Error('closed')), exitStatus: undefined };
  await corr.refresh([badTerminal]); // must not throw
  assert.equal(corr.terminalsByShellPid.size, 0);
});

// ---------------------------------------------------------------------------
// Sanitize / redaction
// ---------------------------------------------------------------------------
test('sanitizeCommandLine redacts env-style secrets', () => {
  const out = sanitizeCommandLine('OPENAI_API_KEY=sk-1234567890abcdef claude -p hi');
  assert.ok(!out.includes('sk-1234567890abcdef'));
  assert.ok(out.includes('‹secret›'));
});

test('sanitizeCommandLine redacts tokens in URL query', () => {
  const out = sanitizeCommandLine('curl https://api.example.com/v1?token=abc123def456');
  assert.ok(!out.includes('abc123def456'));
});

test('sanitizeCommandLine redacts --key/--token style flags', () => {
  const out = sanitizeCommandLine('tool --api-key=supersecretvalue --token bearerX');
  assert.ok(!out.includes('supersecretvalue'));
  assert.ok(!out.includes('bearerX'));
});

test('safeProcessLabel keeps tool name and truncates, never full prompt', () => {
  const label = safeProcessLabel('claude.exe -p "this is a very long user prompt that must not appear in the UI"');
  assert.ok(!label.includes('this is a very long user prompt'));
  assert.ok(label.startsWith('claude.exe'));
});

// Regression: short secret PREFIXES (e.g. a GitHub PAT fragment `ghp_xxxx`) must
// be redacted even though they are far shorter than a full token. A known
// credential prefix is itself sensitive and must never reach the UI or
// diagnostics. Found by an independent post-implementation security reviewer.
test('safeProcessLabel redacts short known secret prefixes (regression)', () => {
  const label = safeProcessLabel('node ghp_xxxx --password=hunter2 some long prompt here');
  assert.ok(!label.includes('ghp_xxxx'), 'short GitHub PAT prefix must be redacted');
  assert.ok(!label.includes('hunter2'), 'password value must be redacted');
  assert.ok(label.includes(REDACT_SECRET), 'redaction marker present');
});

test('redactSecrets redacts short known secret prefixes (regression)', () => {
  assert.ok(!redactSecrets('claude.exe ghp_xxxx short').includes('ghp_xxxx'));
  assert.ok(!redactSecrets('xoxb-abc').includes('xoxb-abc'));
  // NOTE: intentionally NOT a provider-shaped literal (sk-...) to avoid GitHub
  // push-protection false positives; the hyphen-delimited key path is covered by
  // the generic SECRET_PATTERNS rule and the non-literal fixtures elsewhere.
  assert.ok(!redactSecrets('prefix-sk-abc-suffix').includes('sk-abc'));
});

test('redactDiagnosticsProcesses never includes full command lines', () => {
  const procs = [
    { ProcessId: 1, ParentProcessId: 0, Name: 'claude.exe', CommandLine: 'claude.exe -p "SECRET PROMPT TEXT"' }
  ];
  const out = redactDiagnosticsProcesses(procs);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('SECRET PROMPT TEXT'));
  assert.ok(json.includes('claude.exe'));
});

// --- Wave-E redaction coverage expansion (sanitize.js secret-shape gaps) ---

test('redactSecrets redacts non-http credential URLs', () => {
  assert.ok(!redactSecrets('postgresql://admin:s3cr3t@db.example.com/app').includes('s3cr3t'));
  assert.ok(!redactSecrets('redis://:secretpw@cache.example.com:6379').includes('secretpw'));
  assert.ok(!redactSecrets('mongodb+srv://user:p%40ss@cluster.mongodb.net/').includes('p%40ss'));
});

test('redactSecrets redacts GitHub fine-grained and variant PATs', () => {
  assert.ok(!redactSecrets('token github_pat_11ABCDEFGH' + 'ijklmnop').includes('github_pat_11'));
  assert.ok(!redactSecrets('gho_ABCDEFGH1234567890').includes('gho_ABCDEFGH1234567890'));
  assert.ok(!redactSecrets('ghr_ABCDEFGH1234567890').includes('ghr_ABCDEFGH1234567890'));
});

test('redactSecrets redacts github_pat_ prefix at ANY length', () => {
  // github_pat_ is itself a unique unforgeable prefix; a short fragment still leaks.
  assert.ok(!redactSecrets('github_pat_11Ab').includes('github_pat_11Ab'), 'short mixed-case fragment must be redacted');
});

test('redactSecrets redacts underscore-delimited API keys', () => {
  // The redaction targets (sk_/pk_/rk_ ... live/test/proj) must NOT appear
  // verbatim in source — GitHub push-protection flags real provider keys. Build
  // the input by concatenation so the literal prefix is never a contiguous token.
  const liveKey = 'sk' + '_live_' + 'abc123DEFghi456jklMNO';
  const projKey = 'sk' + '_proj_' + 'ABCDEFGHIJKLMNOPQRST';
  assert.ok(redactSecrets(liveKey).includes('‹secret›'), 'sk_..._live key must be redacted');
  assert.ok(redactSecrets(projKey).includes('‹secret›'), 'sk_..._proj key must be redacted');
});

test('redactSecrets redacts PEM private-key blocks', () => {
  const block = '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFA\n-----END PRIVATE KEY-----';
  const out = redactSecrets('env CERT="' + block + '" mycli');
  assert.ok(!out.includes('MIIBVgIBADANBgkqhkiG9w0BAQEFA'), 'PEM body must be redacted');
});

test('safeProcessLabel redacts a bare credential URL and never leaks it', () => {
  const label = safeProcessLabel('postgresql://admin:s3cr3t@db.example.com/app');
  assert.ok(!label.includes('s3cr3t'));
  assert.ok(!label.includes('postgresql://'), 'whole credential URL must be hidden');
  assert.ok(label.includes('(redacted command line)') || label.includes(REDACT_SECRET));
});

test('parseArgsLines reassembles embedded newlines in args', () => {
  const { parseArgsLines } = enumerateInternal;
  const stdout = '  415   claude --print "line one\nline two"\n  416   node server.js\n';
  const byPid = parseArgsLines(stdout);
  // The newline inside the quoted prompt must be preserved, not dropped or
  // mis-attributed to another PID.
  assert.equal(byPid.get(415), 'claude --print "line one\nline two"');
  assert.equal(byPid.get(416), 'node server.js');
});

// ---------------------------------------------------------------------------
// Status bar / summary formatting
// ---------------------------------------------------------------------------
test('status bar idle', () => {
  const fleet = { toolCount: 0, sessionCount: 0, tools: new Map() };
  assert.equal(summarizeStatusBar(fleet), '$(circle-slash) AI: idle');
});

test('status bar single tool shorthand uses short name', () => {
  const tools = new Map();
  tools.set('claude', { id: 'claude', displayName: 'Claude Code', sessions: [{}, {}, {}, {}] });
  const fleet = { toolCount: 1, sessionCount: 4, tools };
  // Short name is the first token of displayName ("Claude"), so the gate fires.
  assert.equal(summarizeStatusBar(fleet), '$(sync~spin) AI: Claude ×4');
});

test('status bar two tools uses short names so the 24-char gate fires', () => {
  // Regression: with the full displayName "Claude Code", the join
  // "Claude Code ×4 · Codex ×2" = 25 chars exceeded the 24-char gate and
  // silently collapsed to "2 tools · 6 sessions". Short names fix that.
  const tools = new Map();
  tools.set('claude', { id: 'claude', displayName: 'Claude Code', sessions: [{}, {}, {}, {}] });
  tools.set('codex', { id: 'codex', displayName: 'Codex', sessions: [{}, {}] });
  const fleet = { toolCount: 2, sessionCount: 6, tools };
  const s = summarizeStatusBar(fleet);
  assert.equal(s, '$(sync~spin) AI: Claude ×4 · Codex ×2');
});

test('status bar two short tools', () => {
  const tools = new Map();
  tools.set('claude', { id: 'claude', displayName: 'Claude', sessions: [{}, {}] });
  tools.set('codex', { id: 'codex', displayName: 'Codex', sessions: [{}] });
  const fleet = { toolCount: 2, sessionCount: 3, tools };
  const s = summarizeStatusBar(fleet);
  assert.ok(s.includes('Claude ×2'));
  assert.ok(s.includes('Codex ×1'));
});

test('status bar large fleet collapses to tool/session counts', () => {
  const tools = new Map();
  tools.set('a', { id: 'a', displayName: 'Alpha', sessions: [{}, {}, {}] });
  tools.set('b', { id: 'b', displayName: 'Beta', sessions: [{}, {}] });
  tools.set('c', { id: 'c', displayName: 'Gamma', sessions: [{}] });
  tools.set('d', { id: 'd', displayName: 'Delta', sessions: [{}, {}] });
  tools.set('e', { id: 'e', displayName: 'Epsilon', sessions: [{}] });
  const fleet = { toolCount: 5, sessionCount: 10, tools };
  const s = summarizeStatusBar(fleet);
  assert.ok(s.includes('5 tools'));
  assert.ok(s.includes('10 sessions'));
});

test('summarizeFleet aggregates totals', () => {
  const tools = new Map();
  const c = { id: 'claude', displayName: 'Claude', sessions: [{ processCount: 3 }, { processCount: 2 }] };
  const x = { id: 'codex', displayName: 'Codex', sessions: [{ processCount: 1 }] };
  tools.set('claude', c);
  tools.set('codex', x);
  const fleet = { toolCount: 2, sessionCount: 3, tools };
  const summary = summarizeFleet(fleet);
  assert.equal(summary.totalTools, 2);
  assert.equal(summary.totalSessions, 3);
  assert.equal(summary.totalProcesses, 6);
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
test('buildDiagnostics excludes prompt/secret data but includes topology', () => {
  const tools = compileTools(undefined);
  const fleet = buildFleet(FIX.realEvidence, tools);
  const diag = buildDiagnostics({
    version: '0.3.0',
    platform: 'win32',
    arch: 'x64',
    scope: 'local',
    tools,
    fleet,
    lastError: null,
    pollLatencyMs: 200,
    wslScanned: false
  });
  const text = diagnosticsAsText(diag);
  assert.ok(text.includes('0.3.0'));
  assert.ok(text.includes('win32'));
  assert.ok(!text.includes('SECRET PROMPT TEXT'), 'no prompts leak');
  // Sanitized session labels are present but never the raw prompt.
  assert.ok(diag.sessions.length >= 1);
});

// ---------------------------------------------------------------------------
// Enumeration (candidate names + safe path) — no live OS spawn here.
// ---------------------------------------------------------------------------
test('candidateProcessNames includes interpreter hosts and tool binaries', () => {
  const tools = compileTools(undefined);
  const names = candidateProcessNames(tools);
  for (const host of ['node.exe', 'node', 'sh.exe', 'sh', 'bash.exe', 'bash', 'python.exe', 'python', 'python3']) {
    assert.ok(names.has(host), `expected candidate host ${host}`);
  }
  assert.ok(names.has('claude.exe'));
  assert.ok(names.has('claude'));
});

test('listProcesses rejects unsupported platform without spawning', async () => {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true });
  try {
    const tools = compileTools(undefined);
    await assert.rejects(() => listProcesses(tools, () => {}), /Unsupported platform/);
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

// Regression: WQL/PowerShell injection via a hostile custom tool config must be
// impossible. Candidate process names are restricted to a safe charset before
// they can reach the WQL filter; anything with quotes/backticks/$/parens/control
// chars is rejected, so it can never break out of the query. (Found by an
// independent post-implementation adversarial reviewer as a SAFE-but-untested
// control.)
test('hostile candidate names are rejected and cannot inject into WQL/PowerShell', () => {
  const hostile = [
    'foo`bar',
    'evil$(x)',
    'a"b',
    "c'd",
    'weird\x07name',
    ')p(',
    'C:/x/y.exe',
    "'; Get-Process; #",
    'name; rm -rf /',
    '$(Invoke-WebRequest)'
  ];
  for (const n of hostile) {
    assert.equal(sanitizeCandidateName(n), null, `hostile name must be rejected: ${n}`);
  }

  // Even if a hostile name somehow reached buildWindowsScript, it must not appear
  // in the emitted filter (sanitizeCandidateName already returned null, so it is
  // dropped). Prove the safe names build a well-formed OR filter and hostile
  // payloads are absent. (The script legitimately contains PowerShell
  // variables like $filter, so we check only that hostile tokens are gone.)
  const script = buildWindowsScript(['claude.exe', 'node', 'ok.exe']);
  assert.ok(script.includes("Name='claude.exe'"));
  assert.ok(script.includes("Name='node'"));
  assert.ok(!script.includes('Get-Process'));
  assert.ok(!script.includes('Invoke-WebRequest'));

  // A script built purely from hostile input must be null (no WMI call at all).
  assert.equal(buildWindowsScript(hostile), null);
});

// --- Unix enumeration parse hardening (Wave-A audit, Tasks 2-4) ---

test('zombie paren comm (e.g. "(node)") is stripped to the bare name', () => {
  const { parseCommLines } = enumerateInternal;
  const byPid = parseCommLines('  123   1   (node)\n  124   1   (my process)\n');
  assert.equal(byPid.get(123).Name, 'node');
  assert.equal(byPid.get(124).Name, 'my process');
});

test('Linux unreadable cmdline "?" falls back to comm Name, not "?"', () => {
  const { parseCommLines, parseArgsLines } = enumerateInternal;
  const commByPid = parseCommLines('  200   1   node\n  201   1   code\n');
  const argsByPid = parseArgsLines('  200   node server.js\n  201   ?\n');
  // Replicate the listUnixProcesses merge semantics in the test.
  const rows = [];
  for (const [pid, row] of commByPid) {
    const args = argsByPid.get(pid);
    const commandLine = args && args !== '?' ? args : row.Name;
    rows.push({ ProcessId: pid, Name: row.Name, CommandLine: commandLine });
  }
  const nodeRow = rows.find((r) => r.ProcessId === 200);
  const codeRow = rows.find((r) => r.ProcessId === 201);
  assert.equal(nodeRow.CommandLine, 'node server.js');
  // '?' must NOT leak through as a CommandLine.
  assert.equal(codeRow.CommandLine, 'code');
});

test('parseArgsLines keeps the full remainder including leading spaces', () => {
  const { parseArgsLines } = enumerateInternal;
  const byPid = parseArgsLines('  415   /usr/lib/code/code --type=renderer   arg with spaces\n');
  assert.equal(byPid.get(415), '/usr/lib/code/code --type=renderer   arg with spaces');
});

test('parseCommLines tolerates a missing trailing token and skips blank lines', () => {
  const { parseCommLines } = enumerateInternal;
  const byPid = parseCommLines('\n  100   1   claude\n    0\n  101   1   node.exe\n');
  assert.ok(byPid.has(100));
  assert.ok(byPid.has(101));
  assert.equal(byPid.size, 2);
});
