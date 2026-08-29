'use strict';

// Revert-verified coverage for the macOS process-creation-time gap (close of the
// macOS branch of AFS-04). These tests mirror the AFS-04 #17 Linux tests: they
// FAIL under the old behavior (no macOS start time => session id collapses to
// fingerprint / "?" / pollSeq) and PASS once getMacOsProcessStartTime is wired
// into the same `startMs` session-id tier.
//
// macOS itself is unavailable in CI, so the darwin-path tests inject a fake
// spawnSync (and patch enumerate.getProcessStartTimeMs) — proving the parsing +
// wiring logic without needing an actual macOS process table.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { getMacOsProcessStartTime, getMacOsProcessStartTimeCore, parseLstart } = require('../lib/macos-starttime');
const enumerate = require('../lib/enumerate');
const { buildFleet, sessionId } = require('../lib/sessions');
const { Process } = require('../lib/process-model');

// A detector that matches the `node` binary (so we can build a real fleet).
function claudeDetector() {
  return {
    id: 'claude', displayName: 'Claude', processNames: new Set(['claude']),
    interpreterHosted: null, serviceSubcommands: new Set(), utilSubcommands: new Set(),
    delegatedSubcommands: new Set(), delegatedFlags: new Set(),
    resumeFlags: new Set(), interactivePromptFlags: new Set()
  };
}

describe('macOS start time: parseLstart (locale-pinned ps lstart)', () => {
  test('parses a C-locale lstart line into exact epoch ms', () => {
    // "Mon Aug 25 14:23:01 2026" -> Date.UTC(2026, 7, 25, 14, 23, 1)
    const ms = parseLstart('Mon Aug 25 14:23:01 2026');
    assert.equal(ms, Date.UTC(2026, 7, 25, 14, 23, 1), 'epoch ms must match the parsed wall time');
  });

  test('tolerates surrounding whitespace and no trailing newline', () => {
    const ms = parseLstart('  Tue Jan  6 00:00:00 1970  ');
    assert.equal(ms, Date.UTC(1970, 0, 6, 0, 0, 0));
  });

  test('returns null on unparseable / empty input (fail-closed, no throw)', () => {
    assert.equal(parseLstart(''), null);
    assert.equal(parseLstart('not a date'), null);
    assert.equal(parseLstart(null), null);
    assert.equal(parseLstart(undefined), null);
  });
});

describe('macOS start time: getMacOsProcessStartTime', () => {
  test('returns null on non-darwin platforms (no regression on Linux/Windows)', () => {
    // We are running on Linux in CI; the platform gate must short-circuit.
    if (process.platform === 'darwin') {
      return; // covered by the injected test below
    }
    assert.equal(getMacOsProcessStartTime(123), null, 'must short-circuit to null off darwin');
  });

  test('uses locale-pinned ps lstart via injected spawnSync (revert-verified)', () => {
    // Fake execFileSync returning a fixed lstart line. If the ps-fallback path is
    // removed/regressed, this returns null and the assertion fails.
    const fakeSpawn = () => Buffer.from('Mon Aug 25 14:23:01 2026\n');
    const ms = getMacOsProcessStartTimeCore(123, fakeSpawn);
    assert.equal(ms, Date.UTC(2026, 7, 25, 14, 23, 1), 'injected ps lstart must parse to epoch ms');
  });

  test('returns null when the injected spawn throws (process gone) — no throw', () => {
    const fakeSpawn = () => { throw new Error('ESRCH'); };
    assert.equal(getMacOsProcessStartTimeCore(99999, fakeSpawn), null, 'spawn failure degrades to null');
  });

  test('rejects invalid pid', () => {
    assert.equal(getMacOsProcessStartTimeCore(null, () => Buffer.from('Mon Aug 25 14:23:01 2026')), null);
    assert.equal(getMacOsProcessStartTimeCore(-1, () => Buffer.from('Mon Aug 25 14:23:01 2026')), null);
  });
});

describe('macOS start time: wired into session-id tiebreaker (mirrors AFS-04 #17)', () => {
  test('buildFleet embeds st<ms> from enumerate.getProcessStartTimeMs on macOS', () => {
    // Patch the dispatcher so the darwin path is exercised deterministically from
    // Linux CI. Revert the wiring (back to estimateUnixStartTimeMs only) and this
    // returns a /proc value or null, not 1700000000000 -> assertion fails.
    const real = enumerate.getProcessStartTimeMs;
    enumerate.getProcessStartTimeMs = () => 1700000000000;
    try {
      const fleet = buildFleet([new Process(123, 42, 'claude', 'claude', null, 'local')], [claudeDetector()]);
      const sid = fleet.sessions[0].id;
      assert.ok(sid.includes('st1700000000000'), `macOS start epoch must be embedded as st<ms>: ${sid}`);
    } finally {
      enumerate.getProcessStartTimeMs = real;
    }
  });

  test('sessionId embeds macOS start epoch (st<ms>) — unit-level revert proof', () => {
    const a = sessionId('local', 'claude', 123, null, null, null, 1700000000000);
    const b = sessionId('local', 'claude', 123, null, null, null, 1700000005000);
    assert.equal(a, 'local:claude:123:st1700000000000', 'macOS start epoch embedded as st<ms>');
    assert.notEqual(a, b, 'different start times => distinct ids even with identical pid/parent/argv');
    // startMs tier takes precedence over the fp: tier (stronger signal).
    assert.equal(sessionId('local', 'claude', 123, null, 'p42:ab12', null, 1700000000000), a,
      'startMs tier takes precedence over fp: tier');
  });

  test('AFS-04 macOS residual: reused PID, identical parent+argv, different start time => DISTINCT ids', () => {
    const real = enumerate.getProcessStartTimeMs;
    function pollWithStartMs(startMs) {
      enumerate.getProcessStartTimeMs = () => startMs;
      try {
        return buildFleet([new Process(123, 42, 'claude', 'claude --foo', null, 'local')], [claudeDetector()]);
      } finally {
        enumerate.getProcessStartTimeMs = real;
      }
    }
    const id1 = pollWithStartMs(1700000000000).sessions[0].id;
    const id2 = pollWithStartMs(1700000005000).sessions[0].id; // same pid+parent+argv, NEW process
    assert.ok(id1.includes('st'), 'real start epoch embedded as st<ms> segment');
    assert.notEqual(id1, id2, 'reused PID with identical parent+argv but different starttime => DISTINCT ids');
    // Continuity: same process across polls keeps one id.
    assert.equal(pollWithStartMs(1700000000000).sessions[0].id, id1, 'same process (same start time) => same id');
  });
});
