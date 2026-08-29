'use strict';

// ---------------------------------------------------------------------------
// macOS process start-time estimation.
//
// On macOS there is no `/proc`, so `ps` and `procfs` cannot supply a wall-clock
// creation timestamp the way Linux's `/proc/<pid>/stat` starttime does. The rest
// of the pipeline therefore received `CreationDate: null` on macOS and fell
// through to the content-fingerprint / pollSeq tiers of `sessionId()` — which is
// correct but weaker than a real start epoch (a still-running session can flap
// across polls, and the audit's AFS-04 PID-reuse scenario is only mitigated, not
// closed).
//
// This module closes that gap by deriving a REAL process start epoch (ms) on
// macOS, mirroring what `estimateUnixStartTimeMs` does for Linux. Two strategies:
//
//   1. NATIVE (preferred): a `proc_pidinfo` wrapper. `proc_pidinfo(PROC_INFO_PID,
//      pid, PROC_PIDTBSDINFO, ...)` fills a `struct proc_bsdshortinfo` whose
//      `pbi_start_tvsec` field is the process start time in seconds since the
//      Unix epoch — no process spawn, and immune to locale. We look for an
//      OPTIONAL zero-dependency native binding and use it when present.
//   2. FALLBACK (locale-pinned): `ps -o lstart= -p <pid>` with `LC_ALL=C` /
//      `LANG=C`. The default `lstart` format is locale-dependent (month names
//      localize, the field order is stable but the tokens vary), so we pin the
//      locale to C to make `parseLstart` deterministic. This is the
//      "locale-fragile" path the design warns about — we only use it when the
//      native wrapper is unavailable.
//
// Both strategies are best-effort and read-only. Any failure returns `null`,
// which leaves the caller's existing fingerprint/pollSeq behavior intact (no
// regression). On non-darwin platforms this module always returns `null`.
// ---------------------------------------------------------------------------

const { execFileSync } = require('child_process');

// Parse the output of `ps -o lstart= -p <pid>` produced with `LC_ALL=C`.
// Example line: "Mon Aug 25 14:23:01 2026"
// Format: <Ddd> <Mmm> <DD> <HH:MM:SS> <YYYY>
// Returns epoch milliseconds, or null if the line cannot be parsed.
function parseLstart(output) {
  if (typeof output !== 'string') {
    return null;
  }
  const line = output.trim();
  if (!line) {
    return null;
  }
  const m = /^(?:[A-Za-z]{3})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(line);
  if (!m) {
    return null;
  }
  const [, mon, day, hh, mm, ss, yyyy] = m;
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };
  const mo = months[mon];
  if (mo === undefined) {
    return null;
  }
  const d = new Date(Date.UTC(Number(yyyy), mo, Number(day), Number(hh), Number(mm), Number(ss)));
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

// Lazily resolve an OPTIONAL native binding that exposes
// `getProcessStartTsec(pid)` (a thin wrapper over `proc_pidinfo` /
// `proc_bsdshortinfo.pbi_start_tvsec`). Returns null when no binding is present
// so the extension stays zero-dependency by default. The try/catch swallows both
// a missing module and any load-time error.
function safeRequireNativeStartTsec() {
  try {
    // Local optional binding shipped alongside the extension (compiled per host).
    const local = require('./macos-proc-native');
    if (local && typeof local.getProcessStartTsec === 'function') {
      return local.getProcessStartTsec;
    }
  } catch { /* not present — fine */ }
  try {
    // Or a published npm binding, if a maintainer chooses to vendor one.
    const pkg = require('macos-process-start');
    if (pkg && typeof pkg.getProcessStartTsec === 'function') {
      return pkg.getProcessStartTsec;
    }
  } catch { /* not present — fine */ }
  return null;
}

// Best-effort real process start epoch (ms) on macOS, or null.
//
// `spawnSync` is injectable for testing: pass a function with the same signature
// as `execFileSync` (returns a Buffer/String or throws) to exercise the ps
// fallback path without an actual macOS process table.
function getMacOsProcessStartTime(pid, spawnSync) {
  if (process.platform !== 'darwin') {
    return null;
  }
  return getMacOsProcessStartTimeCore(pid, spawnSync);
}

// Gate-free core (darwin logic). Separated so the platform gate does not block
// unit testing of the parsing + fallback on other platforms.
function getMacOsProcessStartTimeCore(numericPid, spawnSync) {
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return null;
  }

  // Strategy 1: native proc_pidinfo wrapper (no spawn, locale-immune).
  const nativeStartTsec = safeRequireNativeStartTsec();
  if (typeof nativeStartTsec === 'function') {
    try {
      const tvsec = nativeStartTsec(numericPid);
      if (Number.isFinite(tvsec) && tvsec > 0) {
        return tvsec * 1000;
      }
    } catch { /* native call failed — fall through to ps */ }
  }

  // Strategy 2: locale-pinned `ps -o lstart=`.
  const run = spawnSync || execFileSync;
  try {
    const out = run(
      'ps',
      ['-o', 'lstart=', '-p', String(numericPid)],
      { timeout: 2000, env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' }) }
    );
    const stdout = Buffer.isBuffer(out) ? out.toString('utf8') : String(out);
    return parseLstart(stdout);
  } catch {
    return null; // process gone (ESRCH), spawn failure, or unparseable output.
  }
}

module.exports = {
  getMacOsProcessStartTime,
  getMacOsProcessStartTimeCore,
  parseLstart
};
