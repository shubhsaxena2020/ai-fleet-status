'use strict';

// ===========================================================================
// DEPRECATED — superseded by lib/detect.js (the v0.3.0 detection pipeline).
// This module is retained ONLY so test/unit.test.js (the original 27 regression
// tests) keeps compiling. Production code (extension.js) does NOT import it.
// Do not add new behavior here; update lib/detect.js instead.
// ===========================================================================

// Tools are described as plain data (process names + action keywords + node-shim
// identity fragments) rather than raw user-supplied regex strings. This is the same
// shape a VS Code setting can hold in JSON, and it lets classification reuse the exact
// bounded-match logic below for every tool - including ones a user adds - instead of
// trusting arbitrary regex text from settings.json (typo/ReDoS risk).
const DEFAULT_TOOLS = [
  {
    name: 'Codex',
    processNames: ['codex.exe', 'codex'],
    actionKeywords: ['exec'],
    nodeIdentityFragments: ['codex', 'codex.cmd', 'codex.exe', 'codex.js']
  },
  {
    name: 'OpenCode',
    processNames: ['opencode.exe', 'opencode'],
    actionKeywords: ['run'],
    nodeIdentityFragments: ['opencode', 'opencode.cmd', 'opencode.exe', 'opencode.js', 'opencode.mjs', 'opencode-ai']
  },
  {
    name: 'Hermes',
    processNames: ['hermes.exe', 'hermes'],
    actionKeywords: ['-z'],
    nodeIdentityFragments: ['hermes', 'hermes.cmd', 'hermes.exe', 'hermes.js', 'hermes-agent']
  },
  {
    name: 'Antigravity',
    processNames: ['agy.exe', 'agy'],
    actionKeywords: ['-p', '--print(?:=[^\\s"\']*)?'],
    nodeIdentityFragments: ['agy', 'agy.cmd', 'agy.exe', 'agy.js']
  },
  {
    name: 'Claude Code',
    processNames: ['claude.exe', 'claude'],
    actionKeywords: ['-p', '--print(?:=[^\\s"\']*)?'],
    nodeIdentityFragments: ['claude', 'claude.cmd', 'claude.exe', '@anthropic-ai/claude-code']
  },
  {
    name: 'Gemini CLI',
    processNames: ['gemini.exe', 'gemini'],
    actionKeywords: ['-p', '--prompt(?:=[^\\s"\']*)?'],
    nodeIdentityFragments: ['gemini', 'gemini.cmd', '@google/gemini-cli', 'bundle/gemini.js']
  },
  {
    name: 'Qwen Code',
    processNames: ['qwen.exe', 'qwen'],
    actionKeywords: ['-p'],
    nodeIdentityFragments: ['qwen', 'qwen.cmd', '@qwen-code/qwen-code', 'cli-entry.js']
  },
  {
    name: 'Goose',
    processNames: ['goose.exe', 'goose'],
    actionKeywords: ['run', '--resume', '--session-id'],
    nodeIdentityFragments: ['goose']
  },
  {
    name: 'Kiro CLI',
    processNames: ['kiro-cli.exe', 'kiro-cli'],
    actionKeywords: ['chat'],
    nodeIdentityFragments: ['kiro-cli']
  }
];

// Maximum length of a single user-supplied action keyword before it is ignored.
// Long enough for any real flag, short enough to bound the cost of compiling and
// matching it. A pathological multi-kilobyte "keyword" is rejected rather than
// compiled into a regex (defense against resource-exhaustion / ReDoS).
const MAX_KEYWORD_LENGTH = 64;

// Sanitize a single USER-SUPPLIED action keyword (untrusted source):
//   - escape every regex metacharacter so the text is matched LITERALLY (no longer
//     interpreted as a pattern — closes the legacy actionKeywords ReDoS / injection
//     surface, AFS-05);
//   - enforce a length cap so an absurdly long token can't blow up compile/match cost.
// Trusted, project-authored patterns (DEFAULT_TOOLS) are passed through unescaped and
// are allowed to use real regex syntax; they are still length-capped as defense-in-depth.
function sanitizeKeyword(keyword, trusted) {
  if (typeof keyword !== 'string' || keyword.length === 0) {
    return null;
  }
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    return null;
  }
  const k = keyword.trim();
  if (k.length === 0) {
    return null;
  }
  if (trusted) {
    return k; // project-authored pattern; treated as regex, but length-capped above.
  }
  // User-supplied: escape regex specials so the token is matched literally and can
  // never be compiled into a backtracking-prone pattern.
  return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The word/flag boundary this builds is deliberately conservative: the action keyword
// must be its own whitespace/quote-delimited token, so "codex exec" is required rather
// than any substring containing "exec". User-supplied keywords are SANITIZED to literal
// text (see sanitizeKeyword) so a malicious or malformed regex in settings cannot be
// compiled verbatim and cause a ReDoS.
function boundedWordRegex(patternSource) {
  return new RegExp(`(?:^|[\\s"'])(?:${patternSource})(?:$|[\\s"'])`, 'i');
}

// Fragments are authored with forward slashes (e.g. "bundle/gemini.js") for
// readability, but a real Windows command line uses backslashes for that same path
// segment (npm creates node_modules\@scope\pkg\... with OS-native separators even
// though the package name itself always uses "/"). Each "/" in a fragment is turned
// into a "[/\\]" alternation so the fragment matches the real path text on either OS.
function boundedPathRegex(fragments) {
  const escaped = fragments
    .map((fragment) => fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[/\\\\]'))
    .join('|');
  return new RegExp(`(?:^|[\\s"'\\/\\\\])(?:${escaped})(?:$|[\\s"'\\/\\\\])`, 'i');
}

function compileTool(tool, trusted = false) {
  const keywords = (tool.actionKeywords || []).map((kw) => sanitizeKeyword(kw, trusted)).filter(Boolean);
  return {
    name: tool.name,
    processNames: new Set((tool.processNames || []).map((name) => name.toLowerCase())),
    // Keywords are length-capped (defense-in-depth) and, for user-supplied input,
    // escaped to literal text — so joining with '|' is safe and cannot reintroduce a
    // user-injected regex. If every keyword was empty/oversized, the alternation is
    // empty and the match simply never fires (fail-closed).
    actionRegex: boundedWordRegex(keywords.join('|')),
    nodeIdentityRegex: tool.nodeIdentityFragments && tool.nodeIdentityFragments.length
      ? boundedPathRegex(tool.nodeIdentityFragments)
      : null
  };
}

// Validates and normalizes tool config into compiled detectors.
// `trusted` should be true ONLY for project-authored DEFAULT_TOOLS (which may use
// real regex syntax in their actionKeywords); user-supplied settings must be passed
// with `trusted=false` so each keyword is escaped to literal text (AFS-05 ReDoS fix).
function compileTools(rawTools, trusted = false) {
  if (!Array.isArray(rawTools)) {
    return [];
  }

  const compiled = [];

  for (const tool of rawTools) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) {
      continue;
    }

    if (!Array.isArray(tool.processNames) || tool.processNames.length === 0) {
      continue;
    }

    if (!Array.isArray(tool.actionKeywords) || tool.actionKeywords.length === 0) {
      continue;
    }

    try {
      compiled.push(compileTool(tool, trusted));
    } catch {
      // Malformed keyword produced an invalid regex (e.g. unbalanced group) - skip it.
      continue;
    }
  }

  return compiled;
}

module.exports = {
  DEFAULT_TOOLS,
  boundedWordRegex,
  boundedPathRegex,
  compileTools
};
