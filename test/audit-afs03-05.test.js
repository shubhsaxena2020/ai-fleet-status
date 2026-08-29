'use strict';

// Regression tests for audit findings AFS-03, AFS-04, AFS-05.
// Each test is proven to FAIL under the old (buggy) behavior and PASS under the
// fix — see the commit that introduced this file.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SessionLifecycle, MAX_HISTORY } = require('../lib/lifecycle');
const { buildFleet, sessionId } = require('../lib/sessions');
const { Process } = require('../lib/process-model');
const { compileTools: legacyCompileTools } = require('../lib/tool-config');

// A minimal detector usable by buildFleet: any process whose name matches is a
// session of tool "claude", interactive mode.
function claudeDetector() {
  return {
    id: 'claude',
    displayName: 'Claude',
    processNames: new Set(['claude']),
    interpreterHosted: null,
    serviceSubcommands: new Set(),
    utilSubcommands: new Set(),
    delegatedSubcommands: new Set(),
    delegatedFlags: new Set(),
    resumeFlags: new Set(),
    interactivePromptFlags: new Set()
  };
}

describe('AFS-03: lifecycle trim must not evict live sessions', () => {
  test('51 active sessions => seen keeps all 51, none falsely re-reported as started', () => {
    const life = new SessionLifecycle(() => 1000);
    const ids = [];
    for (let i = 0; i < 51; i++) ids.push(`s${i}`);

    const fleet1 = { sessions: ids.map((id, idx) => ({ id, toolId: 'claude', rootPid: idx, mode: 'interactive' })) };
    life.reconcile(fleet1);

    // All 51 live sessions retained (no trim of live `seen`).
    assert.equal(life.seen.size, 51, 'live seen should hold all 51 active sessions');
    assert.equal(life.seen.has('s0'), true, 'oldest live session s0 must still be present');
    assert.equal(life.justStarted.length, 51, 'all 51 are new on first reconcile');
    assert.equal(life.justEnded.length, 0, 'nothing ended yet');

    // Next reconcile with the SAME 51 still alive: none should be re-reported as started.
    const fleet2 = { sessions: ids.map((id, idx) => ({ id, toolId: 'claude', rootPid: idx, mode: 'interactive' })) };
    life.reconcile(fleet2);
    assert.equal(life.justStarted.length, 0, 'a still-running session must NOT be reported as newly started');
    assert.equal(life.seen.has('s0'), true, 's0 still live after second poll');
  });

  test('ended sessions go to bounded history, live sessions untouched past the cap', () => {
    const life = new SessionLifecycle(() => 2000);
    // Start 60 sessions, then end 55 of them, leaving 5 live.
    const startIds = [];
    for (let i = 0; i < 60; i++) startIds.push(`x${i}`);
    life.reconcile({ sessions: startIds.map((id, idx) => ({ id, toolId: 'claude', rootPid: idx, mode: 'i' })) });

    const liveIds = ['x0', 'x1', 'x2', 'x3', 'x4'];
    life.reconcile({ sessions: liveIds.map((id, idx) => ({ id, toolId: 'claude', rootPid: idx, mode: 'i' })) });

    // 55 ended, bounded to MAX_HISTORY in history; live `seen` keeps exactly the 5.
    assert.equal(life.seen.size, 5, 'live seen must hold only the 5 still-running sessions');
    assert.equal(life.seen.has('x0'), true, 'live x0 retained');
    assert.ok(life.history.size <= MAX_HISTORY, 'ended history bounded to MAX_HISTORY');
    assert.equal(life.justEnded.length, 55, '55 sessions reported as ended');
  });
});

