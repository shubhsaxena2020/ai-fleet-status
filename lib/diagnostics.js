'use strict';

const { sanitizeDiagnostics } = require('./sanitize');

// Build a sanitized diagnostics object safe to expose in the output channel or to
// copy to the clipboard. No full command lines, prompts, or secrets leave here.
function buildDiagnostics(context) {
  const {
    version,
    platform,
    arch,
    scope, // 'local' | 'wsl:<distro>' | 'remote-ssh' | etc.
    tools, // compiled detector list (ids/displayNames only)
    fleet, // result of buildFleet
    lastError,
    pollLatencyMs,
    wslScanned
  } = context;

  const toolSummary = [];
  for (const [id, tool] of fleet.tools) {
    toolSummary.push({
      id,
      displayName: tool.displayName,
      sessions: tool.sessions.length,
      processCount: tool.sessions.reduce((a, s) => a + s.processCount, 0),
      services: tool.services.length
    });
  }

  const sessions = fleet.sessions.map((s) => ({
    id: s.id,
    tool: s.displayName,
    mode: s.mode,
    confidence: s.confidence,
    rootPid: s.rootPid,
    processCount: s.processCount,
    scope: s.scope,
    terminal: s.terminal ? { name: s.terminal.name, integrated: s.terminal.integrated } : null,
    // Sanitized member labels only — never raw command lines.
    members: s.members.map((m) => ({
      pid: m.pid,
      name: m.name,
      label: require('./sanitize').safeProcessLabel(m.commandLine)
    }))
  }));

  const raw = {
    extension: 'ai-fleet-status',
    version,
    platform,
    arch,
    scope: scope || 'local',
    wslScanned: Boolean(wslScanned),
    configuredTools: (tools || []).map((t) => t.id),
    activeToolCount: fleet.toolCount,
    sessionCount: fleet.sessionCount,
    processCount: fleet.processCount,
    pollLatencyMs: typeof pollLatencyMs === 'number' ? Math.round(pollLatencyMs) : null,
    lastError: lastError || null,
    tools: toolSummary,
    sessions,
    generatedAt: new Date().toISOString()
  };

  return sanitizeDiagnostics(raw);
}

function diagnosticsAsText(diagnostics) {
  // Compact, human-readable, still sanitized (diagnostics is already sanitized).
  const lines = [];
  lines.push(`AI Fleet Status diagnostics`);
  lines.push(`version: ${diagnostics.version}`);
  lines.push(`platform: ${diagnostics.platform} (${diagnostics.arch})`);
  lines.push(`scope: ${diagnostics.scope}${diagnostics.wslScanned ? ' (WSL scanned)' : ''}`);
  lines.push(`tools configured: ${diagnostics.configuredTools.length}`);
  lines.push(`active tools: ${diagnostics.activeToolCount} · sessions: ${diagnostics.sessionCount} · processes: ${diagnostics.processCount}`);
  if (diagnostics.lastError) {
    lines.push(`last error: ${diagnostics.lastError}`);
  }
  if (diagnostics.pollLatencyMs != null) {
    lines.push(`last poll latency: ${diagnostics.pollLatencyMs} ms`);
  }
  lines.push('');
  lines.push('Per tool:');
  for (const t of diagnostics.tools) {
    if (t.sessions === 0 && t.services === 0) {
      lines.push(`  ${t.displayName}: idle`);
    } else {
      lines.push(`  ${t.displayName}: ${t.sessions} session(s), ${t.processCount} process(es)${t.services ? `, ${t.services} service(s)` : ''}`);
    }
  }
  lines.push('');
  lines.push('Sessions:');
  if (diagnostics.sessions.length === 0) {
    lines.push('  (none)');
  }
  for (const s of diagnostics.sessions) {
    const term = s.terminal ? ` [${s.terminal.integrated ? 'integrated' : 'external'}:${s.terminal.name}]` : ' [OS process]';
    lines.push(`  ${s.tool} · ${s.mode} · root PID ${s.rootPid} · ${s.processCount} proc(s) · ${s.scope}${term}`);
  }
  return lines.join('\n');
}

module.exports = { buildDiagnostics, diagnosticsAsText };
