'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildFleet, buildFleetFromRows } = require('../lib/sessions');

describe('sessions: buildFleet robustness (C3)', () => {
  const mockDetectors = [{ id: 't1', displayName: 'T1', processNames: new Set(['t1.exe']) }];

  test('buildFleet handles null/undefined/empty processes without throwing', () => {
    const result = buildFleet(null, mockDetectors);
    assert.equal(result.toolCount, 0);
    assert.equal(result.sessionCount, 0);
    assert.equal(result.processCount, 0);
    assert.ok(result.tools.has('t1'));
    assert.deepEqual(result.tools.get('t1'), { id: 't1', displayName: 'T1', sessions: [], services: [] });
  });

  test('buildFleet handles null/undefined detectors by falling back to built-ins', () => {
    const result = buildFleet([{ ProcessId: 1, Name: 'node.exe', CommandLine: 'node' }], null);
    assert.ok(result && typeof result === 'object');
    assert.ok(result.tools.size > 0, 'should contain built-in detectors');
  });

  test('buildFleetFromRows handles null/undefined input gracefully', () => {
    const result = buildFleetFromRows(null, mockDetectors);
    assert.equal(result.toolCount, 0);
    assert.equal(result.sessionCount, 0);
    assert.equal(result.processCount, 0);
    assert.ok(result.tools.has('t1'));
    assert.deepEqual(result.tools.get('t1'), { id: 't1', displayName: 'T1', sessions: [], services: [] });
  });
});