describe('AFS-04: session identity must not collapse two Unix invocations sharing a PID', () => {
  test('sessionId falls back to a content fingerprint (not bare "?") when creationTime is null', () => {
    const a = sessionId('local', 'claude', 123, null, 'p42:ab12');
    const b = sessionId('local', 'claude', 123, null, 'p99:cd34');
    assert.notEqual(a, b, 'same PID but different fingerprint => distinct session ids');
    assert.ok(a.includes('fp:'), 'fingerprint segment must be embedded (not "?")');
    assert.equal(sessionId('local', 'claude', 123, null), 'local:claude:123:?', 'no fingerprint => legacy "?" (fail-closed, documented)');
  });

  test('AFS-04 mitigation: a reused PID with no timestamp/fingerprint gets distinct ids per poll', () => {
    // The audit's exact residual: PID 123 reused "before a creation timestamp exists"
    // shares one id and one lifecycle cache entry, hiding a restart. With the
    // monotonic pollSeq tiebreaker, distinct polls yield DISTINCT ids.
    const reusedPoll1 = sessionId('local', 'claude', 123, null /* no creationTime */, null /* no fingerprint */, 1);
    const reusedPoll2 = sessionId('local', 'claude', 123, null, null, 2);
    assert.notEqual(reusedPoll1, reusedPoll2, 'reused PID across two polls must NOT collapse to one id');
    assert.ok(reusedPoll1.endsWith('?#1'), 'poll 1 embeds the poll-sequence tiebreaker');
    assert.ok(reusedPoll2.endsWith('?#2'), 'poll 2 embeds the poll-sequence tiebreaker');

    // Regression guard: the legacy no-pollSeq call still fails closed to "?".
    assert.equal(sessionId('local', 'claude', 123, null), 'local:claude:123:?', 'direct call without pollSeq stays legacy "?"');

    // Continuity preserved: a SAME-fingerprint invocation across polls keeps ONE id
    // (the normal Unix case is unaffected by the pollSeq tiebreaker).
    const same1 = sessionId('local', 'claude', 123, null, 'p42:ab12', 1);
    const same2 = sessionId('local', 'claude', 123, null, 'p42:ab12', 2);
    assert.equal(same1, same2, 'same fingerprint across polls keeps continuity (fp: path)');
  });

  test('buildFleet keeps two distinct Unix invocations of the same PID as separate sessions', () => {
    // Unix macOS/Linux: no CreationDate => creationTime null. Model PID reuse across
    // two separate polls: PID 123 dies and is later reused by a *different* invocation
    // (different parent + argv). Each poll is a fresh process list.
    const poll1 = [new Process(123, 42, 'claude', 'claude --foo', null, 'local')];
    const poll2 = [new Process(123, 77, 'claude', 'claude --bar', null, 'local')];

    const fleet1 = buildFleet(poll1, [claudeDetector()]);
    const fleet2 = buildFleet(poll2, [claudeDetector()]);

    assert.equal(fleet1.sessions.length, 1, 'poll1 has one session');
    assert.equal(fleet2.sessions.length, 1, 'poll2 has one session');

    const id1 = fleet1.sessions[0].id;
    const id2 = fleet2.sessions[0].id;
    assert.notEqual(id1, id2, 'PID reuse with different parent/argv => distinct session ids (no collapse)');
    assert.ok(id1.includes('fp:') && id2.includes('fp:'), 'fingerprint segment embedded for Unix sessions');

    // Sanity: identical parent+argv reusing the same PID, observed as the SAME real
    // process (same /proc starttime), keeps ONE id (continuity). The residual that
    // remains is "no process data at all" (rootProc null) — covered by the pollSeq
    // tiebreaker and the tests below.
    const poll3 = [new Process(123, 42, 'claude', 'claude --foo', null, 'local')];
    const fleet3 = buildFleet(poll3, [claudeDetector()]);
    assert.equal(fleet3.sessions[0].id, id1, 'identical parent+argv, same real process => same id (continuity, not flap)');
  });

  test('AFS-04 #17: reused PID with IDENTICAL parent+argv but a different /proc starttime yields DISTINCT ids', () => {
    // The prior residual: PID reuse with the same parent AND identical command line
    // still collapsed, hiding a restart. Adding the real process start epoch
    // (/proc/<pid>/stat starttime) as the identity tiebreaker splits it — a reused
    // PID is a NEW process with a NEW start time. We mock estimateUnixStartTimeMs so
    // the test is deterministic and independent of the host's real pids.
    const enumerate = require('../lib/enumerate');
    const real = enumerate.estimateUnixStartTimeMs;
    function pollWithStartMs(pid, ppid, argv, startMs) {
      enumerate.estimateUnixStartTimeMs = () => startMs;
      try {
        return buildFleet([new Process(pid, ppid, 'claude', argv, null, 'local')], [claudeDetector()]);
      } finally {
        enumerate.estimateUnixStartTimeMs = real;
      }
    }

    const id1 = pollWithStartMs(123, 42, 'claude --foo', 1700000000000).sessions[0].id;
    const id2 = pollWithStartMs(123, 42, 'claude --foo', 1700000005000).sessions[0].id; // same pid+parent+argv, NEW process

    assert.ok(id1.includes('st'), 'real start epoch embedded as st<ms> segment on Linux');
    assert.notEqual(id1, id2, 'reused PID with identical parent+argv but different starttime => DISTINCT ids (#17 fixed)');

    // Continuity: the SAME process across polls keeps ONE id (start time stable).
    const id1b = pollWithStartMs(123, 42, 'claude --foo', 1700000000000).sessions[0].id;
    assert.equal(id1, id1b, 'same process (same start time) across polls => same id (no flap)');
  });

  test('AFS-04 #17: sessionId embeds a real start epoch (st<ms>) when startMs is supplied', () => {
    // Unit-level proof (revert-verified: old code ignored startMs and produced '?').
    const a = sessionId('local', 'claude', 123, null, null, null, 1700000000000);
    const b = sessionId('local', 'claude', 123, null, null, null, 1700000005000);
    assert.equal(a, 'local:claude:123:st1700000000000', 'start epoch embedded as st<ms>');
    assert.notEqual(a, b, 'different start times => distinct ids even with identical pid/parent/argv');
    assert.equal(sessionId('local', 'claude', 123, null, null, null, 1700000000000), a, 'same start time => same id (continuity)');
    // startMs beats the fp: fallback tier (stronger signal).
    assert.equal(sessionId('local', 'claude', 123, null, 'p42:ab12', null, 1700000000000), a, 'startMs tier takes precedence over fp: tier');
  });
});

