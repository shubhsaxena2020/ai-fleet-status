'use strict';

// ===========================================================================
// DEPRECATED — superseded by lib/sessions.js + lib/process-model.js (the v0.3.0
// session/process pipeline). Retained ONLY for test/unit.test.js (the original
// 27 regression tests). Production code (extension.js) does NOT import it.
// Do not add new behavior here; update lib/sessions.js / lib/process-model.js.
// ===========================================================================

const SHELL_WRAPPER_NAMES = new Set(['sh.exe', 'sh', 'bash.exe', 'bash']);

// A process only ever becomes a "primary" match through a structural, hard-to-fake
// signal: either its own OS-reported Name IS one of the tool's real binary names, or
// it's node.exe/node and the tool's script/package name appears as a path-bounded
// fragment. Shell wrappers are deliberately never scanned for identity or action on
// their own - their command line is arbitrary wrapped text (e.g. an AI delegation
// prompt) that can coincidentally contain any tool's name or a look-alike flag. They
// can still appear in a displayed process chain, but only as a real parent of a
// process that matched on its own terms below.
function classifyPrimary(proc, tool) {
  const commandLine = typeof proc.CommandLine === 'string' ? proc.CommandLine : '';

  if (!commandLine) {
    return false;
  }

  const name = getProcessName(proc);

  if (SHELL_WRAPPER_NAMES.has(name)) {
    return false;
  }

  if (tool.processNames.has(name)) {
    return tool.actionRegex.test(commandLine);
  }

  if ((name === 'node.exe' || name === 'node') && tool.nodeIdentityRegex) {
    return tool.actionRegex.test(commandLine) && tool.nodeIdentityRegex.test(commandLine);
  }

  return false;
}

function buildTasksByTool(processes, tools) {
  const byPid = new Map();

  for (const proc of processes) {
    const pid = normalizePid(proc.ProcessId);

    if (pid) {
      byPid.set(pid, proc);
    }
  }

  const tasksByTool = new Map();

  for (const tool of tools) {
    const primaries = processes.filter((proc) => classifyPrimary(proc, tool));
    tasksByTool.set(tool.name, buildChains(primaries, byPid));
  }

  return tasksByTool;
}

function buildChains(primaries, byPid) {
  const chains = primaries.map((primary) => {
    const chain = [primary];
    const seen = new Set([normalizePid(primary.ProcessId)]);
    let current = primary;

    while (current) {
      const parentPid = normalizePid(current.ParentProcessId);

      if (!parentPid || seen.has(parentPid) || !byPid.has(parentPid)) {
        break;
      }

      const parent = byPid.get(parentPid);
      chain.unshift(parent);
      seen.add(parentPid);
      current = parent;
    }

    return chain;
  });

  // If one primary's ancestor chain is an exact element-wise prefix of a longer chain
  // (e.g. a shell -> node -> codex chain produces one chain per primary: [shell,node]
  // and [shell,node,codex]), keep only the longest - it's the same logical task, not
  // two separate ones. Compared as an array of PIDs, not a joined string: joined-string
  // prefix comparison has a real collision bug ("12,345,6".startsWith("12,34") is true
  // even though PID 34 and 345 are unrelated processes), which would wrongly drop a
  // genuinely independent chain that merely shares a numeric PID prefix.
  //
  // Separately, two chains of EQUAL length and identical PIDs (e.g. a duplicate row
  // for the same process from the underlying process listing) are not a prefix/suffix
  // pair of each other under the check above, so an exact-signature dedup runs first to
  // catch that case too - otherwise the same task would be shown twice.
  const seenSignatures = new Set();

  const deduped = chains.filter((chain) => {
    const signature = chain.map((proc) => normalizePid(proc.ProcessId)).join('>');

    if (seenSignatures.has(signature)) {
      return false;
    }

    seenSignatures.add(signature);
    return true;
  });

  return deduped
    .filter((chain, i) => {
      const pids = chain.map((proc) => normalizePid(proc.ProcessId));

      return !deduped.some((other, j) => {
        if (i === j) {
          return false;
        }

        const otherPids = other.map((proc) => normalizePid(proc.ProcessId));

        return otherPids.length > pids.length && pids.every((pid, idx) => pid === otherPids[idx]);
      });
    })
    .sort((left, right) => Number(normalizePid(left[0].ProcessId)) - Number(normalizePid(right[0].ProcessId)));
}

function getProcessName(proc) {
  return String(proc.Name || '').toLowerCase();
}

function normalizePid(value) {
  const pid = Number(value);

  if (!Number.isFinite(pid)) {
    return '';
  }

  return String(pid);
}

function formatProcessChain(processes) {
  const pids = processes.map((proc) => normalizePid(proc.ProcessId)).filter(Boolean);

  if (pids.length === 1) {
    return `PID ${pids[0]}`;
  }

  return `process chain ${pids.join(' > ')}`;
}

module.exports = {
  classifyPrimary,
  buildTasksByTool,
  buildChains,
  formatProcessChain,
  normalizePid
};
