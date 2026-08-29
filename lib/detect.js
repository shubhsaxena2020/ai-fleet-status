'use strict';

const { tokenizeCommandLine, programLength, INTERPRETER_PREFIXES } = require('./process-model');

// ---------------------------------------------------------------------------
// Detection registry
//
// The previous design classified a process as a *task* only when:
//   (process name matches) AND (an `actionKeyword` regex matched the cmdline)
// `actionKeywords` doubled as a REQUIRED gate and as regex source fed straight
// into `new RegExp(...)`. That had two fatal properties:
//
//   1. A plain interactive session (`claude`, `codex`, `qwen` with no flags)
//      never satisfied the keyword gate, so EVERY bare interactive session was
//      silently missed. Verified against the real `--help` output of every
//      installed CLI: interactive is the DEFAULT mode for all of them.
//   2. User-supplied `actionKeywords` were raw regex source => ReDoS / injection
//      (a custom keyword like `(a+)+$` could hang the extension).
//
// The new model separates the two concerns the brief asks for:
//
//   A. TOOL IDENTITY  — is this process genuinely this AI CLI?
//   B. SESSION MODE   — what KIND of invocation is it?
//
// Identity is established structurally (native binary basename, or an
// interpreter running a script whose path contains a bounded fragment). Mode is
// derived from the subcommand + flags. Executable presence ALONE is sufficient
// for an interactive session, so interactive invocations are no longer missed.
//
// Keywords are treated as LITERAL tokens (case-insensitive, quote/space bounded)
// — never as regex source — which removes the ReDoS class entirely.
// ---------------------------------------------------------------------------

// Subcommands / flags that mean "this process is not a user-facing session" and
// should not be counted. Kept per-tool because the vocabulary differs.
//   service*  -> a server / daemon / UI / protocol host (must be distinguishable
//                from an ordinary session, per the brief). Returned as
//                `kind: 'service'` and excluded from session/process tallies.
//   util*     -> one-shot utility exit (--help, --version, configure, login...).
//                Returned as null (not this tool's concern right now).
function buildDetector(spec) {
  return {
    id: spec.id,
    displayName: spec.displayName || spec.id,
    processNames: new Set((spec.processNames || []).map((n) => n.toLowerCase())),
    interpreterHosted: (spec.interpreterHosted || []).map((h) => ({
      interpreters: new Set((h.interpreter || ['node', 'node.exe', 'python', 'python3', 'python.exe']).map((x) => x.toLowerCase())),
      fragments: (h.fragments || []).map((f) => f.toLowerCase())
    })),
    serviceSubcommands: new Set((spec.serviceSubcommands || []).map((s) => s.toLowerCase())),
    utilSubcommands: new Set((spec.utilSubcommands || []).map((s) => s.toLowerCase())),
    delegatedSubcommands: new Set((spec.delegatedSubcommands || []).map((s) => s.toLowerCase())),
    delegatedFlags: new Set((spec.delegatedFlags || []).map((s) => s.toLowerCase())),
    resumeFlags: new Set((spec.resumeFlags || []).map((s) => s.toLowerCase())),
    interactivePromptFlags: new Set((spec.interactivePromptFlags || []).map((s) => s.toLowerCase()))
  };
}

