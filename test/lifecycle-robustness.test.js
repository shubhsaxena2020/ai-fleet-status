'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SessionLifecycle } = require('../lib/lifecycle');

describe('lifecycle: reconcile robustness (C6)', () => {
  test('reconcile handles null/undefined fleet without throwing', () => {
    const life = new SessionLifecycle(() => 1000);
    
    assert.doesNotThrow(() => life.reconcile(null));
    assert.doesNotThrow(() => life.reconcile(undefined));
    assert.doesNotThrow(() => life.reconcile({}));
    assert.doesNotThrow(() => life.reconcile({ sessions: null }));
    assert.doesNotThrow(() => life.reconcile({ sessions: 'not-an-array' }));
    assert.doesNotThrow(() => life.reconcile({ sessions: [] }));
  });

  test('reconcile with null fleet reports all previously live sessions as ended', () => {
    const life = new SessionLifecycle(() => 1000);
    life.reconcile({ 
      sessions: [{ 
        id: 's1', 
        toolId: 'claude', 
        rootPid: 1, 
        mode: 'interactive' 
      }] 
    });
    assert.equal(life.seen.size, 1);
    
    life.reconcile(null);
    assert.equal(life.seen.size, 0, 'live session should be reported ended after null fleet');
    assert.equal(life.justEnded.length, 1, 'the dropped live session is reported as ended');
  });

  test('reconcile returns the fleet unchanged (or with annotations)', () => {
    const life = new SessionLifecycle(() => 1000);
    const fleet = { 
      toolCount: 0, 
      sessionCount: 0, 
      processCount: 0, 
      sessions: [],
      tools: new Map()
    };
    const result = life.reconcile(fleet);
    assert.ok(result);
  });
});