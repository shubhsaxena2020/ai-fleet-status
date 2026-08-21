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

// ps's comm/args column parsing assumes `comm` has no embedded whitespace (true for
// every real executable name) and that `args` is the last column, since args is the
// only field allowed to contain spaces. `-ww` (macOS/BSD) / a wide $COLUMNS
// (Linux/procps) both ask for unbounded-width output so long command lines aren't
// truncated - the exact failure mode that would otherwise silently drop useful detail.
const PS_LINE_REGEX = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/;

function parsePsOutput(stdout) {
  const rows = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const match = PS_LINE_REGEX.exec(line);

    if (!match) {
      continue;
    }

    const processId = Number(match[1]);
    const parentProcessId = Number(match[2]);

    if (!Number.isFinite(processId)) {
      continue;
    }

    rows.push({
      ProcessId: processId,
      ParentProcessId: Number.isFinite(parentProcessId) ? parentProcessId : 0,
      Name: match[3],
      CommandLine: match[4] || match[3]
    });
  }

  return rows;
}

async function listUnixProcesses(onChild) {
  const stdout = await execFileText(
    'ps',
    ['-ww', '-eo', 'pid=,ppid=,comm=,args='],
    {
      timeout: POLL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: Object.assign({}, process.env, { COLUMNS: '100000' })
    },
    onChild
  );

  return parsePsOutput(stdout);
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
  parsePsOutput,
  candidateProcessNames
};
