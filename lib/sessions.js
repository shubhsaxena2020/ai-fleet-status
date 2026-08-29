'use strict';

const { ProcessGraph, Process } = require('./process-model');
const { detect, BUILTIN_DETECTORS } = require('./detect');
const enumerate = require('./enumerate');

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

// A small, stable, non-cryptographic hash for command-line fingerprints. We only
// need collision-resistance between two *different* invocation contents, not
// cryptographic strength, so a quick FNV-1a is sufficient and dependency-free.
function contentHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// Stable session identity. On Windows the id embeds the process CreationDate so a
// recycled PID is always distinguishable. On Unix/macOS `ps` does not give a
// creation timestamp, so `creationTime` is null and a PID-only id would collapse
// two different invocations that happen to share a PID at different polls.
//
// To disambiguate PID reuse on Unix WITHOUT a wall-clock creation timestamp, the
// caller may pass `startMs` — the real process start epoch (milliseconds) derived
// from `/proc/<pid>/stat` starttime (see `estimateUnixStartTimeMs`). This is the
// STRONGEST Unix signal: a still-running session keeps the SAME start time across
// polls (continuity preserved), while a PID reused by a NEW process gets a
// DIFFERENT start time, so even a reused PID with identical parent + argv stays
// distinct (closes the AFS-04 residual). macOS has no /proc, so `startMs` is null
// there and we fall through to the fingerprint / pollSeq tiers.
//
// When `startMs` is unavailable, callers pass a `fingerprint` (parent-PID +
// command-line content hash) for the live process. When present we embed it
// instead of the bare `?`, so two invocations with the same PID but different
// parent or argv stay distinct. This is correct for the NORMAL Unix case and
// preserves continuity of a still-running session across polls.
//
// Residual (AFS-04): when there is NO process data at all for the root (rootProc is
// null, so neither creationTime, startMs, nor a fingerprint is available), the id
// would otherwise collapse to a bare `?` — so two DIFFERENT invocations that reuse
// the same PID at different polls would share one id and one lifecycle cache entry,
// hiding a restart. To avoid that, callers may pass a monotonic `pollSeq`; in the
// `?` branch we embed `#<pollSeq>` so distinct polls get distinct ids (the audit's
// exact "PID reused before a creation timestamp exists" scenario). The trade-off:
// a still-running session with no process data is treated as new on each poll
// (continuity is sacrificed), but that is strictly preferable to MERGING two
// different invocations. The fully-degenerate case (same PID reused with identical
// everything AND no process data) remains acknowledged and documented in
// AUDIT_REPORT.md (AFS-04).
function sessionId(scope, toolId, rootPid, creationTime, fingerprint, pollSeq, startMs) {
  let t;
  if (creationTime != null) {
    t = String(creationTime);
  } else if (startMs != null && Number.isFinite(startMs)) {
    // Real Unix process start epoch (from /proc starttime). Strongest PID-reuse
    // disambiguator available without a wall-clock creation timestamp.
    t = `st${Math.round(startMs)}`;
  } else if (fingerprint != null && fingerprint !== '') {
    t = `fp:${fingerprint}`;
  } else if (pollSeq != null) {
    // No timestamp, no fingerprint: at least separate different polls so a reused
    // PID does not collapse two invocations into one id (AFS-04 mitigation).
    t = `?#${pollSeq}`;
  } else {
    t = '?';
  }
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
// Monotonic poll counter. Each buildFleet() call advances it. It is used ONLY as
// a last-resort session-id tiebreaker when neither a creation timestamp nor a
// process fingerprint is available (AFS-04): different polls then yield distinct
// ids, so a reused PID does not collapse two invocations into one cache entry.
let pollSeqCounter = 0;

function buildFleet(processes, detectors, options) {
  pollSeqCounter += 1;
  const pollSeq = pollSeqCounter;
  const opts = options || {};
  const includeServices = opts.includeServices !== false; // default true

  // Defensive: a null/undefined `detectors` (or a non-iterable) must NOT throw
  // `detectors is not iterable` — degrade to built-in detectors (consistent with
  // the tool-compilation fallback) so the poll still produces a fleet rather than
  // aborting. A caller may forget to pass detectors, or a prior step failed.
  const safeDetectors = Array.isArray(detectors) && detectors.length > 0
    ? detectors
    : (typeof BUILTIN_DETECTORS !== 'undefined' ? BUILTIN_DETECTORS : []);

  // Normalize input: accept either raw enumerate rows ({ProcessId, ParentProcessId,
  // Name, CommandLine, CreationDate, scope}) or already-constructed Process
  // instances. The production `poll()` path passes raw rows from listProcesses,
  // while some callers/tests pass Process objects. Both must work.
  // A null/undefined row must NOT throw (it would abort the whole fleet build —
  // the AFS-01 impact class). Skip it instead.
  const normalized = (processes || [])
    .filter((p) => p && typeof p === 'object')
    .map((p) =>
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
    const id = identify(proc, safeDetectors);
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
  for (const detector of safeDetectors) {
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
    // Without a creation timestamp (Unix/macOS):
    //   1. Prefer the REAL process start epoch from /proc/<pid>/stat (Linux only).
    //      This is the strongest PID-reuse disambiguator available without a
    //      wall-clock creation timestamp: a still-running session keeps the same
    //      start time across polls (continuity), while a reused PID gets a
    //      different start time, so even identical parent+argv reuse stays distinct
    //      (closes the AFS-04 residual). macOS has no /proc => startMs stays null.
    //   2. Fall back to a content fingerprint (parent PID + command-line hash) so
    //      PID reuse with different argv/parent is still distinguishable.
    let startMs = null;
    if (creationTime == null && rootProc) {
      startMs = enumerate.estimateUnixStartTimeMs(rootPid);
    }
    let fingerprint = null;
    if (creationTime == null && rootProc) {
      const argv = (rootProc.commandLine || rootProc.commandLineRaw || rootProc.name || '');
      fingerprint = `p${(rootProc.ppid != null ? rootProc.ppid : '?')}:${contentHash(argv)}`;
    }
    const sid = sessionId(rootProc && rootProc.scope, detector.id, rootPid, creationTime, fingerprint, pollSeq, startMs);

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
  const normalizedRows = rows || [];
  const processes = normalizedRows.map((r) => new Process(
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
