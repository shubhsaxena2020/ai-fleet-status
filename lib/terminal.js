'use strict';

// Terminal correlation: map detected AI sessions to the VS Code integrated terminal
// whose shell spawned them, using the real VS Code API. Kept separate from
// extension.js so the graph math is unit-testable without a live extension host.
//
// The link is: terminal.shellProcessId -> (ancestor/descendant in the OS process
// graph) -> AI session root. A terminal's shell is typically the ANCESTOR of the AI
// process (user opens an integrated terminal, then runs `claude`). So if an AI
// session's root pid is a DESCENDANT of a terminal shell pid, we correlate them.
// We also handle the direct-child case. Processes we cannot tie to a terminal are
// honestly reported as 'External / OS process' — we never fabricate Terminal
// objects.

class TerminalCorrelator {
  constructor() {
    /** @type {Map<number, {name:string, integrated:boolean}>} pid -> terminal meta */
    this.terminalsByShellPid = new Map();
  }

  // Refresh the known terminal shell pids. `vscodeTerminals` is the array from
  // vscode.window.terminals. Terminal.processId is a Promise; we await it. Shell
  // integration is NOT required for this — processId works for the shell itself.
  async refresh(vscodeTerminals) {
    this.terminalsByShellPid.clear();
    const pending = [];
    for (const term of vscodeTerminals) {
      const integrated = !(term.creationOptions && term.creationOptions.name === undefined && term.exitStatus);
      pending.push(
        Promise.resolve(term.processId)
          .then((pid) => {
            if (typeof pid === 'number' && pid > 0) {
              this.terminalsByShellPid.set(pid, {
                name: term.name,
                integrated: term.exitStatus === undefined
              });
            }
          })
          .catch(() => { /* terminal may have closed; ignore */ })
      );
    }
    await Promise.all(pending);
  }

  // Given a process graph and the pid of a session root, find a correlated terminal
  // (or null). `graph` is a ProcessGraph from lib/process-model.js.
  correlate(graph, sessionRootPid) {
    if (!graph || !this.terminalsByShellPid.size) {
      return undefined;
    }
    // 1. Direct match: the session root IS the terminal shell.
    if (this.terminalsByShellPid.has(sessionRootPid)) {
      return this.terminalsByShellPid.get(sessionRootPid);
    }
    // 2. Ancestor: walk UP from the session root; if any ancestor pid is a known
    //    terminal shell, that terminal spawned this session.
    const ancestors = graph.ancestors(sessionRootPid);
    for (let i = 1; i < ancestors.length; i++) {
      const pid = ancestors[i].pid;
      if (this.terminalsByShellPid.has(pid)) {
        return this.terminalsByShellPid.get(pid);
      }
    }
    return undefined;
  }
}

module.exports = { TerminalCorrelator };
