'use strict';

// Status-bar + summary formatting. Pure functions, no VS Code dependency.

const MAX_SHORT_LABEL_LENGTH = 24;

// Compact status-bar text. Mirrors the brief's compact format:
//   $(circle-slash) AI: idle
//   $(sync~spin) AI: Claude ×4
//   $(sync~spin) AI: Claude ×4 · Codex ×2
//   $(sync~spin) AI: 5 tools · 12 sessions
// Short label for the status-bar named form. The full displayName (e.g.
// "Claude Code") is too long for the 24-char gate, so we use the first
// whitespace-delimited token ("Claude", "Gemini", "OpenCode 2" -> "OpenCode").
// The full displayName is still used everywhere else (tooltip, tree, Quick Pick).
function shortName(displayName) {
  if (!displayName) {
    return '';
  }
  const trimmed = String(displayName).trim();
  const spaceIndex = trimmed.indexOf(' ');
  return spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
}

function summarizeStatusBar(fleet) {
  if (!fleet || !fleet.tools || fleet.toolCount === 0) {
    return '$(circle-slash) AI: idle';
  }

  const active = [];
  for (const tool of fleet.tools.values()) {
    if (tool.sessions.length > 0) {
      active.push({ name: shortName(tool.displayName), sessions: tool.sessions.length });
    }
  }
  active.sort((a, b) => b.sessions - a.sessions);

  if (active.length <= 2) {
    const joined = active.map((t) => `${t.name} ×${t.sessions}`).join(' · ');
    if (joined.length <= MAX_SHORT_LABEL_LENGTH) {
      return `$(sync~spin) AI: ${joined}`;
    }
  }

  return `$(sync~spin) AI: ${fleet.toolCount} tools · ${fleet.sessionCount} sessions`;
}

// Hover tooltip body (plain text; Markdown assembly happens in extension.js).
function summarizeFleet(fleet) {
  if (!fleet || !fleet.tools || fleet.toolCount === 0) {
    return {
      activeTools: '',
      totalTools: 0,
      totalSessions: 0,
      totalProcesses: 0
    };
  }
  const lines = [];
  let totalProcesses = 0;
  for (const tool of fleet.tools.values()) {
    if (tool.sessions.length === 0) {
      continue;
    }
    const procTotal = tool.sessions.reduce((acc, s) => acc + s.processCount, 0);
    totalProcesses += procTotal;
    lines.push(`${tool.displayName} — ${tool.sessions.length} session${tool.sessions.length === 1 ? '' : 's'} · ${procTotal} processes`);
  }
  // Prefer an explicitly provided fleet-wide count when present (buildFleet sets it),
  // otherwise fall back to the sum computed above from the tool sessions.
  const fleetProcessCount = (typeof fleet.processCount === 'number') ? fleet.processCount : totalProcesses;
  return {
    activeTools: lines.join('\n'),
    totalTools: fleet.toolCount,
    totalSessions: fleet.sessionCount,
    totalProcesses: fleetProcessCount
  };
}

module.exports = { summarizeStatusBar, summarizeFleet };
