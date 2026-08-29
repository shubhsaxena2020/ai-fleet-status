'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseJsonWithControlCharacterFallback, escapeRawControlCharactersInJsonStrings } = require('../lib/json-parse');
const { compileTools, DEFAULT_TOOLS, boundedPathRegex } = require('../lib/tool-config');
const { classifyPrimary, buildTasksByTool, buildChains } = require('../lib/process-chains');
const { _internal: { parseCommLines, parseArgsLines, mergeUnixRows, basename } } = require('../lib/process-list');

describe('json-parse', () => {
  test('parses well-formed JSON unchanged', () => {
    const input = '{"ProcessId":1234,"Name":"node.exe","CommandLine":"node app.js"}';
    assert.deepEqual(parseJsonWithControlCharacterFallback(input), {
      ProcessId: 1234,
      Name: 'node.exe',
      CommandLine: 'node app.js'
    });
  });

  test('recovers from a raw control character inside a string value', () => {
    const input = '{"CommandLine":"tool.exe \u0007 -p"}';
    const result = parseJsonWithControlCharacterFallback(input);
    assert.equal(result.CommandLine, 'tool.exe \u0007 -p');
  });

  test('recovers from multiple raw control characters across multiple string values', () => {
    const input = '{"Name":"a\u0001b","CommandLine":"c\u001Fd\u0000e"}';
    const result = parseJsonWithControlCharacterFallback(input);
    assert.equal(result.Name, 'a\u0001b');
    assert.equal(result.CommandLine, 'c\u001Fd\u0000e');
  });

  test('rethrows non-control-character JSON errors unchanged', () => {
    assert.throws(() => parseJsonWithControlCharacterFallback('{not json'), /JSON/);
  });

  test('[adversarial] preserves escaped backslashes and quotes adjacent to a control character', () => {
    const raw = '{"Path":"C:\\\\Program Files\\\\tool.exe\u0007","Flag":"a\\"b"}';
    const escaped = escapeRawControlCharactersInJsonStrings(raw);
    const result = JSON.parse(escaped);
    assert.equal(result.Path, 'C:\\Program Files\\tool.exe\u0007');
    assert.equal(result.Flag, 'a"b');
  });

  test('does not touch control-character-like sequences outside string values', () => {
    // Whitespace between tokens must survive untouched.
    const input = '{\n  "ProcessId": 1\n}';
    assert.deepEqual(parseJsonWithControlCharacterFallback(input), { ProcessId: 1 });
  });
});

describe('tool-config', () => {
  test('compiles the built-in defaults without error', () => {
    const compiled = compileTools(DEFAULT_TOOLS, true);
    assert.equal(compiled.length, DEFAULT_TOOLS.length);
    assert.ok(compiled.every((tool) => tool.actionRegex instanceof RegExp));
  });

  test('drops malformed entries instead of throwing', () => {
    const compiled = compileTools([
      { name: 'Valid', processNames: ['x.exe'], actionKeywords: ['run'] },
      { name: '', processNames: ['y.exe'], actionKeywords: ['run'] },
      { name: 'NoProcessNames', processNames: [], actionKeywords: ['run'] },
      { name: 'NoKeywords', processNames: ['z.exe'], actionKeywords: [] },
      null
    ]);
    assert.equal(compiled.length, 1);
    assert.equal(compiled[0].name, 'Valid');
  });

  test('rejects non-array input rather than throwing', () => {
    assert.deepEqual(compileTools(undefined), []);
    assert.deepEqual(compileTools('not an array'), []);
  });

  test('action keyword matching is bounded, not substring', () => {
    const [tool] = compileTools([{ name: 'Codex', processNames: ['codex.exe'], actionKeywords: ['exec'] }]);
    assert.ok(tool.actionRegex.test('codex.exe exec "prompt"'));
    assert.equal(tool.actionRegex.test('codex.exe --mode=execute'), false);
  });

  test('[regression] Claude Code and Gemini CLI defaults match the attached --flag=value form', () => {
    const [claude, gemini] = compileTools(
      DEFAULT_TOOLS.filter((t) => t.name === 'Claude Code' || t.name === 'Gemini CLI'),
      true
    );
    assert.ok(claude.actionRegex.test('claude.exe --print="summarize this"'));
    assert.ok(gemini.actionRegex.test('gemini.exe --prompt="summarize this"'));
  });

  test('[regression] boundedPathRegex matches a fragment authored with "/" against a real backslash path', () => {
    // Fragments are authored with forward slashes for readability (e.g.
    // "bundle/gemini.js"), but a real Windows command line uses backslashes for that
    // same path segment. Both directions must match.
    const regex = boundedPathRegex(['bundle/gemini.js']);
    assert.ok(regex.test('node C:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js -p "x"'));
    assert.ok(regex.test('node /usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js -p "x"'));
  });
});

