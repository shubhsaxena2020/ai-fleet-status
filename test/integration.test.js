'use strict';

// Real, safe, read-only integration probe for the actual OS enumerator.
// It runs lib/enumerate.listProcesses against the live machine (no spawning of
// AI agents, no killing, no config changes) and asserts the contract holds:
//   - returns an array of rows
//   - every row has numeric ProcessId / ParentProcessId and a string Name
//   - CommandLine key is always present (may be '' for rows without one)
//   - Windows rows carry a numeric CreationDate when the OS provides it
// This doubles as CI evidence that the platform enumerator actually works, not
// just the fixture logic.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { listProcesses, parseCimDateTime } = require('../lib/enumerate');
const { compileTools, detect } = require('../lib/detect');

test('live enumeration returns well-formed normalized rows', async () => {
  const tools = compileTools(undefined);
  const children = new Set();
  let rows = [];
  try {
    rows = await listProcesses(tools, (child) => {
      children.add(child);
      const remove = () => children.delete(child);
      child.once('exit', remove);
      child.once('error', remove);
    });
  } finally {
    for (const c of children) {
      try { c.kill(); } catch (_) { /* ignore */ }
    }
  }

  assert.ok(Array.isArray(rows), 'listProcesses must return an array');
  for (const r of rows) {
    assert.ok(typeof r.ProcessId === 'number' && r.ProcessId > 0, 'row ProcessId must be a positive number');
    assert.ok(typeof r.ParentProcessId === 'number', 'row ParentProcessId must be a number');
    assert.ok(typeof r.Name === 'string', 'row Name must be a string');
    assert.ok('CommandLine' in r, 'row must carry a CommandLine key');
  }

  // On Windows we expect CreationDate to be populated for at least the rows that
  // carry a real creation timestamp. We do not require it to be non-null for every
  // row (some platforms/rows legitimately lack it), only that WHEN present it is
  // a number.
  for (const r of rows) {
    if (r.CreationDate !== null && r.CreationDate !== undefined) {
      assert.ok(typeof r.CreationDate === 'number' && Number.isFinite(r.CreationDate),
        'CreationDate must be a numeric epoch when present');
    }
  }

  // Sanity: we can run the detector over real rows without throwing.
  let matched = 0;
  for (const r of rows) {
    if (detect(r, tools)) matched++;
  }
  console.log(`[integration] ${rows.length} candidate rows, ${matched} matched a configured tool on ${process.platform}.`);
});

test('parseCimDateTime parses the Windows CIM format used by the enumerator', () => {
  const t = parseCimDateTime('20260829012225.307915+000');
  assert.ok(typeof t === 'number' && Number.isFinite(t));
  const d = new Date(t);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 7); // August (0-indexed)
  assert.equal(d.getUTCDate(), 29);

  // Timezone offset UUU is SIGNED MINUTES, not HHMM hours. IST is UTC+5:30 = +330.
  const ist = parseCimDateTime('20260829120000.000000+330');
  const istDate = new Date(ist);
  // 12:00 IST == 06:30 UTC.
  assert.equal(istDate.getUTCHours(), 6);
  assert.equal(istDate.getUTCMinutes(), 30);

  // UTC-5 (e.g. EST) -> 12:00 local == 17:00 UTC.
  const est = parseCimDateTime('20260829120000.000000-300');
  const estDate = new Date(est);
  assert.equal(estDate.getUTCHours(), 17);

  assert.equal(parseCimDateTime(null), null);
  assert.equal(parseCimDateTime(''), null);
  assert.equal(parseCimDateTime('not-a-date'), null);
});

test('candidateProcessNames covers all built-in native and interpreter names', () => {
  const tools = compileTools(undefined);
  const names = require('../lib/enumerate').candidateProcessNames(tools);
  assert.ok(names instanceof Set, 'candidateProcessNames must return a Set');
  // Every configured native binary name must be a candidate.
  for (const t of tools) {
    for (const n of t.processNames) {
      assert.ok(names.has(n), `candidate set must include ${n} for ${t.id}`);
    }
  }
});
