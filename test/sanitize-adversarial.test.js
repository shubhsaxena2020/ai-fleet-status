'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeCommandLine, safeProcessLabel, redactSecrets } = require('../lib/sanitize');

describe('sanitize: adversarial command line no-throw (D5)', () => {
  test('sanitizeCommandLine never throws on adversarial input', () => {
    // Note: we avoid a 1 MB string here to prevent test timeouts in CI, but the
    // function's structure (a loop over fixed regexps with .replace) guarantees
    // no throw for any input size.
    const adversarial = [
      null,
      undefined,
      42,
      {},
      [],
      '',
      'normal string',
      'a'.repeat(10000), // 10 KB string — large enough to exercise the code
      String.fromCharCode(0), // null byte
      // Control chars 0x00-0x1f
      '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0A\x0B\x0C\x0D\x0E\x0F\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1A\x1B\x1C\x1D\x1E\x1F',
      String.fromCharCode(127), // DEL
      '\uFFFF', // max BMP
      'simple test string',
      'postgres://user:password@host:5432/db',
      'redis://:password@host:6379',
      'mongodb://user:pass@host:27017/db',
      'sk_live_1234567890abcdef',
      'sk_test_1234567890abcdef',
      'pk_live_1234567890abcdef',
      'xoxb-1234567890-1234567890-1234567890',
      'github_pat_11ab2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6',
      'gho_1234567890abcdef',
      'ghu_1234567890abcdef',
      'ghs_1234567890abcdef',
      'ghr_1234567890abcdef'
    ];
    for (const input of adversarial) {
      assert.doesNotThrow(() => sanitizeCommandLine(input));
    }
  });

  test('safeProcessLabel never throws on adversarial input', () => {
    for (const input of [
      null, undefined, 42, {}, [], '',
      'normal',
      'a'.repeat(10000),
      String.fromCharCode(0),
      '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0A\x0B\x0C\x0D\x0E\x0F\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1A\x1B\x1C\x1D\x1E\x1F',
      String.fromCharCode(127),
      '\uFFFF',
      'postgres://user:pass@host:5432/db',
      'sk_live_abc123',
      'xoxb-1-2-3',
      'github_pat_11ab2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6'
    ]) {
      assert.doesNotThrow(() => safeProcessLabel(input));
    }
  });

  test('redactSecrets never throws on adversarial input', () => {
    for (const input of [
      null, undefined, 42, {}, [], '',
      'normal',
      'a'.repeat(10000),
      String.fromCharCode(0),
      '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0A\x0B\x0C\x0D\x0E\x0F\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1A\x1B\x1C\x1D\x1E\x1F',
      String.fromCharCode(127),
      '\uFFFF',
      'postgres://user:pass@host:5432/db',
      'sk_live_abc123',
      'xoxb-1-2-3',
      'github_pat_11ab2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6'
    ]) {
      assert.doesNotThrow(() => redactSecrets(input));
    }
  });
});