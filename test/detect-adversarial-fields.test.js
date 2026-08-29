'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detect } = require('../lib/detect');

describe('detection: adversarial missing-field hardening (D4)', () => {
  const validDetector = {
    id: 'test',
    processNames: new Set(['test.exe']),
    delegatedFlags: new Set(['-p'])
  };

  test('detect handles missing/null/undefined fields in the process row', () => {
    // These should all return null instead of throwing
    const cases = [
      {},
      { Name: null },
      { Name: undefined },
      { CommandLine: null },
      { CommandLine: undefined },
      { Name: null, CommandLine: undefined },
      { Name: 'test.exe', CommandLine: null },
      { Name: null, CommandLine: 'test.exe -p' },
      { Name: 'test.exe', CommandLine: '' },
      { Name: '', CommandLine: 'test.exe -p' }
    ];
    for (const proc of cases) {
      assert.doesNotThrow(() => detect(proc, validDetector));
      const result = detect(proc, validDetector);
      // We don't assert on the result value here — just that it doesn't throw.
      // Some of these may actually match (e.g. Name:'' is unlikely to match any processNames)
    }
  });

  test('detect handles malformed detector objects without throwing', () => {
    const malformedDetectors = [
      null,
      undefined,
      {},
      { id: 'x' }, // missing processNames
      { processNames: [] }, // missing id
      { id: 'x', processNames: 'not-a-set' }, // processNames not a Set
      { id: 'x', processNames: new Set(['x.exe']), delegatedFlags: 'not-a-set' },
      { id: 'x', processNames: new Set(['x.exe']), delegatedFlags: null },
      { id: 'x', processNames: new Set(['x.exe']), delegatedFlags: undefined }
    ];
    for (const det of malformedDetectors) {
      assert.doesNotThrow(() => detect({ Name: 'test.exe', CommandLine: 'test.exe' }, det));
    }
  });

  test('detect handles detector with missing interpreterHosted fields (AFS-01 area)', () => {
    // These are the specific shapes that used to throw in detectOne before the AFS-01 robustness fix.
    const badHosts = [
      { interpreterHosted: ['oops'] }, // array of strings instead of objects
      { interpreterHosted: [{}] }, // missing interpreter/fragments
      { interpreterHosted: [{ interpreters: 'node' }] }, // scalar interpreters
      { interpreterHosted: [{ fragments: ['hermes'] }] }, // missing interpreters
      { interpreterHosted: [{ interpreter: [], fragments: [] }] } // empty arrays
    ];
    for (const host of badHosts) {
      const detector = { ...validDetector, interpreterHosted: host.interpreterHosted };
      assert.doesNotThrow(() => detect({ Name: 'node.exe', CommandLine: 'node server.js' }, detector));
    }
  });
});