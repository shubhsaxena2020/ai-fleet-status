'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { listWindowsProcesses } = require('../lib/enumerate');

// we want to test the rows that listWindowsProcesses returns

// Since listWindowsProcesses spawns a real powershell process, we can't easily
// mock it without a framework. Instead, we'll target the function it uses
// for final row shaping: normalizeRows.

const { _internal: { normalizeRows } } = require('../lib/enumerate');

describe('enumerate: normalizeRows robustness (C1)', () => {
  test('skips rows that are not objects', () => {
    const input = [
      { ProcessId: 101, Name: 'node.exe', CommandLine: 'node app.js' },
      null,
      undefined,
      'not an object',
      123,
      { ProcessId: 102, Name: 'bash.exe', CommandLine: 'bash' }
    ];
    const result = normalizeRows(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].ProcessId, 101);
    assert.equal(result[1].ProcessId, 102);
  });

  test('skips rows with missing or non-numeric PIDs', () => {
    const input = [
      { ProcessId: 'abc', Name: 'node.exe' },
      { ProcessId: null, Name: 'node.exe' },
      { ProcessId: undefined, Name: 'node.exe' },
      { ProcessId: -10, Name: 'node.exe' },
      { ProcessId: 0, Name: 'node.exe' },
      { ProcessId: 101, Name: 'node.exe' }
    ];
    const result = normalizeRows(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].ProcessId, 101);
  });

  test('coerces null/undefined Name and CommandLine to empty strings', () => {
    const input = [
      { ProcessId: 101, Name: null, CommandLine: undefined },
      { ProcessId: 102, Name: undefined, CommandLine: null },
      { ProcessId: 103, Name: 123, CommandLine: { a: 1 } } // wrong types
    ];
    const result = normalizeRows(input);
    assert.equal(result.length, 3);
    assert.equal(result[0].Name, '');
    assert.equal(result[0].CommandLine, '');
    assert.equal(result[1].Name, '');
    assert.equal(result[1].CommandLine, '');
    assert.equal(result[2].Name, '');
    assert.equal(result[2].CommandLine, '');
  });

  test('correctly parses CreationDate when present', () => {
    const input = [{
      ProcessId: 101,
      Name: 'node.exe',
      CreationDate: '20260829120000.000000+000'
    }];
    const result = normalizeRows(input);
    assert.ok(typeof result[0].CreationDate === 'number');
  });
});
