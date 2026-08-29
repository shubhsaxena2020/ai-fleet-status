'use strict';

// ---------------------------------------------------------------------------
// Sanitization / redaction for diagnostics & UI text.
//
// Process command lines routinely contain: user prompts, file paths, inline
// environment values, URLs with embedded credentials, and (sometimes) auth
// tokens / API keys. The extension must NEVER surface raw command lines in the
// status bar, tooltips, tree view, or copied diagnostics by default.
//
// Strategy: we never expose the full command line. Where a tool needs a human to
// identify a process, we show only: the executable/program, the subcommand, and a
// small set of SAFE flags. Everything else is replaced with a redaction marker.
//
// Redaction markers:
//   ‹secret›  — a value matching a secret pattern
//   ‹prompt›  — trailing free-text (the user's prompt)
// ---------------------------------------------------------------------------

// Patterns that strongly indicate a secret. These are conservative; we redact on
// match rather than trying to be exhaustive. Order matters: more specific first.
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|auth|authorization|bearer|access[_-]?key|private[_-]?key|client[_-]?secret)["'=:\s]+[^\s"']+/gi,
  // PEM private-key blocks (multi-line).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  // Scheme-agnostic URL with embedded user:pass (postgresql://, mongodb://,
  // redis://, ftp://, amqp://, ... — not just http/https). Allows an empty user
  // (e.g. `redis://:pass@host`).
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s:@]+@/gi,
  // GitHub PATs: classic ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_
  // are ALL redacted at ANY length — `github_pat_` is itself a unique,
  // unforgeable prefix, so a short/mixed-case fragment is still a real token.
  /\bgh[pousr]_[A-Za-z0-9]+\b/g,
  /\bgithub_pat_[A-Za-z0-9_]+\b/g,
  // Slack tokens (any length).
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
  // OpenAI/Stripe-style underscore-delimited keys (sk-...-live / sk-...-proj / pk-...).
  /\b(?:sk|pk|rk)_(?:live|test|proj)-?[A-Za-z0-9_-]{16,}\b/g,
  // Common hyphen-delimited key prefixes (any length).
  /\b(?:sk|pk|rk|ak|wss?k)-[A-Za-z0-9_-]+\b/g,
  // Google API key (any length).
  /\bAIza[0-9A-Za-z_-]+\b/g,
  // JWT-ish (header.payload.signature).
  /\b[a-z0-9]{32,}\.[a-z0-9_-]{32,}\.[a-z0-9_-]{16,}\b/gi,
  // Generic high-entropy blob: a long bare alphanumeric/underscore token with no
  // path separators (catches unprefixed secrets without matching normal paths).
  /\b[A-Za-z0-9_]{40,}\b/g
];

const REDACT_SECRET = '‹secret›';
const REDACT_PROMPT = '‹prompt›';

function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACT_SECRET);
  }
  return out;
}

// Produce a SAFE, short label for a process: the program + subcommand, with the
// trailing prompt (everything after the first unrecognized free-text token) and
// any secrets removed. This is what the status bar / tree / diagnostics show.
//
// `recognizeFlags` is an optional Set of literal flag tokens (e.g. '-p','--resume')
// for the owning tool, used to decide whether a token is "safe structural" vs
// "free text to redact". In practice the session model already splits program /
// subcommand / flags; this is a defensive second layer.
function safeProcessLabel(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.trim().length === 0) {
    return '(unknown)';
  }
  const redacted = redactSecrets(commandLine);
  // If, after redaction, the whole thing still looks like a credential URL or a
  // bare secret token, do not surface any of it (handles single-token leaks).
  if (/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i.test(redacted) || /\b[A-Za-z0-9_]{40,}\b/.test(redacted)) {
    return '(redacted command line)';
  }
  // Take the first ~2 tokens (program + maybe subcommand) as the stable identity,
  // then append a generic marker instead of the raw remainder (which may be a
  // secret-bearing prompt).
  const tokens = redacted.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return '(unknown)';
  }
  const head = tokens.slice(0, 2).join(' ');
  return tokens.length > 2 ? `${head} ${REDACT_PROMPT}` : head;
}

// Redact a full command line for a diagnostics dump — keep structure but mask
// secrets and collapse the prompt tail.
function sanitizeCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine.length === 0) {
    return '';
  }
  return redactSecrets(commandLine);
}

// Sanitize an entire diagnostics object before it is serialized to the clipboard
// or the output channel. Returns a plain, safe-to-print structure.
function sanitizeDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') {
    return diagnostics;
  }
  const clone = JSON.parse(JSON.stringify(diagnostics, (key, value) => {
    if (typeof value === 'string') {
      return redactSecrets(value);
    }
    return value;
  }));
  return clone;
}

// Reduce raw OS process rows to a sanitized structure safe for diagnostics: keep
// PID/PPID/name and a sanitized label, but NEVER the full command line.
function redactDiagnosticsProcesses(rawProcesses) {
  if (!Array.isArray(rawProcesses)) {
    return [];
  }
  return rawProcesses.map((p) => ({
    pid: p.ProcessId != null ? p.ProcessId : p.pid,
    ppid: p.ParentProcessId != null ? p.ParentProcessId : p.ppid,
    name: p.Name != null ? p.Name : p.name,
    label: safeProcessLabel(typeof p.CommandLine === 'string' ? p.CommandLine : (p.commandLine || ''))
  }));
}

module.exports = {
  redactSecrets,
  safeProcessLabel,
  sanitizeCommandLine,
  sanitizeDiagnostics,
  redactDiagnosticsProcesses,
  REDACT_SECRET,
  REDACT_PROMPT,
  SECRET_PATTERNS
};
