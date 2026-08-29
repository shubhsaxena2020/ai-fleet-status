'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detect } = require('../lib/detect');

describe('detect: robustness (C2)', () => {
  const tool = {
    id: 'test-tool',
    processNames: new Set(['test.exe']),
    delegatedFlags: new Set(['-p']),
    // other fields omitted for brevity; detectCisCrashes guards against them
  };

  test('detect returns null for null/undefined process rows', () => {
    assert.equal(detect(null, tool), null);
    assert.equal(detect(undefined, tool), null);
    assert.equal(detect(42, tool), null);
    assert.equal(detect('not-an-object', tool), null);
  });

  test('detect returns null for process rows missing both Name and CommandLine', () => {
    // Case 1: purely empty object
    assert.equal(detect({}, tool), null);
    // Case 2: only has unrelated fields
    assert.equal(detect({ ProcessId: 123 }, tool), null);
    // Case 3: both are null/undefined
    assert.equal(detect({ Name: null, CommandLine: undefined }, tool), null);
    assert.equal(detect({ Name: undefined, CommandLine: null }, tool), null);
  });

  test('detect still matches if only one of Name/CommandLine is present', () => {
    // Native match should work even if CommandLine is missing
    const matchNative = detect({ Name: 'test.exe', CommandLine: null }, tool);
    assert.ok(matchNative, 'should match native binary even without cmdline');
    assert.equal(matchNative.mode, 'unknown', 'mode should be unknown without cmdline');

    // Non-native match requires both (via interpreterHosted, not tested here with this tool)
  });
});
