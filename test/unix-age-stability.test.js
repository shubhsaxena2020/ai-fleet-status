'use strict';

// Regression: estimateUnixStartTimeMs must be STABLE per PID across calls so the
// derived session id does not flap between polls. A prior implementation read
// Date.now() minus a coarse-grained /proc/uptime on every call, letting the
// boot epoch drift by up to the uptime granularity and jittering the start time.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { estimateUnixStartTimeMs } = require('../lib/enumerate');

test('Unix start-time estimate is stable per PID and distinct across PIDs', () => {
  if (process.platform !== 'linux') {
    return; // /proc only on Linux; behavior unchanged elsewhere.
  }
  const a1 = estimateUnixStartTimeMs(process.pid);
  const a2 = estimateUnixStartTimeMs(process.pid);
  assert.equal(a1, a2, 'same PID must yield identical start time across polls (no session-id flap)');

  const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 50)'], { stdio: 'ignore' });
  try {
    const childStart = estimateUnixStartTimeMs(child.pid);
    assert.ok(childStart != null, 'child start time must be estimable');
    assert.ok(childStart > a1, 'child must start after parent');
  } finally {
    child.kill();
  }
});
