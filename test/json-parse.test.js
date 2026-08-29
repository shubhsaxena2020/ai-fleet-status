'use strict';

// Ported from the legacy test/unit.test.js (json-parse describe block) so the
// coverage survives retirement of lib/tool-config.js / lib/process-chains.js /
// lib/process-list.js (BACKLOG B1). Sourced from the LIVE lib/json-parse.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseJsonWithControlCharacterFallback,
  escapeRawControlCharactersInJsonStrings
} = require('../lib/json-parse');

describe('json-parse (live)', () => {
  test('parses well-formed JSON unchanged', () => {
    const input = '{"ProcessId":1234,"Name":"node.exe","CommandLine":"node app.js"}';
    assert.deepEqual(parseJsonWithControlCharacterFallback(input), {
      ProcessId: 1234,
      Name: 'node.exe',
      CommandLine: 'node app.js'
    });
  });

  test('recovers from a raw control character inside a string value', () => {
    // Input contains a raw 0x07 (BEL) character.
    const input = '{"CommandLine":"tool.exe \u0007 -p"}';
    const result = parseJsonWithControlCharacterFallback(input);
    // The result's value is the literal string containing the control char.
    assert.equal(result.CommandLine, 'tool.exe \u0007 -p');
  });

  test('recovers from multiple raw control characters across multiple string values', () => {
    const input = '{"Name":"a\u0001b","CommandLine":"c\u001Fd\u0000e"}';
    const result = parseJsonWithControlCharacterFallback(input);
    assert.equal(result.Name, 'a\u0001b');
    assert.equal(result.CommandLine, 'c\u001Fd\u0000e');
  });

  test('rethrows non-control-character JSON errors unchanged', () => {
    assert.throws(() => parseJsonWithControlCharacterFallback('{not json'), /JSON/);
  });

  test('[adversarial] preserves escaped backslashes and quotes adjacent to a control character', () => {
    // Raw input containing a literal 0x07.
    const raw = '{"Path":"C:\\\\tool.exe\u0007","Flag":"a\\"b"}';
    const escaped = escapeRawControlCharactersInJsonStrings(raw);
    // The output should have replaced \u0007 with the literal string "\\u0007".
    assert.ok(escaped.includes('\\u0007'), 'should contain escaped BEL');
    const result = JSON.parse(escaped);
    assert.equal(result.Path, 'C:\\tool.exe\u0007');
    assert.equal(result.Flag, 'a"b');
  });

  test('does not touch control-character-like sequences outside string values', () => {
    const input = '{\n  "ProcessId": 1\n}';
    assert.deepEqual(parseJsonWithControlCharacterFallback(input), { ProcessId: 1 });
  });
});