// Does `token` contain `fragment` as a path-bounded match? A fragment may be a
// single path segment (`cli.js`, `codex`) or a multi-segment path
// (`@qwen-code/qwen-code`, `bundle/gemini.js`). We split the token into its path
// segments and test whether the fragment's segment sequence appears contiguously —
// which naturally enforces path boundaries (so `/home/codex-user/app` does NOT
// match the fragment `codex`, because `codex-user` is a single segment that is not
// an exact segment, and the multi-segment `codex-user/app` != `codex`).
function fragmentInToken(token, fragment) {
  const fragSegs = fragment.toLowerCase().split(/[/\\]/);
  const tokSegs = String(token).toLowerCase().split(/[/\\]/);
  if (fragSegs.length === 1) {
    return tokSegs.includes(fragSegs[0]);
  }
  if (fragSegs.length > tokSegs.length) {
    return false;
  }
  for (let i = 0; i + fragSegs.length <= tokSegs.length; i++) {
    let ok = true;
    for (let j = 0; j < fragSegs.length; j++) {
      if (tokSegs[i + j] !== fragSegs[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return true;
    }
  }
  return false;
}

// Match one normalized Process against one compiled detector.
//
// Returns:
//   null                                  — not this tool
//   { kind: 'service', confidence, reason }— this tool, but a server/daemon mode
//   { kind: 'session', mode, confidence, reason } — a user-facing session
function detect(process, detectorOrDetectors) {
  // Defensive: a null/undefined process row must NOT throw — it would kill the
  // entire detection poll (the AFS-01 impact class: one bad row aborts ALL tools).
  // Degrade to "no match" instead. A process row can be missing/null when the OS
  // enumeration yields a malformed entry or a caller passes a sparse array.
  if (!process || typeof process !== 'object') {
    return null;
  }
  // Convenience: allow callers to pass an array of detectors; we return the first
  // match (same semantics as `identify`). A single detector is also accepted.
  if (Array.isArray(detectorOrDetectors)) {
    for (const detector of detectorOrDetectors) {
      const match = detectOne(process, detector);
      if (match) {
        return match;
      }
    }
    return null;
  }
  return detectOne(process, detectorOrDetectors);
}

function detectOne(process, detector) {
  // Accept either a normalized Process instance ({ name, commandLine, ... }) or a raw
  // enumerate row ({ Name, CommandLine, ... }). listProcesses and several callers
  // pass the latter; normalize so detection works in both shapes.
  const name = ((process.name != null) ? process.name : process.Name || '').toLowerCase();
  const commandLine = (process.commandLine != null) ? process.commandLine
    : (process.CommandLine != null ? process.CommandLine : '');
  // Defensive normalization of the detector. `detect` is a public API: a caller may
  // pass a raw config entry, a partially-compiled detector, or a hand-built object
  // whose Set-typed fields are still raw Arrays/strings/undefined (e.g.
  // `{ name:'Bad', processNames:['bad.exe'], interpreterHosted:[{ interpreters:'node' }] }`).
  // Coercing these to Sets here keeps detection crash-proof regardless of how the
  // detector was built — a malformed/partial detector degrades to "no match" instead
  // of throwing `x.has is not a function` (regression: AFS-01 class). This guard was
  // present before the upstream npm-shim refactor and must stay.
  const asSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : []));
  const d = detector && typeof detector === 'object' ? detector : {};
  const processNames = asSet(d.processNames);
  const serviceSubcommands = asSet(d.serviceSubcommands);
  const utilSubcommands = asSet(d.utilSubcommands);
  const delegatedSubcommands = asSet(d.delegatedSubcommands);
  const delegatedFlags = asSet(d.delegatedFlags);
  const resumeFlags = asSet(d.resumeFlags);
  const interactivePromptFlags = asSet(d.interactivePromptFlags);
  const isNative = processNames.has(name);

  let interpreterHosted = null;
  const hosts = detector.interpreterHosted || [];
  if (!isNative && hosts.length > 0 && typeof commandLine === 'string') {
    const tokens = tokenizeCommandLine(commandLine);
    const len = programLength(tokens, INTERPRETER_PREFIXES);
    const programTokens = tokens.slice(0, len).map((t) => t.toLowerCase());
    const firstTok = programTokens.length > 0 ? programTokens[0] : '';
    const firstBasename = firstTok.split('/').pop().split('\\').pop();

    for (const host of hosts) {
      // Defensive: a detector may reach `detect` without full compilation
      // (raw config, a partial spec, or a malformed `interpreterHosted` element
      // such as `['oops']` / `{}`). A malformed host must never crash detection —
      // skip it rather than throwing `Cannot read properties of undefined
      // (reading 'has')` at detect.js:130 (regression: AFS-01 class).
      // Coerce the interpreter list into a Set regardless of which shape a caller
      // or a partial/raw detector handed us. `buildDetector` always produces
      // `{ interpreters: Set, fragments: [] }`, but the public `detect` API accepts
      // detectors built by anyone — including partial specs where `interpreters`
      // is still a raw string, or where a legacy `interpreter` Array/Set was used.
      // Previously a scalar `interpreters` (e.g. `{ interpreters: 'node' }`) matched
      // NEITHER branch below: it is not a Set and there is no `interpreter` key, so
      // it fell through to `null` and became a SILENT miss (the process was never
      // attributed to its tool). Normalize scalar / Set / Array uniformly so a
      // non-Array, non-Set `interpreters` still matches instead of being dropped.
      // (AFS-01 robustness class — the named `host.interpreters.has` throw was
      // already fixed; this closes the asymmetric scalar-shape miss.)
      let interpreters = null;
      if (host && host.interpreters instanceof Set) {
        interpreters = host.interpreters;
      } else if (host && Array.isArray(host.interpreters)) {
        interpreters = new Set(host.interpreters.map((x) => String(x).toLowerCase()));
      } else if (host && typeof host.interpreters === 'string') {
        interpreters = new Set([host.interpreters.toLowerCase()]);
      } else if (host && Array.isArray(host.interpreter)) {
        interpreters = new Set(host.interpreter.map((x) => String(x).toLowerCase()));
      } else if (host && host.interpreter instanceof Set) {
        interpreters = host.interpreter;
      } else if (host && typeof host.interpreter === 'string') {
        interpreters = new Set([host.interpreter.toLowerCase()]);
      }
      if (!interpreters || !interpreters.has(firstBasename)) {
        continue;
      }
      // A partial host may omit `fragments`; treat as an empty list rather than crash.
      const fragments = Array.isArray(host.fragments) ? host.fragments : [];
      if (fragments.some((frag) => programTokens.some((tok) => fragmentInToken(tok, frag)))) {
        interpreterHosted = true;
        break;
      }
    }
  }

  if (!isNative && !interpreterHosted) {
    return null;
  }

  const confidence = isNative ? 'high' : (interpreterHosted ? 'medium' : 'low');

  // Missing command line: we can identify the binary but cannot establish mode.
  if (!commandLine) {
    return { id: d.id, toolId: d.id, kind: 'session', mode: 'unknown', confidence: 'low', reason: 'process name matched; command line unavailable' };
  }

  const tokens = tokenizeCommandLine(commandLine);
  const len = programLength(tokens, INTERPRETER_PREFIXES);
  const postProgram = tokens.slice(len).map((t) => t.toLowerCase());
  const subcommand = postProgram.find((t) => !t.startsWith('-')) || null;
  // Split `--resume=ID` / `-p="x"` so the base flag is what we compare.
  const flagBases = postProgram
    .filter((t) => t.startsWith('-'))
    .map((t) => t.split('=')[0]);

  // One-shot utility invocations (--help / --version) exit immediately and are
  // not live sessions.
  if (flagBases.some((f) => f === '--help' || f === '-h' || f === '--version' || f === '-v' || f === '--about')) {
    return null;
  }
  if (subcommand && utilSubcommands.has(subcommand)) {
    return null;
  }
  if (subcommand && serviceSubcommands.has(subcommand)) {
    return { id: d.id, toolId: d.id, kind: 'service', confidence, reason: 'service subcommand ' + JSON.stringify(subcommand) };
  }

  let mode;
  if (flagBases.some((f) => resumeFlags.has(f))) {
    mode = 'resume';
  } else if (subcommand && delegatedSubcommands.has(subcommand)) {
    mode = 'delegated';
  } else if (flagBases.some((f) => delegatedFlags.has(f))) {
    mode = 'delegated';
  } else if (flagBases.some((f) => interactivePromptFlags.has(f))) {
    mode = 'interactive-prompt';
  } else {
    mode = 'interactive';
  }

  return { id: d.id, toolId: d.id, kind: 'session', mode, confidence, reason: `matched by ${isNative ? 'native binary' : 'interpreter script'}` };
}

