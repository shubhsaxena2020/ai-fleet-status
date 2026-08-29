'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TerminalCorrelator } = require('../lib/terminal');
const { ProcessGraph, Process } = require('../lib/process-model');

describe('terminal: correlate robustness (C4)', () => {
  let correlator;
  let graph;

  beforeEach(() => {
    correlator = new TerminalCorrelator();
    // Graph: 100 (bash) -> 101 (node)
    graph = new ProcessGraph([
      new Process(100, 0, 'bash.exe', 'bash', null, 'local'),
      new Process(101, 100, 'node.exe', 'node app.js', null, 'local')
    ]);
  });

  test('correlate returns undefined for null/undefined graph', () => {
    assert.equal(correlator.correlate(null, 123), undefined);
    assert.equal(correlator.correlate(undefined, 123), undefined);
    assert.equal(correlator.correlate({ no: 'graph' }, 123), undefined);
  });

  test('correlate returns undefined when no terminals are registered', () => {
    assert.equal(correlator.correlate(graph, 123), undefined);
  });

  test('correlate returns undefined when sessionRootPid is not in the graph', () => {
    assert.equal(correlator.correlate(graph, 999), undefined);
  });

  test('correlate returns undefined when sessionRootPid is in graph but has no terminal ancestor', () => {
    assert.equal(correlator.correlate(graph, 101), undefined);
  });

  test('correlate returns terminal info when session root IS the terminal shell', () => {
    correlator.terminalsByShellPid.set(100, { name: 'Terminal 1', integrated: true });
    const result = correlator.correlate(graph, 100);
    assert.ok(result);
    assert.equal(result.name, 'Terminal 1');
    assert.equal(result.integrated, true);
  });

  test('correlate returns terminal info when terminal is an ancestor of session root', () => {
    correlator.terminalsByShellPid.set(100, { name: 'Terminal 1', integrated: true });
    const result = correlator.correlate(graph, 101);
    assert.ok(result);
    assert.equal(result.name, 'Terminal 1');
  });
});