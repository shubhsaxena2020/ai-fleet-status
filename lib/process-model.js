'use strict';

// Normalized process representation used by every layer above enumeration.
//
// The enumeration layer (lib/enumerate.js) is responsible for producing these
// objects from whatever the OS gives us (WMI / ps / WSL). Everything downstream
// (detection, session grouping, tree view, diagnostics) is platform-agnostic and
// only ever touches this shape.
//
// Fields:
//   pid           number  OS process id (may be recycled — never trust alone)
//   ppid          number  parent process id (0 == none / kernel)
//   name          string  lowercased executable BASENAME (e.g. 'claude.exe',
//                          'node') — already normalized so BSD `ps` full-path
//                          `comm` and GNU procps 15-char-truncated `comm` are
//                          reconciled by the caller before this is built.
//   commandLine   string  full command line if available, else '' (never null).
//   creationTime  number|null  process start time as epoch ms where the platform
//                          can supply it (Windows Win32_Process.CreationDate).
//                          Used to disambiguate PID reuse: a PID that reappears
//                          with a different creationTime is a different process.
//   scope         string  'local' for the extension-host machine, or
//                          'wsl:<distro>' for a process observed inside a WSL
//                          distribution. Lets us build identities that are unique
//                          per machine/namespace.

class Process {
  constructor(pid, ppid, name, commandLine, creationTime, scope) {
    this.pid = pid;
    this.ppid = ppid;
    this.name = name;
    this.commandLine = commandLine;
    this.creationTime = creationTime;
    this.scope = scope || 'local';
  }
}

// Build a ProcessGraph from a flat list of Process objects. The graph supports
// both upward (ancestors) and downward (descendants) traversal so callers can
// walk either direction when grouping sessions.
class ProcessGraph {
  constructor(processes) {
    /** @type {Map<number, Process>} */
    this.byPid = new Map();
    /** @type {Map<number, number[]>} parent pid -> child pids */
    this.children = new Map();
    /** @type {Map<number, number>} pid -> parent pid (0 if none) */
    this.parent = new Map();

    for (const proc of processes) {
      if (!proc || !Number.isFinite(proc.pid)) {
        continue;
      }
      this.byPid.set(proc.pid, proc);
    }

    for (const proc of this.byPid.values()) {
      const ppid = Number.isFinite(proc.ppid) ? proc.ppid : 0;
      this.parent.set(proc.pid, ppid);
      if (ppid && ppid !== proc.pid && this.byPid.has(ppid)) {
        if (!this.children.has(ppid)) {
          this.children.set(ppid, []);
        }
        this.children.get(ppid).push(proc.pid);
      }
    }
  }

  has(pid) {
    return this.byPid.has(pid);
  }

  get(pid) {
    return this.byPid.get(pid);
  }

  // Walk from pid up to the root, returning the chain of Process objects
  // [pid, parent, grandparent, ...] stopping at a missing parent or a cycle.
  ancestors(pid) {
    const chain = [];
    const seen = new Set();
    let current = pid;

    while (current && this.byPid.has(current) && !seen.has(current)) {
      seen.add(current);
      const proc = this.byPid.get(current);
      chain.push(proc);
      const ppid = this.parent.get(current);
      if (!ppid || ppid === current || !this.byPid.has(ppid)) {
        break;
      }
      current = ppid;
    }

    return chain;
  }

  // Return every descendant pid of `pid` (children, grandchildren, ...).
  // Excludes `pid` itself. Stops cleanly on cycles.
  descendants(pid) {
    const result = [];
    const seen = new Set([pid]);
    const stack = [pid];

    while (stack.length > 0) {
      const current = stack.pop();
      const kids = this.children.get(current);
      if (!kids) {
        continue;
      }
      for (const child of kids) {
        if (seen.has(child)) {
          continue;
        }
        seen.add(child);
        result.push(child);
        stack.push(child);
      }
    }

    return result;
  }

  // All processes in the connected component rooted at `pid` (the root itself
  // plus every descendant). This is the basis for a session's PROCESS COUNT.
  subtree(pid) {
    return [this.byPid.get(pid), ...this.descendants(pid).map((p) => this.byPid.get(p))].filter(Boolean);
  }
}

// Split a command line into whitespace/quote-delimited tokens, mirroring roughly
// how a shell would. We use this for subcommand + mode-keyword extraction rather
// than naive whitespace split, because an agent prompt can contain spaces and
// quotes and we must not treat words inside the prompt as flags.
//
// Implementation: a small hand-rolled tokenizer. Handles single/double quotes
// (neither nested nor escaped in a POSIX-perfect way, which is fine — we only
// need to isolate the FIRST few structural tokens). Returns [] on empty input.
function tokenizeCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.length === 0) {
    return [];
  }

  const tokens = [];
  let current = '';
  let quote = null;
  let hasToken = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += ch;
    hasToken = true;
  }

  if (hasToken) {
    tokens.push(current);
  }

  return tokens;
}

// The "program" of a command line is everything up to (but not including) the
// real subcommand/arguments. For a native binary that is argv[0]. For an
// interpreter-hosted tool it includes the interpreter + the script path
// (e.g. `node /x/cli.js` or `python -m pkg`). Returns the number of leading
// tokens that constitute the program so callers can read the *next* token as the
// subcommand and ignore prompt text further down.
//
// interpreterPrefixes lists known launcher tokens whose following token is still
// part of the program (the script), so `node foo.js serve` yields programLen 2
// and subcommand 'serve'.
function programLength(tokens, interpreterPrefixes) {
  if (tokens.length === 0) {
    return 0;
  }

  const first = tokens[0].toLowerCase().split(/[/\\]/).pop();
  if (interpreterPrefixes.has(first)) {
    // `node script.js ...` or `node -e ...` — the script is argv[1].
    // Also handle `python -m module` style.
    if (tokens.length >= 2) {
      const second = tokens[1].toLowerCase();
      if (second === '-m' || second === '-m=') {
        // `python -m module` — program is 3 tokens.
        return tokens.length >= 3 ? 3 : tokens.length;
      }
      return 2;
    }
    return tokens.length;
  }

  return 1;
}

module.exports = {
  Process,
  ProcessGraph,
  tokenizeCommandLine,
  programLength,
  INTERPRETER_PREFIXES: new Set(['node', 'node.exe', 'python', 'python3', 'python.exe', 'uv', 'uvx', 'bun', 'deno'])
};
