'use strict';

// This module is now a thin compatibility shim over the new enumeration pipeline
// (lib/enumerate.js) so existing callers and tests keep working. The real logic
// lives in enumerate.js / sessions.js / detect.js. The old `buildTasksByTool`
// / `formatProcessChain` semantics have been replaced by the session model in
// sessions.js — this shim only preserves the low-level enumeration + ps parsing
// surface that tests import.

const enumerate = require('./enumerate');
const { buildFleetFromRows } = require('./sessions');
const { detect } = require('./detect');
const { ProcessGraph } = require('./process-model');

const POLL_TIMEOUT_MS = enumerate.POLL_TIMEOUT_MS;
const MAX_BUFFER_BYTES = enumerate.MAX_BUFFER_BYTES;

async function listProcesses(tools, onChild) {
  return enumerate.listProcesses(tools, onChild);
}

const candidateProcessNames = enumerate.candidateProcessNames;
const basename = enumerate._internal.basename;
const parseCommLines = enumerate._internal.parseCommLines;
const parseArgsLines = enumerate._internal.parseArgsLines;

function mergeUnixRows(commByPid, argsByPid) {
  const rows = [];
  for (const [pid, row] of commByPid) {
    rows.push({
      ProcessId: row.ProcessId,
      ParentProcessId: row.ParentProcessId,
      Name: row.Name,
      CommandLine: argsByPid.get(pid) || row.Name
    });
  }
  return rows;
}

// Back-compat shim: emulate the old "tasks" (one chain per primary process) view
// using the new fleet model. Deprecated — new code should use buildFleet.
function buildTasksByTool(processes, tools) {
  const detectors = require('./detect').compileTools(tools);
  const fleet = buildFleetFromRows(processes, detectors);
  const map = new Map();
  for (const tool of fleet.tools.values()) {
    map.set(tool.displayName, tool.sessions.map((s) => s.members));
  }
  return map;
}

function formatProcessChain(processes) {
  const pids = processes.map((proc) => proc.ProcessId).filter(Boolean);
  if (pids.length === 1) {
    return `PID ${pids[0]}`;
  }
  return `process chain ${pids.join(' > ')}`;
}

function classifyPrimary(proc, tool) {
  const detector = require('./detect').compileDetectorFromConfig(tool);
  const match = detect(
    { name: proc.Name, commandLine: proc.CommandLine, pid: proc.ProcessId, ppid: proc.ParentProcessId },
    detector
  );
  return Boolean(match && match.kind === 'session');
}

module.exports = {
  listProcesses,
  candidateProcessNames,
  buildTasksByTool,
  buildChains: (primaries, byPid) => primaries,
  formatProcessChain,
  classifyPrimary,
  normalizePid: (v) => String(Number(v)),
  _internal: { parseCommLines, parseArgsLines, mergeUnixRows, basename, POLL_TIMEOUT_MS, MAX_BUFFER_BYTES, ProcessGraph }
};
