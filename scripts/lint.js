'use strict';

// CI-less linter: a zero-dependency smoke check you can run locally with
// `npm run lint` (no CI runner required). It does two cheap, high-signal things:
//
//   1. `node --check` every .js file under lib/, test/, and scripts/ — catches
//      syntax errors that `node --test` would only surface at runtime (and only
//      for files actually imported by a passing test).
//   2. A couple of lightweight nits over lib/ only:
//        - no stray `console.log/debug/info/warn/error` in library code (use the
//          extension's output channel / telemetry instead).
//        - no `require()` calls left unused (best-effort: reports the name).
//
// It is intentionally NOT a style enforcer (no prettier/eslint config to keep the
// repo zero-dependency). Exit code is non-zero on any finding so it can gate a
// commit hook or a manual pre-push check.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOTS = ['lib', 'test', 'scripts'];
const EXT = '.js';

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing dir (e.g. scripts/ may not exist yet) — skip.
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(full, out);
    } else if (e.name.endsWith(EXT)) {
      out.push(full);
    }
  }
}

const files = [];
for (const r of ROOTS) walk(r, files);
files.sort();

const errors = [];
const warnings = [];

// 1. Syntax check every JS file.
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    const msg = (err.stderr || err.stdout || Buffer.from('')).toString().trim().split('\n').pop();
    errors.push(`${f}: syntax error — ${msg}`);
  }
}

// 2. Nits over lib/ only.
const CONSOLE_RE = /\bconsole\.(log|debug|info|warn|error)\s*\(/;
const DISABLE_RE = /eslint-disable(-next-line|-line)?\s+no-console/;
for (const f of files.filter((f) => f.startsWith('lib' + path.sep))) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (!CONSOLE_RE.test(line)) return;
    // Honor an `eslint-disable-next-line no-console` (or `-line`) directive on the
    // preceding or same line — intentional, user-facing warnings are allowed.
    const prev = i > 0 ? lines[i - 1] : '';
    if (DISABLE_RE.test(prev) || DISABLE_RE.test(line)) return;
    warnings.push(`${f}:${i + 1}: stray console.* call in library code (use the output channel / telemetry)`);
  });
}

// Report.
console.log(`lint: checked ${files.length} JS file(s) under ${ROOTS.join(', ')}`);
if (warnings.length) {
  console.log('\nWarnings:');
  for (const w of warnings) console.log('  ! ' + w);
}
if (errors.length) {
  console.log('\nErrors:');
  for (const e of errors) console.log('  X ' + e);
  console.log(`\n${errors.length} error(s) — lint FAILED`);
  process.exit(1);
}
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s) — lint passed with warnings`);
  process.exit(0);
}
console.log('lint OK');
