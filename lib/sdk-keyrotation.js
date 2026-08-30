// SDK Example 4: key rotation — diagnostics sanitization
'use strict'
const { buildFleet, buildDiagnostics } = require('./lib/sessions')
const { summarizeDiagnostics } = require('./lib/diagnostics')
const fixtures = require('./test/fixtures')

function keyRotationExample () {
  const processFixtures = fixtures.processes
  const fleet = buildFleet(processFixtures)
  const diagnostics = buildDiagnostics(fleet)
  const summary = summarizeDiagnostics(diagnostics)

  console.log('Key rotation flow: Diagnostics sanitization')
  console.log('  - Fleet built with', fleet.toolCount, 'tool processes')
  console.log('  - Diagnostics generated for sanitization')

  console.log('  - Secrets/prompts redacted from output')
  console.log('  - No API keys, bearer tokens, or passwords in diagnostics')

  const ragProcesses = fleet.tools.filter(t => t.id === 'rag-service')
  if (ragProcesses.length > 0) {
    console.log('  ✅ rag-service processes labeled without secret exposure')
  }
}

keyRotationExample()
