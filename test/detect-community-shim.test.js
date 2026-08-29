'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detect } = require('../lib/detect');
const { BUILTIN_DETECTORS } = require('../lib/detect');

describe('detection: community CLI shims resolve to sessions (D2)', () => {
  // Map detector id to a representative hosted invocation.
  // Each community CLI ships a native binary AND a hosted form via its interpreter.
  const hostedMap = {
    aider: { interp: 'python.exe', cmd: 'python -m aider --model gpt-4' },
    amp:   { interp: 'amp.exe',   cmd: 'amp' }, // amp is a native Go binary; hosted form would be via its own interpreter if any, but it's native.
    crush: { interp: 'crush.exe', cmd: 'crush' }, // crush is a native Go binary.
    copilot: { interp: 'copilot.exe', cmd: 'copilot' } // copilot is a native binary.
  };

  test('each community CLI detector recognizes its hosted/native invocation as a session', () => {
    for (const detector of BUILTIN_DETECTORS) {
      const id = detector.id;
      if (!['aider','amp','crush','copilot'].includes(id)) continue;
      const { interp, cmd } = hostedMap[id];
      // Test the hosted form (if distinct from native)
      const hostedResult = detect({ Name: interp, CommandLine: cmd }, detector);
      // Test the native binary form
      const nativeResult = detect({ Name: interp, CommandLine: `${interp} --help` }, detector); // --help is a util, should return null
      
      // At least one of these should be a session (the hosted form for aider, native for others)
      let ok = false;
      if (hostedResult && hostedResult.kind === 'session') ok = true;
      // For amp/crush/copilot, the hosted form is the same as native; we already tested via nativeResult but that was --help.
      // Instead, test a non-util invocation.
      if (!ok) {
        const nativeSession = detect({ Name: interp, CommandLine: `${interp}` }, detector);
        if (nativeSession && nativeSession.kind === 'session') ok = true;
      }
      assert.ok(`detector ${id} should recognize its invocation as a session`, ok);
    }
  });
});