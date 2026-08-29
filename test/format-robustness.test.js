'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeStatusBar, summarizeFleet } = require('../lib/format');

const EMPTY_SUMMARY = {
  activeTools: '',
  totalTools: 0,
  totalSessions: 0,
  totalProcesses: 0
};

describe('format: summarize robustness (C5)', () => {
  test('summarizeStatusBar returns idle for null/undefined/empty fleet', () => {
    assert.equal(summarizeStatusBar(null), '$(circle-slash) AI: idle');
    assert.equal(summarizeStatusBar(undefined), '$(circle-slash) AI: idle');
    assert.equal(summarizeStatusBar({}), '$(circle-slash) AI: idle');
    assert.equal(summarizeStatusBar({ toolCount: 0, tools: new Map() }), '$(circle-slash) AI: idle');
  });

  test('summarizeFleet returns empty object for null/undefined/empty fleet', () => {
    assert.deepEqual(summarizeFleet(null), EMPTY_SUMMARY);
    assert.deepEqual(summarizeFleet(undefined), EMPTY_SUMMARY);
    assert.deepEqual(summarizeFleet({}), EMPTY_SUMMARY);
    assert.deepEqual(summarizeFleet({ toolCount: 0, tools: new Map() }), EMPTY_SUMMARY);
  });

  test('summarizeFleet does not throw on malformed fleet', () => {
    assert.deepEqual(summarizeFleet({ toolCount: 1 }), EMPTY_SUMMARY);
  });
});