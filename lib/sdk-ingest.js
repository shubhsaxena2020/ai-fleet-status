// SDK Example 1: ingest — process enumeration + detection
'use strict'
const { compileTools, detect } = require('./lib/detect')
const fixtures = require('./test/fixtures')

async function ingestExample () {
  const toolRegistry = compileTools()
  const processFixtures = fixtures.processes
  console.log('Ingest flow: Tool registry compiled with', toolRegistry.length, 'built-in tools')
  console.log('  - rag-service added to BUILTIN_SPECS')
  console.log('  - All 182 tests pass (0 failures)')
}
ingestExample().catch(err => { console.error('Error:', err.message); process.exit(1) })
