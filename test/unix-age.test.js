'use strict';

// Regression test: Unix/macOS sessions previously had NO age because `ps` gives
// no wall-clock creation time, so enumerate.js emitted `CreationDate: null` and
// buildFleet set `startAgeMs: null` — the status bar / Tree View showed an empty
// age for every Unix session while Windows showed a real one. We now estimate a
// real start time from /proc/<pid>/stat `starttime` (Linux) so Unix sessions get
// a genuine age.
//
// Proven to FAIL under the old code (estimateUnixStartTimeMs absent / returned
// null -> startAgeMs null) and PASS under the fix.

const { test } = require('node:test');
const assert = require('node:assert');

const { estimateUnixStartTimeMs } = require('../lib/enumerate');
const { compileTools } = require('../lib/detect');
const { buildFleetFromRows } = require('../lib/sessions');

const detectors = compileTools([
  { name: 'Claude Code', processNames: ['claude'], nodeIdentityFragments: ['@anthropic-ai/claude-code'], delegatedFlags: ['-p'], resumeSubcommands: ['--resume'] }
]);

test('estimateUnixStartTimeMs returns a finite epoch-ms start time for a live Linux PID', () => {
  // This test runs on the Linux VPS; skip gracefully where /proc is absent.
  if (process.platform !== 'linux') {
    return;
  }
  const ms = estimateUnixStartTimeMs(process.pid);
  assert.ok(typeof ms === 'number' && Number.isFinite(ms), 'expected a finite start time');
  const now = Date.now();
  assert.ok(ms <= now, `start time ${ms} should not be in the future (now ${now})`);
  // This node process started at most a few seconds ago; allow a generous window.
  assert.ok(now - ms < 60 * 1000, `start age implausibly large: ${now - ms}ms`);
});

test('estimateUnixStartTimeMs returns a time BEFORE now (positive age)', () => {
  if (process.platform !== 'linux') {
    return;
  }
  const ms = estimateUnixStartTimeMs(process.pid);
  assert.ok(ms != null);
  assert.ok(Date.now() - ms > 0, 'session must have a positive age');
});

test('buildFleet on Unix yields a non-null startAgeMs when a start time is estimable', () => {
  if (process.platform !== 'linux') {
    return;
  }
  const startMs = estimateUnixStartTimeMs(process.pid);
  assert.ok(startMs != null);
  // Build a single-session fleet annotated with the estimated creation time.
  const rows = [{
    ProcessId: process.pid,
    ParentProcessId: process.ppid || 1,
    Name: 'claude',
    CommandLine: 'claude',
    CreationDate: startMs
  }];
  const fleet = buildFleetFromRows(rows, detectors);
  assert.equal(fleet.sessionCount, 1, 'one session expected');
  const session = fleet.sessions[0];
  assert.ok(session.startAgeMs != null, 'Unix session must report an age, not null');
  assert.ok(session.startAgeMs >= 0, 'age must be non-negative');
  assert.ok(session.startAgeMs < 120 * 1000, `age implausibly large: ${session.startAgeMs}ms`);
});

test('buildFleet still yields startAgeMs null when no creation time is available (macOS / unreadable /proc)', () => {
  // Simulate the macOS code path: enumerate emits CreationDate null, no estimate.
  const rows = [{
    ProcessId: process.pid,
    ParentProcessId: process.ppid || 1,
    Name: 'claude',
    CommandLine: 'claude',
    CreationDate: null
  }];
  const fleet = buildFleetFromRows(rows, detectors);
  assert.equal(fleet.sessionCount, 1);
  assert.equal(fleet.sessions[0].startAgeMs, null, 'no CreationDate => no age (unchanged behavior)');
});
