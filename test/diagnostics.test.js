'use strict';

// Coverage for lib/diagnostics.js — the sanitized diagnostics object built for
// the output channel / clipboard. The core guarantee is that NO raw command line,
// prompt, or secret leaves buildDiagnostics: member labels are run through
// safeProcessLabel (program + subcommand only) and the whole structure is passed
// through sanitizeDiagnostics (secret redaction). These tests assert that
// guarantee and are revert-verified (a change that surfaced raw command lines or
// secrets would fail them).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnostics, diagnosticsAsText } = require('../lib/diagnostics');
const { buildFleet } = require('../lib/sessions');
const { Process } = require('../lib/process-model');

function claudeDetector() {
  return {
    id: 'claude', displayName: 'Claude', processNames: new Set(['claude']),
    interpreterHosted: null, serviceSubcommands: new Set(), utilSubcommands: new Set(),
    delegatedSubcommands: new Set(), delegatedFlags: new Set(),
    resumeFlags: new Set(), interactivePromptFlags: new Set()
  };
}

describe('diagnostics: buildDiagnostics sanitizes secrets and command lines', () => {
  test('member labels never contain the full command line or a secret', () => {
    const secretCmd = 'claude -p "my api_key=sk_live_abc123 secret prompt here"';
    const fleet = buildFleet([new Process(123, 42, 'claude', secretCmd, null, 'local')], [claudeDetector()]);

    const diag = buildDiagnostics({
      version: '0.3.6',
      platform: 'linux',
      arch: 'x64',
      scope: 'local',
      tools: [claudeDetector()],
      fleet,
      pollLatencyMs: 1234
    });

    // Find the session member label.
    assert.equal(diag.sessions.length, 1, 'one session reported');
    const member = diag.sessions[0].members[0];
    assert.ok(member, 'member present');
    assert.ok(member.label, 'label present');
    assert.ok(!member.label.includes('sk_live_abc123'), 'secret token redacted from label');
    assert.ok(!member.label.includes('secret prompt here'), 'raw prompt not leaked in label');
    // The label keeps at most program + subcommand (claude -p ...), not the tail.
    assert.ok(member.label.startsWith('claude'), 'label starts with the program');
  });

  test('the whole diagnostics object is secret-free (sanitizeDiagnostics applied)', () => {
    const secretCmd = 'claude -p "token github_pat_11ab2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6"';
    const fleet = buildFleet([new Process(123, 42, 'claude', secretCmd, null, 'local')], [claudeDetector()]);
    const diag = buildDiagnostics({
      version: '0.3.6', platform: 'linux', arch: 'x64', scope: 'local',
      tools: [claudeDetector()], fleet, pollLatencyMs: 10
    });
    const text = JSON.stringify(diag);
    assert.ok(!text.includes('github_pat_'), 'no GitHub PAT anywhere in the serialized diagnostics');
    assert.ok(!text.includes('claude -p "token'), 'no raw command-line tail in diagnostics');
  });

  test('diagnosticsAsText renders a readable summary without leaking secrets', () => {
    const secretCmd = 'claude -p "pw=postgres://user:pass@host:5432/db"';
    const fleet = buildFleet([new Process(123, 42, 'claude', secretCmd, null, 'local')], [claudeDetector()]);
    const diag = buildDiagnostics({
      version: '0.3.6', platform: 'linux', arch: 'x64', scope: 'local',
      tools: [claudeDetector()], fleet, pollLatencyMs: 10
    });
    const text = diagnosticsAsText(diag);
    assert.ok(text.includes('AI Fleet Status'), 'header present');
    assert.ok(text.includes('claude') || text.includes('Claude'), 'tool mentioned');
    assert.ok(!text.includes('postgres://'), 'DB connection string never rendered');
    assert.ok(!text.includes('pass@host'), 'credential never rendered');
  });

  test('buildDiagnostics tolerates an empty fleet (no throw)', () => {
    const emptyFleet = buildFleet([], [claudeDetector()]);
    assert.doesNotThrow(() => {
      const diag = buildDiagnostics({
        version: '0.3.6', platform: 'linux', arch: 'x64', scope: 'local',
        tools: [claudeDetector()], fleet: emptyFleet
      });
      assert.equal(diag.sessionCount, 0, 'empty fleet => zero sessions');
      const text = diagnosticsAsText(diag);
      assert.ok(text.includes('(none)'), 'no sessions rendered as (none)');
    });
  });
});