// ---------------------------------------------------------------------------
// Built-in detectors — every entry verified against the installed CLI's
// `--help` (local, on 2026-08-29) or, where not installed, the official docs.
// See docs/SESSION_MODEL.md and AUDIT_REPORT.md for the evidence trail.
// ---------------------------------------------------------------------------
const BUILTIN_SPECS = [
  {
    id: 'codex',
    displayName: 'Codex',
    processNames: ['codex.exe', 'codex'],
    // Server/daemon modes (excluded from sessions) — verified from codex --help.
    serviceSubcommands: ['mcp-server', 'app-server', 'remote-control', 'exec-server', 'app'],
    // One-shot utility exits (management, not a live session).
    utilSubcommands: ['login', 'logout', 'mcp', 'plugin', 'sandbox', 'debug', 'features', 'cloud', 'archive', 'delete', 'unarchive', 'completion', 'update', 'doctor', 'help', 'init', 'auth'],
    // Delegated one-shot invocations.
    delegatedSubcommands: ['exec', 'e', 'review', 'apply'],
    resumeFlags: ['resume', '--resume', '--last', '-c', '--continue'],
    // Interactive (`codex`) and `codex resume` are real user sessions; native
    // name match already covers `codex` with no flags.
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    processNames: ['opencode.exe', 'opencode'],
    serviceSubcommands: ['serve', 'web', 'acp', 'attach'],
    utilSubcommands: ['completion', 'mcp', 'providers', 'auth', 'agents', 'upgrade', 'uninstall', 'debug', 'models', 'stats', 'export', 'import', 'github', 'session', 'plugin', 'db', 'help', 'update'],
    delegatedSubcommands: ['run'],
    resumeFlags: ['--resume', '--continue', '--fork', '-r']
  },
  {
    id: 'opencode2',
    displayName: 'OpenCode 2',
    // VERIFIED per official OpenCode V2 docs: V2 installs and runs as `opencode2`
    // (a separate binary from V1's `opencode`), so both can coexist.
    processNames: ['opencode2.exe', 'opencode2'],
    serviceSubcommands: ['serve', 'web', 'acp', 'attach'],
    utilSubcommands: ['completion', 'mcp', 'providers', 'auth', 'agents', 'upgrade', 'uninstall', 'debug', 'models', 'stats', 'export', 'import', 'github', 'session', 'plugin', 'db', 'help', 'update'],
    delegatedSubcommands: ['run', 'mini'],
    resumeFlags: ['--resume', '--continue', '--fork', '-r']
  },
  {
    id: 'hermes',
    displayName: 'Hermes',
    // Hermes is Python/uv (verified): the process appears as `hermes.exe` (the
    // launcher) OR a `python.exe` child whose command line contains the hermes
    // venv path. Match both.
    processNames: ['hermes.exe', 'hermes', 'hermes-acp.exe', 'hermes-agent.exe'],
    interpreterHosted: [{ interpreter: ['python', 'python3', 'python.exe'], fragments: ['hermes'] }],
    serviceSubcommands: ['serve', 'dashboard', 'gui', 'desktop', 'acp', 'gateway', 'proxy', 'mcp', 'webhook', 'monitoring', 'portal', 'profile'],
    // NOTE: `resume` is intentionally NOT here — `hermes --resume` is a real
    // user session and must be counted.
    utilSubcommands: ['model', 'moa', 'fallback', 'worktree', 'browser', 'secrets', 'egress', 'migrate', 'setup', 'whatsapp', 'whatsapp-cloud', 'slack', 'send', 'logout', 'auth', 'status', 'pause', 'sync', 'webhook', 'peer', 'kanban', 'project', 'hooks', 'doctor', 'verify', 'security', 'approvals', 'dump', 'debug', 'backup', 'checkpoints', 'import', 'import-agent', 'config', 'skin', 'console', 'pairing', 'skills', 'bundles', 'plugins', 'curator', 'pets', 'journey', 'learning', 'memory-graph', 'memory', 'tools', 'computer-use', 'sessions', 'insights', 'claw', 'update', 'uninstall', 'completion', 'logs', 'prompt-size'],
    // One-shot scripted mode.
    delegatedFlags: ['-z', '--oneshot'],
    resumeFlags: ['--resume', '--continue', '-r'],
    interactivePromptFlags: []
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    // `agy` is a native Go binary (verified), NOT a node shim; the legacy
    // `agy.cmd`/`agy.js` fragments are dead and intentionally omitted.
    processNames: ['agy.exe', 'agy'],
    serviceSubcommands: ['mcp', 'mic-serve'],
    utilSubcommands: ['agents', 'changelog', 'help', 'install', 'models', 'plugin', 'plugins', 'update', 'auth', 'doctor'],
    delegatedFlags: ['-p', '--print', '--prompt'],
    resumeFlags: ['-c', '--continue', '--conversation'],
    interactivePromptFlags: ['-i', '--prompt-interactive']
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    // Native binary (verified) AND its npm shim `node .../@anthropic-ai/claude-code/cli.js`
    // (verified). The shim form is required so a node-hosted install is detected as
    // Claude Code, not mis-attributed to another tool whose fragment happens to be a
    // bare `cli.js` basename. Use PATH-BOUNDED fragments only (no bare `cli.js`, which
    // would over-match any `cli.js` on the machine).
    processNames: ['claude.exe', 'claude'],
    interpreterHosted: [{ interpreter: ['node', 'node.exe'], fragments: ['@anthropic-ai/claude-code', 'claude-code'] }],
    serviceSubcommands: ['mcp'],
    utilSubcommands: ['mcp', 'auth', 'gateway', 'doctor', 'update', 'upgrade', 'plugins', 'plugin', 'project', 'setup-token', 'import', 'ultrareview', 'auto-mode', 'help', 'agent', 'sessions'],
    delegatedFlags: ['-p', '--print'],
    resumeFlags: ['-c', '--continue', '-r', '--resume']
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    // npm shim runs node .../@google/gemini-cli/bundle/gemini.js (verified).
    processNames: ['gemini.exe', 'gemini'],
    interpreterHosted: [{ interpreter: ['node', 'node.exe'], fragments: ['@google/gemini-cli', 'gemini-cli', 'gemini.js', 'bundle/gemini.js'] }],
    serviceSubcommands: ['mcp'],
    utilSubcommands: ['help', 'mcp', 'auth', 'update', 'theme'],
    delegatedFlags: ['-p', '--prompt'],
    resumeFlags: ['-r', '--resume', '--continue'],
    interactivePromptFlags: ['-i', '--prompt-interactive']
  },
  {
    id: 'qwen',
    displayName: 'Qwen Code',
    // npm shim runs node .../@qwen-code/qwen-code/cli.js (verified). Match by the
    // path-bounded `@qwen-code/qwen-code` segment (and `cli-entry.js`), NOT a bare
    // `cli.js` basename — a bare `cli.js` fragment over-matches ANY cli.js on the
    // machine (e.g. it was stealing Claude Code's `@anthropic-ai/claude-code/cli.js`).
    processNames: ['qwen.exe', 'qwen'],
    interpreterHosted: [{ interpreter: ['node', 'node.exe'], fragments: ['@qwen-code/qwen-code', 'qwen-code', 'cli-entry.js'] }],
    serviceSubcommands: ['serve', 'mcp', 'extensions', 'hooks'],
    utilSubcommands: ['auth', 'update', 'sessions', 'review', 'help', 'mcp', 'configure'],
    delegatedFlags: ['-p', '--prompt'],
    resumeFlags: ['-c', '--continue', '-r', '--resume'],
    interactivePromptFlags: ['-i', '--prompt-interactive']
  },
  {
    id: 'goose',
    displayName: 'Goose',
    // Rust binary; `goose session` is the interactive launch, `goose run` is
    // delegated. Server/ACP/MCP modes are excluded.
    processNames: ['goose.exe', 'goose'],
    serviceSubcommands: ['serve', 'acp', 'mcp'],
    utilSubcommands: ['configure', 'init', 'help', 'update', 'info', 'version'],
    delegatedSubcommands: ['run'],
    resumeFlags: ['--resume', '--session-id', '-r']
  },
  {
    id: 'kiro',
    displayName: 'Kiro CLI',
    // Native Bun binary (verified). Bare `kiro-cli` launches the interactive
    // agent — requiring `chat` previously MISSED it. `agent` is management.
    processNames: ['kiro-cli.exe', 'kiro-cli'],
    serviceSubcommands: ['serve', 'mcp'],
    utilSubcommands: ['login', 'logout', 'whoami', 'profile', 'settings', 'diagnostic', 'issue', 'update', 'help', 'crew', 'agent'],
    delegatedSubcommands: [],
    resumeFlags: ['--resume', '--resume-id', '--resume-picker', '-r']
  }
];

