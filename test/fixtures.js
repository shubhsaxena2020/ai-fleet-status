'use strict';

// Adversarial process-row fixtures used across the new test suites.
// These encode the topologies called out in the project spec: single session, many
// sessions, helper processes, nested shells, PID reuse, malformed fields, etc.
// Each row matches the canonical shape produced by lib/enumerate.js:
//   { ProcessId, ParentProcessId, Name, CommandLine, CreationDate?, scope? }

const FIX = {};

// 1) One tool, ONE session, one process.
FIX.oneSession = [
  { ProcessId: 1001, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe' }
];

// 2) One tool, FOUR independent sessions (different roots), one process each.
FIX.fourSessions = [
  { ProcessId: 1001, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe' },
  { ProcessId: 1010, ParentProcessId: 201, Name: 'claude.exe', CommandLine: 'claude.exe' },
  { ProcessId: 1020, ParentProcessId: 202, Name: 'claude.exe', CommandLine: 'claude.exe -p "hi"' },
  { ProcessId: 1030, ParentProcessId: 203, Name: 'claude.exe', CommandLine: 'claude.exe --resume' }
];

// 3) One session with several helper processes.
//    root claude.exe, a node helper, a bash wrapper descendant, all same session.
FIX.oneSessionHelpers = [
  { ProcessId: 1001, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe' },
  { ProcessId: 1002, ParentProcessId: 1001, Name: 'node.exe', CommandLine: 'node.exe helper.js' },
  { ProcessId: 1003, ParentProcessId: 1001, Name: 'bash.exe', CommandLine: 'bash.exe -c "git status"' }
];

// 4) Nested shell -> node/python -> AI binary.
FIX.nestedShell = [
  { ProcessId: 200, ParentProcessId: 100, Name: 'powershell.exe', CommandLine: 'powershell.exe -Command claude' },
  { ProcessId: 1001, ParentProcessId: 200, Name: 'node.exe', CommandLine: 'node.exe' },
  { ProcessId: 1002, ParentProcessId: 1001, Name: 'claude.exe', CommandLine: 'claude.exe' }
];

// 5) TWO independent sessions sharing a shell ancestor (different descendants).
FIX.sharedAncestor = [
  { ProcessId: 200, ParentProcessId: 100, Name: 'bash.exe', CommandLine: 'bash.exe' },
  { ProcessId: 1001, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe' },
  { ProcessId: 1002, ParentProcessId: 200, Name: 'codex.exe', CommandLine: 'codex.exe' }
];

// 6) Duplicate OS rows (same PID/command twice).
FIX.duplicateRows = [
  { ProcessId: 1001, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe' },
  { ProcessId: 1001, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe' }
];

// 7) PID-prefix collision: PIDs 12 and 123 must not collide as numeric IDs.
FIX.pidPrefix = [
  { ProcessId: 12, ParentProcessId: 1, Name: 'claude.exe', CommandLine: 'claude.exe' },
  { ProcessId: 123, ParentProcessId: 1, Name: 'codex.exe', CommandLine: 'codex.exe' }
];

// 8) Process death mid-poll: PPID points to a process not in the list, and a
//    member PID is missing its parent mid-chain. Must not crash; parent lookup fails gracefully.
FIX.deadParent = [
  { ProcessId: 1001, ParentProcessId: 9999, Name: 'claude.exe', CommandLine: 'claude.exe' },
  { ProcessId: 1002, ParentProcessId: 1001, Name: 'node.exe', CommandLine: 'node.exe helper.js' }
];

// 9) Missing command line (null) — must not crash, must still classify by name.
FIX.missingCmdline = [
  { ProcessId: 1001, ParentProcessId: 200, Name: 'claude.exe', CommandLine: null }
];

// 10) Same tool executable used in unrelated text (a directory named like the tool
//     must NOT be a session unless it is genuinely the binary path).
FIX.nameInPathOnly = [
  { ProcessId: 1001, ParentProcessId: 200, Name: 'node.exe', CommandLine: 'node.exe C:/repos/claude-wrapper/script.js' }
];

// 11) Scripts in directories whose names resemble another AI tool.
FIX.dirResemblesTool = [
  { ProcessId: 1001, ParentProcessId: 200, Name: 'node.exe', CommandLine: 'node.exe C:/repos/qwen-forks/myapp.js' }
];

// 12) Very long command line.
FIX.longCmdline = [
  {
    ProcessId: 1001,
    ParentProcessId: 200,
    Name: 'claude.exe',
    CommandLine: 'claude.exe -p "' + 'x'.repeat(20000) + '"'
  }
];

// 13) Unicode paths.
FIX.unicodePath = [
  {
    ProcessId: 1001,
    ParentProcessId: 200,
    Name: 'node.exe',
    CommandLine: 'node.exe C:/ユーザー/用户/.npm-global/node_modules/@qwen-code/qwen-code/cli.js -p hi'
  }
];

// 14) Paths containing spaces (Windows Program Files).
FIX.spacedPath = [
  {
    ProcessId: 1001,
    ParentProcessId: 200,
    Name: 'node.exe',
    CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\.npm-global\\node_modules\\@qwen-code\\qwen-code\\cli.js" -p hi'
  }
];

// 15) Windows quoting + backslashes.
FIX.windowsQuoting = [
  {
    ProcessId: 1001,
    ParentProcessId: 200,
    Name: 'hermes.exe',
    CommandLine: 'hermes.exe chat --dir "C:\\Users\\me\\Projects\\alpha beta"'
  }
];

// 16) POSIX quoting.
FIX.posixQuoting = [
  {
    ProcessId: 1001,
    ParentProcessId: 200,
    Name: 'node',
    CommandLine: 'node "/home/me/.npm-global/lib/node_modules/@qwen-code/qwen-code/cli.js" -p hi'
  }
];

// 17) Malformed fields: non-numeric PIDs, NaN parents.
FIX.malformed = [
  { ProcessId: 'abc', ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe' },
  { ProcessId: 1001, ParentProcessId: 'NaN', Name: 'claude.exe', CommandLine: 'claude.exe' },
  { ProcessId: 1002, ParentProcessId: 1001, Name: 'node.exe', CommandLine: 'node.exe helper.js' }
];

// 18) Control characters in command line.
FIX.controlChars = [
  { ProcessId: 1001, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe\x00--print\x07"hi"' }
];

// 19) Service/daemon modes must be excluded from sessions.
FIX.serviceModes = [
  { ProcessId: 1004, ParentProcessId: 200, Name: 'hermes.exe', CommandLine: 'hermes.exe serve --port 9120' },
  { ProcessId: 1005, ParentProcessId: 200, Name: 'hermes.exe', CommandLine: 'hermes.exe chat' },
  { ProcessId: 1006, ParentProcessId: 200, Name: 'codex.exe', CommandLine: 'codex.exe app-server' },
  { ProcessId: 1007, ParentProcessId: 200, Name: 'opencode', CommandLine: 'opencode serve' }
];

// 20) Multiple tools simultaneously.
FIX.multiTool = [
  { ProcessId: 1001, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe' },
  { ProcessId: 1002, ParentProcessId: 201, Name: 'codex.exe', CommandLine: 'codex.exe' },
  { ProcessId: 1003, ParentProcessId: 202, Name: 'hermes.exe', CommandLine: 'hermes.exe chat' },
  { ProcessId: 1004, ParentProcessId: 203, Name: 'agy', CommandLine: 'agy' }
];

// 21) Qwen via node shim (both cli.js and cli-entry.js entrypoints).
FIX.qwenShim = [
  {
    ProcessId: 1003,
    ParentProcessId: 300,
    Name: 'node.exe',
    CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\.npm-global\\node_modules\\@qwen-code\\qwen-code\\cli.js" -p "say hi"'
  },
  {
    ProcessId: 1008,
    ParentProcessId: 301,
    Name: 'node.exe',
    CommandLine: 'node.exe C:/Users/me/.npm-global/node_modules/@qwen-code/qwen-code/dist/cli-entry.js'
  }
];

// 22) Kiro bare invocation (no 'chat' token) — old config missed this.
FIX.kiroBare = [
  { ProcessId: 1030, ParentProcessId: 200, Name: 'kiro-cli.exe', CommandLine: 'kiro-cli.exe' },
  { ProcessId: 1031, ParentProcessId: 201, Name: 'kiro-cli', CommandLine: 'kiro-cli --tui' }
];

// 23) OpenCode 1 vs OpenCode 2 naming.
FIX.opencodeVariants = [
  { ProcessId: 1101, ParentProcessId: 200, Name: 'opencode', CommandLine: 'opencode' },
  { ProcessId: 1102, ParentProcessId: 201, Name: 'opencode2', CommandLine: 'opencode2' }
];

// 24) Full real-evidence fixture (from live process dump + adversarial additions).
//     Mirrors what the production poll produces on the dev host.
FIX.realEvidence = [
  // Claude: 4 sessions. 1001 interactive root + 2 helper procs (1002 node, 1003 bash).
  { ProcessId: 1001, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe --output-format stream-json', CreationDate: 1700000001000 },
  { ProcessId: 1002, ParentProcessId: 1001, Name: 'node.exe', CommandLine: 'node.exe helper.js', CreationDate: 1700000001100 },
  { ProcessId: 1003, ParentProcessId: 1001, Name: 'bash.exe', CommandLine: 'bash.exe -c git', CreationDate: 1700000001200 },
  { ProcessId: 1010, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe', CreationDate: 1700000002000 },
  { ProcessId: 1011, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe -p "fix bug"', CreationDate: 1700000003000 },
  { ProcessId: 1020, ParentProcessId: 200, Name: 'claude.exe', CommandLine: 'claude.exe', CreationDate: 1700000004000 },
  // Codex: bare interactive (no exec keyword) + app-server must be a service.
  { ProcessId: 1002 + 20, ParentProcessId: 200, Name: 'codex.exe', CommandLine: 'codex.exe -c features.code_mode=on', CreationDate: 1700000010000 },
  { ProcessId: 1002 + 21, ParentProcessId: 200, Name: 'codex.exe', CommandLine: 'codex.exe app-server', CreationDate: 1700000011000 },
  // Hermes: serve must be excluded as service; chat must be a session.
  { ProcessId: 1004, ParentProcessId: 200, Name: 'hermes.exe', CommandLine: 'hermes.exe serve --port 9120', CreationDate: 1700000020000 },
  { ProcessId: 1005, ParentProcessId: 200, Name: 'hermes.exe', CommandLine: 'hermes.exe chat', CreationDate: 1700000021000 },
  // Qwen node shim.
  { ProcessId: 1003 + 30, ParentProcessId: 300, Name: 'node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\.npm-global\\node_modules\\@qwen-code\\qwen-code\\cli.js" -p "say hi"', CreationDate: 1700000030000 },
  // Kiro bare.
  { ProcessId: 1030, ParentProcessId: 200, Name: 'kiro-cli.exe', CommandLine: 'kiro-cli.exe', CreationDate: 1700000040000 },
  // Antigravity.
  { ProcessId: 1031, ParentProcessId: 200, Name: 'agy', CommandLine: 'agy', CreationDate: 1700000050000 }
];

// Helper: attach a CreationDate basis to fixtures that lack one, for PID-reuse tests.
function withCreation(fixture, base) {
  return fixture.map((row, i) => ({ ...row, CreationDate: (base || 1700000000000) + i * 100 }));
}

module.exports = {
  FIX,
  withCreation
};
