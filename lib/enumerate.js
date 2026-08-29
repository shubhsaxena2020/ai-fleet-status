'use strict';

const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const { parseJsonWithControlCharacterFallback } = require('./json-parse');

const POLL_TIMEOUT_MS = 8000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// Process names we enumerate are restricted to a SAFE character set. Anything
// outside it cannot be a real OS process image name and is rejected before it can
// ever reach a WQL filter or PowerShell string — this is the primary defense
// against WQL/PowerShell injection from a malicious aiFleetStatus.tools entry.
// A Windows image name is `[A-Za-z0-9_-]` plus a `.exe` extension; POSIX names
// are `[A-Za-z0-9._/-]`. We accept the union and require a dot-basename suffix on
// the last segment for executables we match. Anything with quotes, spaces, `$`,
// `(`, backticks, etc. is rejected.
const SAFE_PROCESS_NAME_REGEX = /^[A-Za-z0-9._/-]+$/;

function sanitizeCandidateName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
    return null;
  }
  // Reject Windows drive-letter/UNC-ish or obviously hostile inputs.
  if (!SAFE_PROCESS_NAME_REGEX.test(name)) {
    return null;
  }
  return name;
}

// Build a SAFE WQL Name filter. Candidates are already validated by
// sanitizeCandidateName, so interpolation here can only produce a filter over
// literal, character-restricted identifiers — no quoting can smuggle operators,
// because no candidate contains `=`, `'`, `)`, or spaces. We STILL wrap each value
// in single quotes and additionally escape any lone `'` (defense in depth, though
// the regex already forbids them).
function buildWindowsScript(processNames) {
  const safe = Array.from(processNames).map(sanitizeCandidateName).filter(Boolean);
  if (safe.length === 0) {
    // Nothing to enumerate — return an empty result without invoking WMI.
    return null;
  }
  const filter = safe.map((name) => `Name='${name.replace(/'/g, "''")}'`).join(' OR ');

  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$filter = "${filter}"`,
    `$scrub = { param($s) if ($null -eq $s) { $null } else { [regex]::Replace([string]$s, '[\\x00-\\x1F]', ' ') } }`,
    // CreationDate captured here — it is the only reliable PID-reuse disambiguator
    // on Windows. We ship it as an ISO-ish CIM string and parse it downstream.
    'Get-CimInstance Win32_Process -Filter $filter | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = (& $scrub $_.Name); CommandLine = (& $scrub $_.CommandLine); CreationDate = if ($null -eq $_.CreationDate) { $null } else { ($_.CreationDate.ToUniversalTime().ToString(\'yyyyMMddHHmmss.ffffff\')) + \'+000\' } } } | ConvertTo-Json -Compress'
  ].join('; ');
}

function execFileText(file, args, options, onChild) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
    if (typeof onChild === 'function') {
      onChild(child);
    }
  });
}

function normalizeRows(value) {
  if (!value) {
    return [];
  }
  const rows = Array.isArray(value) ? value : [value];
  const out = [];
  // Row-tolerant: a single malformed row must not break the whole poll.
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const pid = Number(row.ProcessId);
    if (!Number.isFinite(pid) || pid <= 0) {
      continue;
    }
    let creationTime = null;
    if (row.CreationDate) {
      creationTime = parseCimDateTime(row.CreationDate);
    }
    out.push({
      ProcessId: pid,
      ParentProcessId: Number(row.ParentProcessId) || 0,
      Name: typeof row.Name === 'string' ? row.Name : '',
      CommandLine: typeof row.CommandLine === 'string' ? row.CommandLine : '',
      CreationDate: creationTime
    });
  }
  return out;
}

// Parse a CIM datetime like 20260829120000.123456+000 (or 20260829120000.123456)
// into epoch milliseconds. Returns null on parse failure.
function parseCimDateTime(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)([+-]\d{3})?/.exec(value);
  if (!m) {
    return null;
  }
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  // CIM fractional seconds are exactly 6 digits (microseconds); Date wants ms.
  const micros = frac.padEnd(6, '0').slice(0, 6);
  const ms = Number(micros.slice(0, 3));
  const date = new Date(Date.UTC(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms
  ));
  if (tz) {
    // CIM UTC offset (UUU) is a SIGNED NUMBER OF MINUTES, e.g. '+330' (IST,
    // UTC+5:30) or '+000' (UTC). It is NOT HHMM hours — treat it as minutes.
    const offsetMinutes = Number(tz);
    if (Number.isFinite(offsetMinutes)) {
      date.setUTCMinutes(date.getUTCMinutes() - offsetMinutes);
    }
  }
  const t = date.getTime();
  return Number.isFinite(t) ? t : null;
}

async function listWindowsProcesses(tools, onChild) {
  const names = candidateProcessNames(tools);
  const script = buildWindowsScript(names);
  if (script === null) {
    return [];
  }
  const stdout = await execFileText(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: POLL_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BUFFER_BYTES },
    onChild
  );
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  let parsed;
  try {
    parsed = parseJsonWithControlCharacterFallback(text);
  } catch (error) {
    throw new Error(`Could not parse PowerShell process output: ${error.message}`);
  }
  return normalizeRows(parsed);
}

// ---------------------------------------------------------------------------
// Unix enumeration — two-stage, privacy- and performance-conscious.
//
// Stage 1: enumerate PID/PPID/comm for EVERY process (cheap; comm is the short
// image name on both BSD and GNU ps). This identifies which processes are
// candidates (native binary names + interpreter names) WITHOUT reading anyone
// else's command line.
//
// Stage 2: fetch the full command line ONLY for candidate PIDs and their
// ANCESTORS up to a small depth (so a shell->node->tool chain is complete even
// when the shell's own cmdline is otherwise uninteresting). This avoids pulling
// command lines for the whole machine every poll, addressing the privacy/perf
// concern in the brief.
// ---------------------------------------------------------------------------
const PID_PPID_COMM_REST_REGEX = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
const PID_ARGS_REST_REGEX = /^\s*(\d+)\s+(.*)$/;

function parseCommLines(stdout) {
  const byPid = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const match = PID_PPID_COMM_REST_REGEX.exec(line);
    if (!match) {
      continue;
    }
    const processId = Number(match[1]);
    if (!Number.isFinite(processId)) {
      continue;
    }
    // BSD/macOS reports a zombie's comm wrapped in parentheses, e.g.
    // `(node)`. Strip them so the captured Name is the bare image basename and
    // still matches our candidate set.
    const comm = match[3].replace(/^\((.*)\)$/, '$1');
    byPid.set(processId, {
      ProcessId: processId,
      ParentProcessId: Number(match[2]) || 0,
      Name: basename(comm)
    });
  }
  return byPid;
}

function parseArgsLines(stdout) {
  const byPid = new Map();
  let lastPid = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const match = PID_ARGS_REST_REGEX.exec(line);
    if (match) {
      const processId = Number(match[1]);
      if (Number.isFinite(processId)) {
        byPid.set(processId, match[2]);
        lastPid = processId;
        continue;
      }
    }
    // A line with no leading PID is a continuation of the previous process's
    // args (e.g. an embedded newline inside a multi-line prompt). Reattach it
    // rather than dropping it — otherwise the command line is truncated and a
    // stray continuation could clobber an unrelated selected PID.
    if (lastPid !== null) {
      const prev = byPid.get(lastPid) || '';
      byPid.set(lastPid, prev ? `${prev}\n${line}` : line);
    }
  }
  return byPid;
}

function basename(pathLike) {
  const slashIndex = Math.max(pathLike.lastIndexOf('/'), pathLike.lastIndexOf('\\'));
  return slashIndex === -1 ? pathLike : pathLike.slice(slashIndex + 1);
}

// Build the set of process names we care about (candidate native binaries +
// interpreter hosts). Shell names are included only because they can be ancestors
// of tool processes, never as tool identity themselves.
function candidateProcessNames(tools) {
  const names = new Set(['node', 'node.exe', 'python', 'python3', 'python.exe', 'sh', 'sh.exe', 'bash', 'bash.exe']);
  for (const tool of tools) {
    for (const name of tool.processNames || []) {
      names.add(name.toLowerCase());
    }
    for (const host of tool.interpreterHosted || []) {
      for (const interp of host.interpreters || []) {
        names.add(interp.toLowerCase());
      }
    }
  }
  return names;
}

// Identify candidate PIDs from the broad comm listing, then collect their PIDs and
// a few levels of ancestors so descendant/ancestor chains are complete.
function selectCandidatePids(commByPid, tools, depth) {
  const candidateNames = new Set(candidateProcessNames(tools));
  const keep = new Set();
  for (const [pid, row] of commByPid) {
    if (candidateNames.has((row.Name || '').toLowerCase())) {
      keep.add(pid);
      // walk up `depth` ancestors
      let current = pid;
      let d = 0;
      while (d < depth && commByPid.has(current)) {
        const ppid = commByPid.get(current).ParentProcessId;
        if (!ppid || !commByPid.has(ppid)) {
          break;
        }
        keep.add(ppid);
        current = ppid;
        d++;
      }
    }
  }
  return keep;
}

// ---------------------------------------------------------------------------
// Unix start-time estimation.
//
// `ps` (and `/proc/<pid>/stat`) does not give a wall-clock creation timestamp on
// Unix/macOS, so the rest of the pipeline receives `CreationDate: null` there and
// every session renders with no age. We can still derive a REAL start time from
// the kernel boot-relative `starttime` field in `/proc/<pid>/stat`:
//
//   startEpochMs = (bootTimeMs + starttime_ticks / clk_tck)
//   bootTimeMs   = (Date.now() - uptimeSeconds*1000)   // via /proc/uptime
//   clk_tck      = sysconf(_SC_CLK_TCK)                  // typically 100
//
// This is a best-effort, read-only estimate (file reads only; no process spawn),
// accurate to ~10ms on Linux and to ~one tick on macOS (where /proc is absent and
// the helper returns null, leaving the existing null behavior unchanged). It does
// NOT close the AFS-04 PID-reuse gap — the session ID still uses the content
// fingerprint — it only fills in an age for display.
// ---------------------------------------------------------------------------
let _clkTck = null;
function getClkTck() {
  if (_clkTck != null) {
    return _clkTck;
  }
  try {
    // getconf returns e.g. "100\n"; sysconf(_SC_CLK_TCK) is the canonical source.
    const out = execFileSync('getconf', ['CLK_TCK'], { timeout: 2000 }).toString().trim();
    const n = Number(out);
    _clkTck = Number.isFinite(n) && n > 0 ? n : 100;
  } catch {
    _clkTck = 100; // POSIX default when getconf is unavailable.
  }
  return _clkTck;
}

// Read /proc/<pid>/stat and extract field #22 (starttime) as a number, or null.
// We only touch the leading numeric fields and the comm field (field 2) is
// parentheses-balanced, so a naive `split(' ')` is NOT safe for the full string;
// we parse defensively from the end where the numeric tail lives.
function readStarttimeTicks(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // starttime is the 22nd whitespace-delimited field. Locate it by counting
    // fields but allowing the comm field (field 2) to contain spaces/parens.
    const open = raw.indexOf('(');
    const close = raw.lastIndexOf(')');
    if (open === -1 || close === -1 || close < open) {
      return null;
    }
    const tail = raw.slice(close + 1).trim().split(/\s+/);
    // tail[0] is field 3 (state); starttime is field 22 -> tail index 19.
    const idx = 22 - 3;
    if (idx < 0 || idx >= tail.length) {
      return null;
    }
    const ticks = Number(tail[idx]);
    return Number.isFinite(ticks) && ticks >= 0 ? ticks : null;
  } catch {
    return null; // ENOENT (process gone), EACCES, or non-Linux platform.
  }
}

// Boot epoch is effectively constant for the life of the process; cache it so
// estimateUnixStartTimeMs is STABLE across polls for the same PID. Re-reading
// Date.now() minus a coarse-grained /proc/uptime each call lets the derived boot
// epoch drift by up to the uptime granularity (~10ms), which would make a
// session's computed start time jitter and could flap its stable id.
let _bootMs = null;
function readBootTimeMs() {
  if (_bootMs != null) {
    return _bootMs;
  }
  try {
    const uptime = fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0];
    const seconds = Number(uptime);
    if (!Number.isFinite(seconds)) {
      return null;
    }
    _bootMs = Date.now() - seconds * 1000;
    return _bootMs;
  } catch {
    return null;
  }
}

// Best-effort epoch-ms start time for a Unix PID, or null when unavailable.
function estimateUnixStartTimeMs(pid) {
  if (process.platform !== 'linux') {
    return null; // macOS/others: no /proc; keep the existing null behavior.
  }
  const ticks = readStarttimeTicks(pid);
  if (ticks == null) {
    return null;
  }
  const bootMs = readBootTimeMs();
  if (bootMs == null) {
    return null;
  }
  const clkTck = getClkTck();
  // Guard against Number overflow on systems with very large tick counts.
  const startMs = bootMs + Math.round((ticks / clkTck) * 1000);
  return Number.isFinite(startMs) ? startMs : null;
}

async function listUnixProcesses(tools, onChild) {
  const options = {
    timeout: POLL_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    env: Object.assign({}, process.env, { COLUMNS: '100000' })
  };

  // Stage 1: comm for all processes.
  const commOutput = await execFileText('ps', ['-ww', '-eo', 'pid=,ppid=,comm='], options, onChild);
  const commByPid = parseCommLines(commOutput);

  const keep = selectCandidatePids(commByPid, tools, 4);

  // Stage 2: fetch args only for selected PIDs. `ps -p 1,2,3` accepts a pid list.
  const pidList = Array.from(keep);
  let argsByPid = new Map();
  if (pidList.length > 0) {
    const argsOutput = await execFileText(
      'ps',
      ['-ww', '-o', 'pid=,args=', '-p', pidList.join(',')],
      options,
      onChild
    );
    argsByPid = parseArgsLines(argsOutput);
  }

  const rows = [];
  for (const [pid, row] of commByPid) {
    if (!keep.has(pid)) {
      continue;
    }
    // procps emits a literal '?' for processes whose /proc/<pid>/cmdline is
    // unreadable. Treat '?' as missing so we fall back to the (safer) comm Name
    // rather than surfacing '?' as a command line.
    const args = argsByPid.get(pid);
    const commandLine = args && args !== '?' ? args : row.Name;
    // Unix/macOS has no wall-clock creation time from `ps`, so estimate one from
    // /proc/<pid>/stat starttime (Linux only; macOS returns null and keeps the
    // prior `null` behavior). This populates session age without spawning a
    // process and is best-effort / read-only.
    const created = estimateUnixStartTimeMs(pid);
    rows.push({
      ProcessId: row.ProcessId,
      ParentProcessId: row.ParentProcessId,
      Name: row.Name,
      CommandLine: commandLine,
      CreationDate: created
    });
  }
  return rows;
}

async function listProcesses(tools, onChild) {
  if (process.platform === 'win32') {
    return listWindowsProcesses(tools, onChild);
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return listUnixProcesses(tools, onChild);
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

module.exports = {
  listProcesses,
  candidateProcessNames,
  parseCimDateTime,
  estimateUnixStartTimeMs,
  SAFE_PROCESS_NAME_REGEX,
  sanitizeCandidateName,
  _internal: { parseCommLines, parseArgsLines, basename, normalizeRows, buildWindowsScript, selectCandidatePids, sanitizeCandidateName, SAFE_PROCESS_NAME_REGEX }
};
