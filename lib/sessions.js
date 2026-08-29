'use strict';

const { ProcessGraph, Process } = require('./process-model');
const { detect } = require('./detect');

// ---------------------------------------------------------------------------
// Session grouping
//
// Definitions (now first-class, per the project brief):
//
//   TOOL          — one configured AI CLI (e.g. Claude Code).
//   SESSION       — one independent live invocation of a tool. Multiple
//                   independent invocations of the same tool are DISTINCT
//                   sessions. A session owns a root process and the whole
//                   process subtree beneath it (helpers, children, wrappers).
//   PROCESS COUNT — number of unique tool-owned/helper processes in a session
//                   (the root + every descendant). Helper processes do NOT each
//                   become a new session.
//
// Algorithm:
//   1. Enumerate -> normalized Process list -> ProcessGraph.
//   2. For each process, run identity detection. A process is a *member* if it
//      is an interactive/delegated session of some tool, or a process that we
//      detect is a tool's service/daemon (tracked separately).
//   3. Find session ROOTS: member processes that are NOT themselves descendants
//      of another member. They become the canonical owner of their subtree.
//   4. Build the session: root + all descendants. The unified tool/confidence is
//      the root's. We still expose per-process detail in the tree view.
//   5. Assign a stable session id = `${scope}:${toolId}:${rootPid}:${rootCreationTime}`
//      so a recycled PID cannot masquerade as a continuing session (Windows PID
//      reuse is real; CreationDate disambiguates where available).
//
// Shell/process wrappers (sh, bash, powershell, cmd, conhost, node that is NOT a
// tool script, python that is NOT a tool, etc.) appear inside a session's chain
// as ancestors/descendants but are not, by themselves, members; they never create
// fake sessions.
// ---------------------------------------------------------------------------

const SHELL_WRAPPER_NAMES = new Set([
  'sh.exe', 'sh', 'bash.exe', 'bash', 'zsh.exe', 'zsh', 'fish.exe', 'fish',
  'powershell.exe', 'pwsh.exe', 'pwsh', 'cmd.exe', 'conhost.exe'
]);

function isShellWrapper(process) {
  return SHELL_WRAPPER_NAMES.has((process.name || '').toLowerCase());
}

// Identify a single process against all detectors.
// Returns { detector, match } or null.
function identify(process, detectors) {
  for (const detector of detectors) {
    const match = detect(process, detector);
    if (match) {
      return { detector, match };
    }
  }
  return null;
}

// Stable session identity. If creationTime is unavailable we fall back to a
// purely pid/scope id but mark it as less stable (caller may still reconcile
// across polls by best-effort, see lifecycle reconciliation in extension.js).
function sessionId(scope, toolId, rootPid, creationTime) {
  const t = creationTime == null ? '?' : String(creationTime);
  return `${scope || 'local'}:${toolId}:${rootPid}:${t}`;
}

