'use strict';

// Honest adversarial pass over the session-counting logic (per audit step 4):
// scenarios NOT already covered by the existing fixtures, designed to try to
// break the tool/session/process counts. Each is proven against the real
// lib/detect + lib/sessions implementation. These are DEFENSIVE (they pass
// today); they exist to catch regressions in the grouping algorithm.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compileTools } = require('../lib/detect');
const { buildFleet } = require('../lib/sessions');
const { estimateUnixStartTimeMs } = require('../lib/enumerate');
const { Process } = require('../lib/process-model');

const tools = compileTools(undefined);

function fleetFromRows(rows) {
  const procs = rows.map((r) => new Process(r.ProcessId, r.ParentProcessId, r.Name, r.CommandLine, null, 'local'));
  return buildFleet(procs, tools);
}

// 1) Real Windows subprocess chain 4 levels deep: conhost -> powershell -> cmd -> claude.
//    conhost.exe is NOT a candidate process (so its command line is never fetched),
//    yet the chain must still resolve and count exactly ONE claude session — not four,
//    and not zero.
test('4-level Windows chain conhost->powershell->cmd->claude counts exactly one session', () => {
  const rows = [
    { ProcessId: 10, ParentProcessId: 1, Name: 'conhost.exe', CommandLine: 'conhost.exe' },
    { ProcessId: 11, ParentProcessId: 10, Name: 'powershell.exe', CommandLine: 'powershell.exe' },
    { ProcessId: 12, ParentProcessId: 11, Name: 'cmd.exe', CommandLine: 'cmd.exe /c claude -p hi' },
    { ProcessId: 1001, ParentProcessId: 12, Name: 'claude.exe', CommandLine: 'claude.exe -p hi' }
  ];
  const fleet = fleetFromRows(rows);
  assert.equal(fleet.toolCount, 1, 'exactly one tool active');
  assert.equal(fleet.sessionCount, 1, 'exactly one session (not 4, not 0)');
  const session = fleet.sessions[0];
  // The session root must be the claude.exe process, not a shell wrapper.
  assert.equal(session.rootPid, 1001, 'root is the claude.exe process');
});

// 2) Two independent tool sessions under ONE shared shell, each launched via a
//    different node shim (qwen + claude) — must count TWO sessions, not one,
//    and neither must be swallowed by the other.
test('interleaved node shims of different tools under one shell => two sessions', () => {
  const rows = [
    { ProcessId: 50, ParentProcessId: 1, Name: 'bash', CommandLine: 'bash' },
    { ProcessId: 51, ParentProcessId: 50, Name: 'node', CommandLine: 'node /x/@qwen-code/qwen-code/cli.js' },
    { ProcessId: 52, ParentProcessId: 50, Name: 'node', CommandLine: 'node /x/@anthropic-ai/claude-code/cli.js' }
  ];
  const fleet = fleetFromRows(rows);
  assert.equal(fleet.toolCount, 2, 'qwen + claude both active');
  assert.equal(fleet.sessionCount, 2, 'two distinct sessions');
  const ids = fleet.sessions.map((s) => s.toolId).sort();
  assert.deepEqual(ids, ['claude', 'qwen']);
});

// 3) A tool process whose parent (same tool binary) has already exited and is
//    absent from the snapshot must still be its own root (dead-parent lookup
//    must not crash and must not merge it into a phantom).
test('orphaned tool process with missing parent is still exactly one root session', () => {
  const rows = [
    { ProcessId: 200, ParentProcessId: 100, Name: 'claude.exe', CommandLine: 'claude.exe' }
  ];
  const fleet = fleetFromRows(rows);
  assert.equal(fleet.sessionCount, 1);
  assert.equal(fleet.sessions[0].rootPid, 200);
});

// 4) Unix age stability: estimateUnixStartTimeMs must be STABLE across calls for
//    the same PID (so the session id does not flap between polls) and must
//    DIFFER for two different PIDs (so PID reuse is disambiguated). This guards
//    the AFS-04 residual limitation: on Linux the estimate now provides a real
//    start time, which must remain constant poll-to-poll.
test('Unix start-time estimate is stable per PID and distinct across PIDs', () => {
  if (process.platform !== 'linux') {
    return; // /proc only on Linux; behavior unchanged elsewhere.
  }
  const a1 = estimateUnixStartTimeMs(process.pid);
  const a2 = estimateUnixStartTimeMs(process.pid);
  assert.equal(a1, a2, 'same PID must yield identical start time across polls (no session-id flap)');

  // A child process started later has a strictly later start time than this one.
  const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 50)'], { stdio: 'ignore' });
  const childStart = estimateUnixStartTimeMs(child.pid);
  assert.ok(childStart != null, 'child start time must be estimable');
  assert.ok(childStart > a1, 'child must start after parent');
  child.kill();
});
