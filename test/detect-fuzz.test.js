'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detect, compileTools } = require('../lib/detect');

// Simple deterministic PRNG (xorshift32) so the fuzz is reproducible across runs.
function xorshift32(seed) {
  return function() {
    let x = seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    seed = x;
    return x >>> 0;
  };
}

describe('detection: fuzzing with deterministic seed (D3)', () => {
  const detectors = compileTools([{ name: 'FuzzTool', processNames: ['fuzz.exe'], delegatedFlags: ['-p', '-i'] }]);
  const seed = 0xDEADBEEF;
  const rand = xorshift32(seed);
  const tokens = [
    'fuzz.exe', '-p', '-i', '--prompt', 'hello world', '"quoted arg"',
    'C:\\\\path\\\\to\\\\file.txt', '/home/user/file', 'node',
    'java', '-jar', 'app.jar', 'python', 'script.py',
    '\u0000', '\u0001', '\u001F', '\u007F', '\u0080', '\u00A0', '\u2029',
    'a'.repeat(1000), // long token
    ' ', '\t', '\n', '\r', // whitespace
  ];

  test('200 randomized command lines never cause detect() to throw', () => {
    for (let i = 0; i < 200; i++) {
      // Build a random command line by picking 1-8 tokens and joining with space
      const len = 1 + (rand() % 8);
      const parts = [];
      for (let j = 0; j < len; j++) {
        parts.push(tokens[rand() % tokens.length]);
      }
      const cmdline = parts.join(' ');
      const proc = { Name: 'fuzz.exe', CommandLine: cmdline };
      assert.doesNotThrow(() => detect(proc, detectors), `detect should not throw on cmdline: ${JSON.stringify(cmdline)}`);
      const result = detect(proc, detectors);
      assert.ok(result && typeof result === 'object', `detect should return an object, got ${result}`);
    }
  });

  test('detect auto-dispatches over an array of detectors', () => {
    const toolA = { id: 'A', processNames: new Set(['a.exe']) };
    const toolB = { id: 'B', processNames: new Set(['b.exe']) };
    const result = detect({ Name: 'a.exe', CommandLine: 'a.exe' }, [toolA, toolB]);
    assert.ok(result, 'detect should work when passed an array of detectors');
    assert.equal(result.toolId, 'A', 'should match the first detector in the array');
  });
});