// Main entry: given the OS process rows (already normalized to `Process`) and the
// compiled detectors, return a Fleet summary.
//
// Output shape:
// {
//   tools: Map<toolId, {
//     id, displayName,
//     sessions: Session[],
//     services: ServiceProcess[],   // daemon/ACP/server modes, not sessions
//   }>,
//   processCount, sessionCount, toolCount,
//   totalMemberProcesses
// }
function buildFleet(processes, detectors, options) {
  const opts = options || {};
  const includeServices = opts.includeServices !== false; // default true

  // Normalize input: accept either raw enumerate rows ({ProcessId, ParentProcessId,
  // Name, CommandLine, CreationDate, scope}) or already-constructed Process
  // instances. The production `poll()` path passes raw rows from listProcesses,
  // while some callers/tests pass Process objects. Both must work.
  const normalized = (processes || []).map((p) =>
    (p && typeof p.pid === 'number')
      ? p
      : new Process(
          p.ProcessId,
          p.ParentProcessId,
          p.Name,
          p.CommandLine,
          p.CreationDate,
          p.scope || 'local'
        )
  );

  const graph = new ProcessGraph(normalized);

  // Detection pass over every process.
  // memberOf: pid -> { detector, match } for session members.
  // serviceOf: pid -> { detector, match } for service processes.
  const memberOf = new Map();
  const serviceOf = new Map();

  for (const proc of normalized) {
    const id = identify(proc, detectors);
    if (!id) {
      continue;
    }
    if (id.match.kind === 'service') {
      serviceOf.set(proc.pid, id);
    } else if (id.match.kind === 'session') {
      memberOf.set(proc.pid, id);
    }
  }

  // Determine session roots: a member that is NOT a descendant of any other
  // member. Compute descendant sets lazily via the graph.
  const memberPids = Array.from(memberOf.keys());
  const isDescendantOfAnotherMember = new Set();
  for (const pid of memberPids) {
    // Walk ancestors of pid; if any ancestor (other than pid itself) is a member,
    // then pid belongs to that ancestor's session, so pid is not a root.
    const anc = graph.ancestors(pid);
    for (let i = 1; i < anc.length; i++) {
      if (memberOf.has(anc[i].pid)) {
        isDescendantOfAnotherMember.add(pid);
        break;
      }
    }
  }

  const roots = memberPids.filter((pid) => !isDescendantOfAnotherMember.has(pid));

  // Group roots by tool.
  const toolsMap = new Map();
  for (const detector of detectors) {
    toolsMap.set(detector.id, {
      id: detector.id,
      displayName: detector.displayName,
      sessions: [],
      services: []
    });
  }

  const sessions = [];
  for (const rootPid of roots) {
    const { detector, match } = memberOf.get(rootPid);
    const rootProc = graph.get(rootPid);
    const subtreePids = [rootPid, ...graph.descendants(rootPid)];
    const members = [];
    let toolProcessCount = 0;

    for (const pid of subtreePids) {
      const proc = graph.get(pid);
      if (!proc) {
        continue;
      }
      const own = memberOf.get(pid);
      const isRoot = pid === rootPid;
      // A process is "tool-owned/helper" if it's a member of the same tool OR it
      // is a shell/launch wrapper directly under the root (the immediate ancestry
      // that the tool spawned). We count it toward process count but flag kind.
      const belongsToThisTool = own && own.detector.id === detector.id;
      const isWrapper = isShellWrapper(proc) || (proc.name && proc.name.match(/\.(exe|node|node\.exe|python|python3|python\.exe|deno|bun|uv|uvx)$/));
      if (belongsToThisTool || isWrapper || isRoot) {
        members.push(proc);
        if (belongsToThisTool) {
          toolProcessCount++;
        }
      }
    }

    const creationTime = rootProc && typeof rootProc.creationTime === 'number' ? rootProc.creationTime : null;
    const sid = sessionId(rootProc && rootProc.scope, detector.id, rootPid, creationTime);

    const session = {
      id: sid,
      toolId: detector.id,
      displayName: detector.displayName,
      rootPid,
      mode: match.mode || 'unknown',
      confidence: match.confidence,
      reason: match.reason,
      creationTime,
      scope: (rootProc && rootProc.scope) || 'local',
      members,
      processCount: members.length,
      toolOwnedCount: toolProcessCount,
      startAgeMs: creationTime != null ? Date.now() - creationTime : null,
      // Terminal correlation filled in by extension.js using VS Code terminals.
      terminal: null
    };

    toolsMap.get(detector.id).sessions.push(session);
    sessions.push(session);
  }

  // Services (daemon/server modes) — listed per tool but excluded from
  // session/process tallies.
  if (includeServices) {
    for (const [pid, { detector }] of serviceOf) {
      const proc = graph.get(pid);
      const t = toolsMap.get(detector.id);
      if (t && proc) {
        t.services.push({
          pid,
          name: proc.name,
          scope: proc.scope || 'local',
          commandLine: proc.commandLine
        });
      }
    }
  }

  let sessionCount = 0;
  let processCount = 0;
  let activeToolCount = 0;
  for (const t of toolsMap.values()) {
    if (t.sessions.length > 0) {
      activeToolCount++;
      sessionCount += t.sessions.length;
      for (const s of t.sessions) {
        processCount += s.processCount;
      }
    }
  }

  return {
    tools: toolsMap,
    sessions,
    toolCount: activeToolCount,
    sessionCount,
    processCount,
    // totalMemberProcesses = sum of toolOwnedCount across sessions (distinct AI
    // processes; wrappers excluded). Useful for the "X processes" fleet line.
    totalMemberProcesses: sessions.reduce((acc, s) => acc + s.toolOwnedCount, 0)
  };
}

// Convenience for tests: build fleet from a fixture of raw rows by coercing them
// into Process objects.
function buildFleetFromRows(rows, detectors, options) {
  const processes = rows.map((r) => new Process(
    r.ProcessId,
    r.ParentProcessId,
    r.Name,
    typeof r.CommandLine === 'string' ? r.CommandLine : '',
    typeof r.CreationDate === 'number' ? r.CreationDate : null,
    r.scope || 'local'
  ));
  return buildFleet(processes, detectors, options);
}

module.exports = {
  buildFleet,
  buildFleetFromRows,
  sessionId,
  isShellWrapper
};
