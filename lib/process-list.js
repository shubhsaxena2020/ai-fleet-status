'use strict';

const { execFile } = require('child_process');
const { parseJsonWithControlCharacterFallback } = require('./json-parse');

const POLL_TIMEOUT_MS = 8000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// Only the process names a tool config could plausibly match against are asked for -
// keeps the process list small and (on Windows) lets the filter run server-side in WMI
// rather than pulling every process on the machine across into Node just to discard most.
function candidateProcessNames(tools) {
  const names = new Set(['node.exe', 'node', 'sh.exe', 'sh', 'bash.exe', 'bash']);

  for (const tool of tools) {
    for (const name of tool.processNames) {
      names.add(name);
    }
  }

  return Array.from(names);
}

function buildWindowsScript(processNames) {
  const filter = processNames.map((name) => `Name='${name}'`).join(' OR ');

  // The control-character scrub runs on each string field's own value before it goes
  // into the object that gets serialized - not on the final compressed JSON text - so
  // it cannot corrupt JSON structure. It exists because Windows PowerShell 5.1's
  // ConvertTo-Json has a documented history of emitting raw, unescaped control bytes
  // (0x00-0x1F) inside string values instead of the required \u00XX escape.
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$filter = "${filter}"`,
    "$scrub = { param($s) if ($null -eq $s) { $null } else { [regex]::Replace([string]$s, '[\\x00-\\x1F]', ' ') } }",
    'Get-CimInstance Win32_Process -Filter $filter | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = (& $scrub $_.Name); CommandLine = (& $scrub $_.CommandLine) } } | ConvertTo-Json -Compress'
  ].join('; ');
}

// onChild (optional) receives the live ChildProcess handle synchronously, before this
// promise settles - callers use it to kill the process early (e.g. on extension
// deactivation) since execFile's own timeout option won't fire until POLL_TIMEOUT_MS
// has elapsed, which is too slow for a clean, prompt shutdown.
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

  return rows
    .map((row) => ({
      ProcessId: Number(row.ProcessId),
      ParentProcessId: Number(row.ParentProcessId),
      Name: typeof row.Name === 'string' ? row.Name : '',
      CommandLine: typeof row.CommandLine === 'string' ? row.CommandLine : ''
    }))
    .filter((row) => Number.isFinite(row.ProcessId));
}

async function listWindowsProcesses(tools, onChild) {
  const stdout = await execFileText(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', buildWindowsScript(candidateProcessNames(tools))],
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
    // Distinguishing this from a plain execFile failure matters: a JSON parse error
    // means PowerShell ran fine and produced output, but that output wasn't valid
    // JSON - a different failure class needing a different fix than "PowerShell
    // didn't run" or "PowerShell timed out".
    throw new Error(`Could not parse PowerShell process output: ${error.message}`);
  }

  return normalizeRows(parsed);
}

// comm and args are queried as two separate `ps` calls, each parsed with a regex that
// treats everything after the fixed-width numeric column(s) as one field - rather than
// one combined "pid ppid comm args" call split on whitespace. That combined approach
// breaks as soon as comm itself contains a space, which it regularly does on macOS:
// BSD ps's `comm` is the full executable PATH (not a basename, unlike Linux/procps),
// and real paths there routinely contain spaces (e.g. "/Applications/Visual Studio
// Code.app/Contents/MacOS/Electron"). A single whitespace-split regex has no way to
// tell "the name has a space in it" apart from "the name ended and args began".
const PID_PPID_REST_REGEX = /^\s*(\d+)\s+(\d+)\s+(.*)$/;
const PID_REST_REGEX = /^\s*(\d+)\s+(.*)$/;

function parseCommLines(stdout) {
  const byPid = new Map();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const match = PID_PPID_REST_REGEX.exec(line);

    if (!match) {
      continue;
    }

    const processId = Number(match[1]);

    if (!Number.isFinite(processId)) {
      continue;
    }

    byPid.set(processId, {
      ProcessId: processId,
      ParentProcessId: Number(match[2]) || 0,
      Name: basename(match[3])
    });
  }

  return byPid;
}

function parseArgsLines(stdout) {
  const byPid = new Map();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const match = PID_REST_REGEX.exec(line);

    if (!match) {
      continue;
    }

    const processId = Number(match[1]);

    if (Number.isFinite(processId)) {
      byPid.set(processId, match[2]);
    }
  }

  return byPid;
}

// BSD ps (macOS) reports comm as a full path; GNU/procps ps (Linux) already reports a
// bare basename, for which this is a harmless no-op (no separator found).
function basename(pathLike) {
  const slashIndex = Math.max(pathLike.lastIndexOf('/'), pathLike.lastIndexOf('\\'));
  return slashIndex === -1 ? pathLike : pathLike.slice(slashIndex + 1);
}

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

// `-ww` (BSD/macOS) and a wide $COLUMNS (Linux/procps) both ask for unbounded-width
// output so long command lines aren't truncated - the exact failure mode that would
// otherwise silently drop useful detail.
async function listUnixProcesses(onChild) {
  const options = {
    timeout: POLL_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    env: Object.assign({}, process.env, { COLUMNS: '100000' })
  };

  // Both calls run concurrently and each spawns its own child process, so onChild (if
  // given) is invoked once per child - a caller tracking "the current child" needs to
  // track a set here, not a single handle, to be able to kill both on deactivation.
  const [commOutput, argsOutput] = await Promise.all([
    execFileText('ps', ['-ww', '-eo', 'pid=,ppid=,comm='], options, onChild),
    execFileText('ps', ['-ww', '-eo', 'pid=,args='], options, onChild)
  ]);

  return mergeUnixRows(parseCommLines(commOutput), parseArgsLines(argsOutput));
}

// onChild (optional) is called synchronously with the spawned ChildProcess handle so a
// caller (e.g. the extension deactivating mid-poll) can kill it immediately instead of
// waiting out the full POLL_TIMEOUT_MS.
async function listProcesses(tools, onChild) {
  if (process.platform === 'win32') {
    return listWindowsProcesses(tools, onChild);
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    return listUnixProcesses(onChild);
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

module.exports = {
  listProcesses,
  candidateProcessNames,
  // Exported for tests only - not part of the module's runtime API surface.
  _internal: { parseCommLines, parseArgsLines, mergeUnixRows, basename }
};
