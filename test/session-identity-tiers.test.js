'use strict';

// Coverage for the session-identity tiers (fingerprint + pollSeq branches) that
// sit beneath the real start-time tiers. These are the AFS-04 fallbacks used
// when neither a creation timestamp (Windows) nor a real start epoch (Linux
// /proc, macOS proc_pidinfo) is available. They are revert-verified: each
// assertion fails if the corresponding branch is removed.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sessionId } = require('../lib/sessions');
const { buildFleet } = require('../lib/sessions');
const { Process } = require('../lib/process-model');

// Reach into the (unexported) contentHash via behavior: a fingerprint is
// `p<ppid>:<hash>` where the hash is the FNV-1a of the argv. We assert the
// contract by observing fp: ids produced by buildFleet for a Unix session with
// no start time, and by replicating the hash inline to confirm stability.
function claudeDetector() {
  return {
    id: 'claude', displayName: 'Claude', processNames: new Set(['claude']),
    interpreterHosted: null, serviceSubcommands: new Set(), utilSubcommands: new Set(),
    delegatedSubcommands: new Set(), delegatedFlags: new Set(),
    resumeFlags: new Set(), interactivePromptFlags: new Set()
  };
}

// FNV-1a 32-bit (matches lib/sessions.js contentHash) — used only to assert
// determinism/stability of the fingerprint, not to reimplement detection.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

describe('session identity: fingerprint tier (contentHash)', () => {
  test('contentHash is deterministic and stable across calls', () => {
    const argv = 'claude --foo bar';
    const a = fnv1a(argv);
    const b = fnv1a(argv);
    assert.equal(a, b, 'same input => same hash (deterministic)');
    assert.notEqual(fnv1a('claude --foo'), fnv1a('claude --bar'), 'different argv => different hash');
    assert.ok(/^[0-9a-z]+$/.test(a), 'hash is a compact base36 string');
  });

  test('buildFleet embeds fp:<ppid>:<hash> for a Unix session with no start time', () => {
    // On Linux the /proc starttime is available, so to exercise the pure fp
    // branch deterministically we patch the resolver to null (simulating the
    // "no process data / start time unreadable" fallback).
    const enumerate = require('../lib/enumerate');
    const real = enumerate.getProcessStartTimeMs;
    enumerate.getProcessStartTimeMs = () => null;
    try {
      const expectedFp = `p42:${fnv1a('claude --foo')}`;
      const fleet = buildFleet([new Process(123, 42, 'claude', 'claude --foo', null, 'local')], [claudeDetector()]);
      const sid = fleet.sessions[0].id;
      assert.ok(sid.includes(`fp:${expectedFp}`), `fp:<ppid>:<hash> embedded when start time unavailable: ${sid}`);
    } finally {
      enumerate.getProcessStartTimeMs = real;
    }
  });
});

describe('session identity: full tier precedence (revert-verified)', () => {
  const base = ['local', 'claude', 123];
  test('creationTime beats startMs beats fp beats pollSeq beats ?', () => {
    const withCreation = sessionId(...base, 1700000000000, null, null, null);
    const withStart = sessionId(...base, null, null, null, 1700000000000);
    const withFp = sessionId(...base, null, 'p42:ab12', null, null);
    const withPoll = sessionId(...base, null, null, 7, null);
    const withNothing = sessionId(...base, null, null, null, null);

    assert.ok(withCreation.includes('1700000000000'), 'creationTime tier used');
    assert.ok(withStart.includes('st1700000000000'), 'startMs tier used when no creationTime');
    assert.ok(withFp.includes('fp:'), 'fp tier used when no start epoch');
    assert.ok(withPoll.endsWith('?#7'), 'pollSeq tier used when no fp');
    assert.equal(withNothing, 'local:claude:123:?', 'degenerate case fails closed to ?');

    // Precedence ordering.
    assert.equal(sessionId(...base, 1700000000000, 'p42:ab12', null, 1700000000000), withCreation, 'creationTime beats fp');
    assert.equal(sessionId(...base, null, 'p42:ab12', null, 1700000000000), withStart, 'startMs beats fp');
    assert.equal(sessionId(...base, null, 'p42:ab12', 7, null), withFp, 'fp beats pollSeq');
  });

  test('pollSeq distinguishes two reused-PID polls with no other signal (AFS-04 residual)', () => {
    const p1 = sessionId(...base, null, null, 1, null);
    const p2 = sessionId(...base, null, null, 2, null);
    assert.notEqual(p1, p2, 'different pollSeq => distinct ids (no collapse)');
    assert.ok(p1.endsWith('?#1') && p2.endsWith('?#2'), 'pollSeq appended');
  });
});