const BUILTIN_DETECTORS = BUILTIN_SPECS.map(buildDetector);

// Compile a single user/legacy tool spec into a detector.
//
// New schema (preferred):
//   { name, processNames, interpreterHosted?, serviceSubcommands?,
//     utilSubcommands?, delegatedSubcommands?, delegatedFlags?, resumeFlags?,
//     interactivePromptFlags? }
//
// Legacy schema (still accepted, with an UPGRADED interpretation documented in
// README/CHANGELOG):
//   { name, processNames, actionKeywords?, nodeIdentityFragments? }
// Legacy `actionKeywords` were REQUIRED regex gates — that behavior is what
// caused interactive sessions to be missed, so they are reinterpreted as
// *delegated-mode markers* (literal tokens, never regex). Binary presence alone
// now constitutes a session. This is a deliberate, safe migration.
function compileDetectorFromConfig(spec) {
  if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) {
    return null;
  }
  if (!Array.isArray(spec.processNames) || spec.processNames.length === 0) {
    return null;
  }

  // Defensive coercion for every array-typed field. The prior AFS-01 hardening
  // only guarded `interpreterHosted`; the six subcommand/flag fields below were
  // still assumed to be arrays. A user who typo'd one of them as a SCALAR string
  // (e.g. `serviceSubcommands: 'serve'`) hit `(spec.x || []).map is not a function`,
  // and because `compileTools` had no guard, that throw aborted the ENTIRE poll —
  // detection for ALL tools went stale until the config was fixed (the AFS-01
  // impact: "one malformed entry aborts detection for ALL tools"). Coerce any
  // non-array value to an empty set and warn, so a single bad field degrades
  // gracefully instead of taking down the fleet.
  function toSet(field, value) {
    if (value == null) return new Set();
    if (Array.isArray(value)) {
      return new Set(value.map((s) => String(s).toLowerCase()));
    }
    // Present but not an array (scalar / object): degrade to empty and warn.
    warnSkip(spec, `field "${field}" must be an array; got ${typeof value} — ignoring it`);
    return new Set();
  }

  const out = {
    id: spec.name,
    displayName: spec.name,
    processNames: new Set((spec.processNames || []).map((n) => String(n).toLowerCase())),
    interpreterHosted: Array.isArray(spec.interpreterHosted) ? spec.interpreterHosted : null,
    serviceSubcommands: toSet('serviceSubcommands', spec.serviceSubcommands),
    utilSubcommands: toSet('utilSubcommands', spec.utilSubcommands),
    delegatedSubcommands: toSet('delegatedSubcommands', spec.delegatedSubcommands),
    delegatedFlags: toSet('delegatedFlags', spec.delegatedFlags),
    resumeFlags: toSet('resumeFlags', spec.resumeFlags),
    interactivePromptFlags: toSet('interactivePromptFlags', spec.interactivePromptFlags)
  };

  // Migrate legacy fields if the new ones are absent.
  if (!spec.delegatedFlags && Array.isArray(spec.actionKeywords) && spec.actionKeywords.length > 0) {
    // Treat former action keywords as literal delegated-mode markers.
    out.delegatedFlags = new Set(spec.actionKeywords.map((s) => String(s).toLowerCase()));
  }
  if (!spec.interpreterHosted && Array.isArray(spec.nodeIdentityFragments) && spec.nodeIdentityFragments.length > 0) {
    out.interpreterHosted = [{ interpreter: ['node', 'node.exe', 'python', 'python3', 'python.exe'], fragments: spec.nodeIdentityFragments }];
  }

  // `out` is already normalized with Set fields; return it directly. (Do NOT pass it
  // through buildDetector, which expects raw array fields and would re-wrap Sets.)
  return out;
}

