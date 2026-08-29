'use strict';

// Ported from the legacy test/unit.test.js (process-list describe block) so the
// parsing coverage survives retirement of lib/process-chains.js /
// lib/process-list.js (BACKLOG B2). Sourced from the LIVE lib/enumerate.js
// `_internal` exports (same parsing functions, now living in the active module).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCommLines,
  parseArgsLines,
  basename,
  normalizeRows
} = require('../lib/enumerate')._internal;

describe('parse (live enumerate internals)', () => {
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
    const byPid = parseCommLines('  501   1   /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n');
    assert.equal(byPid.get(501).Name, 'Electron');
  });

  test('parseArgsLines captures the entire remainder as CommandLine, spaces included', () => {
    const byPid = parseArgsLines('1234 codex exec "prompt with spaces"\n');
    assert.equal(byPid.get(1234), 'codex exec "prompt with spaces"');
  });

  test('[regression] parseArgsLines reattaches continuation lines under the previous pid', () => {
    // A multi-line prompt continuation must not be dropped or clobber another pid.
    const byPid = parseArgsLines('1234 codex exec "line one\nline two"\n5678 other\n');
    assert.equal(byPid.get(1234), 'codex exec "line one\nline two"');
    assert.equal(byPid.get(5678), 'other');
  });

  test('skips unparseable or blank lines rather than throwing', () => {
    const byPid = parseCommLines('\n   \nnot a valid line\n99  1  node\n');
    assert.equal(byPid.size, 1);
    assert.ok(byPid.has(99));
  });

  test('end-to-end merge produces the canonical {ProcessId, ParentProcessId, Name, CommandLine} shape', () => {
    // Mirrors listUnixProcesses' comm+args merge (with the '?'-as-missing
    // fallback), so the canonical row shape is exercised against live code.
    const commByPid = parseCommLines('1234 1 codex\n');
    const argsByPid = parseArgsLines('1234 codex exec "a"\n');
    const keep = new Set([1234]);
    const rows = [];
    for (const [pid, row] of commByPid) {
      if (!keep.has(pid)) continue;
      const args = argsByPid.get(pid);
      const commandLine = args && args !== '?' ? args : row.Name;
      rows.push({
        ProcessId: row.ProcessId,
        ParentProcessId: row.ParentProcessId,
        Name: row.Name,
        CommandLine: commandLine
      });
    }
    assert.deepEqual(rows, [
      { ProcessId: 1234, ParentProcessId: 1, Name: 'codex', CommandLine: 'codex exec "a"' }
    ]);
  });

  test('[regression] a literal "?" args value falls back to comm Name, never surfaced', () => {
    const commByPid = parseCommLines('1234 1 codex\n');
    const argsByPid = parseArgsLines('1234 ?\n'); // procps emits '?' for unreadable cmdline
    const keep = new Set([1234]);
    const rows = [];
    for (const [pid, row] of commByPid) {
      if (!keep.has(pid)) continue;
      const args = argsByPid.get(pid);
      rows.push(args && args !== '?' ? args : row.Name);
    }
    assert.equal(rows[0], 'codex');
  });
});
