'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detect } = require('../lib/detect');
const { BUILTIN_DETECTORS } = require('../lib/detect');

describe('detection: all built-in detectors recognize bare interactive invocation (D1)', () => {
  test('each of the ' + BUILTIN_DETECTORS.length + ' built-in detectors flags its native binary as a session (not idle) when invoked with no flags', () => {
    for (const detector of BUILTIN_DETECTORS) {
      // Test each native binary the detector recognizes
      for (const procName of detector.processNames) {
        // Command line with just the binary (no flags) should be recognized as a session
        const result = detect({ Name: procName, CommandLine: procName }, detector);
        assert.ok(result, `${detector.displayName} should recognize ${procName} as a session`);
        assert.equal(result.kind, 'session', `${detector.displayName} ${procName} should be kind session`);
        assert.equal(result.mode, 'interactive', `${detector.displayName} ${procName} with no flags should be interactive mode`);
      }
    }
  });
});