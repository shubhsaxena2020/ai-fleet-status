'use strict';

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

// The word/flag boundary this builds is deliberately conservative: the action keyword
// must be its own whitespace/quote-delimited token, so "--mode=execute" does not match
// an "exec" keyword and "codex exec" is required rather than any substring containing
// "exec". Same bounded-match reasoning applies to boundedPathRegex below.
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

function compileTool(tool) {
  return {
    name: tool.name,
    processNames: new Set((tool.processNames || []).map((name) => name.toLowerCase())),
    actionRegex: boundedWordRegex(tool.actionKeywords.join('|')),
    nodeIdentityRegex: tool.nodeIdentityFragments && tool.nodeIdentityFragments.length
      ? boundedPathRegex(tool.nodeIdentityFragments)
      : null
  };
}

// Validates and normalizes user-supplied tool config from the `aiFleetStatus.tools`
// setting. Silently drops malformed entries rather than throwing - a bad entry in a
// user's settings.json should degrade gracefully, not break the whole extension.
function compileTools(rawTools) {
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
      compiled.push(compileTool(tool));
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