describe('process-chains', () => {
  const [codex, hermes] = compileTools([
    { name: 'Codex', processNames: ['codex.exe'], actionKeywords: ['exec'], nodeIdentityFragments: ['codex'] },
    { name: 'Hermes', processNames: ['hermes.exe'], actionKeywords: ['-z'] }
  ]);

  test('classifyPrimary matches native binary regardless of flag position', () => {
    assert.ok(classifyPrimary({ Name: 'codex.exe', CommandLine: 'codex.exe exec "prompt"' }, codex));
    assert.ok(classifyPrimary({ Name: 'codex.exe', CommandLine: 'codex.exe --config c.json exec' }, codex));
  });

  test('classifyPrimary rejects shell wrappers even if their text mentions a tool', () => {
    assert.equal(classifyPrimary({ Name: 'bash.exe', CommandLine: 'git commit -m "fix codex exec bug"' }, codex), false);
  });

  test('classifyPrimary matches node.exe only with both action flag and identity fragment', () => {
    assert.ok(classifyPrimary({ Name: 'node.exe', CommandLine: 'node C:\\tools\\codex\\bin\\codex.js exec' }, codex));
    assert.equal(classifyPrimary({ Name: 'node.exe', CommandLine: 'node server.js exec' }, codex), false);
  });

  test('[adversarial][regression] independent chains sharing a numeric PID prefix are not wrongly deduplicated', () => {
    // Chain A: 12 -> 34 (primary Codex). Chain B: 12 -> 345 -> 6 (primary Hermes).
    // Joined-as-string PID comparison ("12,345,6".startsWith("12,34")) previously
    // treated B as a superset of A and dropped A, even though PID 34 and 345 are
    // unrelated processes that only share a numeric prefix.
    const processes = [
      { ProcessId: 12, ParentProcessId: 0, Name: 'bash.exe', CommandLine: 'bash' },
      { ProcessId: 34, ParentProcessId: 12, Name: 'codex.exe', CommandLine: 'codex.exe exec "a"' },
      { ProcessId: 345, ParentProcessId: 12, Name: 'bash.exe', CommandLine: 'bash' },
      { ProcessId: 6, ParentProcessId: 345, Name: 'hermes.exe', CommandLine: 'hermes.exe -z "b"' }
    ];

    const byPid = new Map(processes.map((p) => [String(p.ProcessId), p]));
    const codexChains = buildChains(processes.filter((p) => classifyPrimary(p, codex)), byPid);
    const hermesChains = buildChains(processes.filter((p) => classifyPrimary(p, hermes)), byPid);

    assert.equal(codexChains.length, 1, 'Codex chain [12,34] must survive deduplication');
    assert.equal(hermesChains.length, 1, 'Hermes chain [12,345,6] must survive deduplication');
  });

  test('a genuine prefix chain (shell -> node -> binary) collapses to one task', () => {
    const processes = [
      { ProcessId: 1, ParentProcessId: 0, Name: 'bash.exe', CommandLine: 'bash' },
      { ProcessId: 2, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node codex.js exec' },
      { ProcessId: 3, ParentProcessId: 2, Name: 'codex.exe', CommandLine: 'codex.exe exec' }
    ];
    const byPid = new Map(processes.map((p) => [String(p.ProcessId), p]));
    const primaries = processes.filter((p) => classifyPrimary(p, codex));
    const chains = buildChains(primaries, byPid);
    assert.equal(chains.length, 1);
  });

  test('buildTasksByTool reports idle tools as an empty array, not missing', () => {
    const tasksByTool = buildTasksByTool([], [codex, hermes]);
    assert.deepEqual(tasksByTool.get('Codex'), []);
    assert.deepEqual(tasksByTool.get('Hermes'), []);
  });

  test('[regression] two identical-length duplicate chains for the same process are deduplicated', () => {
    // Simulates a duplicate row for the same PID coming back from the underlying
    // process listing (e.g. a transient WMI/ps double-read) - the two resulting
    // "primary" entries produce two chains of equal length and identical PIDs, which
    // the earlier prefix-only comparison did not catch (neither is a strict prefix of
    // the other since they're the same length).
    const dup = { ProcessId: 34, ParentProcessId: 12, Name: 'codex.exe', CommandLine: 'codex.exe exec "a"' };
    const byPid = new Map([[String(dup.ProcessId), dup]]);
    const chains = buildChains([dup, { ...dup }], byPid);
    assert.equal(chains.length, 1);
  });
});

describe('process-list (cross-platform ps parsing)', () => {
  test('basename extracts the executable name from a full path (macOS/BSD comm)', () => {
    assert.equal(basename('/opt/homebrew/bin/node'), 'node');
    assert.equal(basename('/Applications/Visual Studio Code.app/Contents/MacOS/Electron'), 'Electron');
  });

  test('basename is a no-op for an already-bare name (Linux/procps comm)', () => {
    assert.equal(basename('node'), 'node');
  });

  test('parseCommLines merges pid/ppid/name from a "pid ppid comm" listing', () => {
    const byPid = parseCommLines('  1234    1   codex\n   42     1   sh\n');
    assert.deepEqual(byPid.get(1234), { ProcessId: 1234, ParentProcessId: 1, Name: 'codex' });
    assert.deepEqual(byPid.get(42), { ProcessId: 42, ParentProcessId: 1, Name: 'sh' });
  });

  test('[regression] parseCommLines extracts a basename even when the full path contains spaces', () => {
    // BSD/macOS ps reports comm as a full path, and real paths there routinely contain
    // spaces (app bundle names). A naive "split on whitespace" parse would otherwise
    // treat the space inside the path as the boundary between the name and args.
    const byPid = parseCommLines('  501   1   /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n');
    assert.equal(byPid.get(501).Name, 'Electron');
  });

  test('parseArgsLines captures the entire remainder as CommandLine, spaces included', () => {
    const byPid = parseArgsLines('1234 codex exec "prompt with spaces"\n');
    assert.equal(byPid.get(1234), 'codex exec "prompt with spaces"');
  });

  test('mergeUnixRows falls back CommandLine to Name when a pid has no args entry', () => {
    const commByPid = parseCommLines('42   1   sh\n');
    const rows = mergeUnixRows(commByPid, new Map());
    assert.equal(rows[0].CommandLine, 'sh');
  });

  test('skips unparseable or blank lines rather than throwing', () => {
    const byPid = parseCommLines('\n   \nnot a valid line\n99  1  node\n');
    assert.equal(byPid.size, 1);
    assert.ok(byPid.has(99));
  });

  test('end-to-end merge produces the canonical {ProcessId, ParentProcessId, Name, CommandLine} shape', () => {
    const commByPid = parseCommLines('1234 1 codex\n');
    const argsByPid = parseArgsLines('1234 codex exec "a"\n');
    assert.deepEqual(mergeUnixRows(commByPid, argsByPid), [
      { ProcessId: 1234, ParentProcessId: 1, Name: 'codex', CommandLine: 'codex exec "a"' }
    ]);
  });
});