describe('AFS-05: legacy tool-config must not compile user regex (ReDoS)', () => {
  test('a malicious actionKeywords is treated as a literal, not an evil regex', () => {
    const [tool] = legacyCompileTools(
      [{ name: 'X', processNames: ['x.exe'], actionKeywords: ['(a+)+$'] }],
      false // untrusted user input
    );
    // The pattern is now the LITERAL string "(a+)+$", escaped, so it only matches that text.
    assert.equal(tool.actionRegex.test('x.exe (a+)+$'), true, 'literal match still works');
    assert.equal(tool.actionRegex.test('x.exe aaaa'), false, 'no longer a backtracking pattern');
  });

  test('the old ReDoS payload does not hang (bounded completion)', () => {
    const [tool] = legacyCompileTools(
      [{ name: 'X', processNames: ['x.exe'], actionKeywords: ['(a+)+$'] }],
      false
    );
    const killer = 'x.exe ' + 'a'.repeat(30) + '!';
    const start = Date.now();
    const result = tool.actionRegex.test(killer); // would hang for seconds under the old code
    const elapsed = Date.now() - start;
    assert.equal(result, false, 'malformed payload does not match');
    assert.ok(elapsed < 2000, `match returned in ${elapsed}ms (no ReDoS hang)`);
  });

  test('oversized keyword is rejected rather than compiled', () => {
    const huge = 'a'.repeat(5000);
    const [tool] = legacyCompileTools(
      [{ name: 'X', processNames: ['x.exe'], actionKeywords: [huge] }],
      false
    );
    // Empty alternation => fail-closed (never matches).
    assert.equal(tool.actionRegex.test('x.exe ' + huge), false);
  });

  test('trusted defaults still use real regex syntax (regression guard)', () => {
    const [tool] = legacyCompileTools(
      [{ name: 'Claude', processNames: ['claude'], actionKeywords: ['--print(?:=[^\s"\']*)?'] }],
      true
    );
    assert.equal(tool.actionRegex.test('claude --print="x"'), true, 'trusted regex pattern still works');
  });
});

// Adversarial-pass regression (AFS-03 area): SessionLifecycle.reconcile() must NOT
// throw on a null/undefined/malformed fleet. A bad fleet passed to reconcile would
// otherwise abort the whole poll (the AFS-01 impact class: one bad fleet kills
// detection/notification for ALL sessions). It now degrades to "no current
// sessions" instead of throwing.
describe('AFS-03 area: reconcile() tolerates null/undefined/malformed fleet', () => {
  test('reconcile(null/undefined/{}) does not throw', () => {
    for (const bad of [null, undefined, {}]) {
      const life = new SessionLifecycle(() => 1000);
      assert.doesNotThrow(() => life.reconcile(bad), `reconcile(${JSON.stringify(bad)}) must not throw`);
    }
    // And a previously-live session is reported ended (graceful degradation), not leaked.
    const life = new SessionLifecycle(() => 1000);
    life.reconcile({ sessions: [{ id: 'live1', toolId: 'claude', rootPid: 1, mode: 'interactive' }] });
    life.reconcile(null); // simulate a failed poll
    assert.equal(life.seen.has('live1'), false, 'live1 correctly reported ended after a failed poll');
    assert.equal(life.justEnded.length, 1, 'the dropped live session is reported as ended, not thrown');
  });
});