// Compile the full active tool list. `configured` is whatever the user set in
// aiFleetStatus.tools (array) or undefined. Returns compiled detectors, falling
// back to built-ins on bad/missing config (consistent with prior behavior).
// Kept as a tiny standalone helper so the warning itself can never throw and abort
// the loop (AFS-01: one bad entry must not take down detection for ALL tools).
function warnSkip(spec, reason) {
  try {
    // eslint-disable-next-line no-console
    console.warn(`aiFleetStatus: skipping malformed tool entry ${spec && spec.name ? JSON.stringify(spec.name) : '(unnamed)'}: ${reason || 'unknown error'}`);
  } catch (_) { /* logging must never throw */ }
}

function compileTools(configured) {
  if (Array.isArray(configured) && configured.length > 0) {
    const compiled = [];
    for (const spec of configured) {
      // Defensive: one malformed custom entry (e.g. a scalar where an array was
      // expected, or any unexpected throw during compilation) must NOT abort
      // compilation of the rest of the list — otherwise a single bad
      // aiFleetStatus.tools entry would take down detection for ALL tools (the
      // AFS-01 impact). Skip the offending entry and warn so the user gets a
      // clear signal rather than a silently-stale extension.
      let detector = null;
      try {
        detector = compileDetectorFromConfig(spec);
      } catch (err) {
        warnSkip(spec, err && err.message);
        continue;
      }
      if (!detector) {
        warnSkip(spec, 'entry rejected by compiler (missing name/processNames)');
        continue;
      }
      compiled.push(detector);
    }
    if (compiled.length > 0) {
      return compiled;
    }
  }
  return BUILTIN_DETECTORS;
}

module.exports = {
  BUILTIN_DETECTORS,
  BUILTIN_SPECS,
  buildDetector,
  compileDetectorFromConfig,
  compileTools,
  detect,
  fragmentInToken
};
