// SDK Example 2: query — tool detection from process
'use strict'
const { detect } = require('./lib/detect')
const fixtures = require('./test/fixtures')

function queryExample () {
  const processFixtures = fixtures.processes
  console.log('Query flow: Detecting tools from', processFixtures.length, 'fixture processes')

  const toolIdMap = {}
  processFixtures.forEach(process => {
    const detector = detect(process, 'BUILTIN_SPECS')
    if (detector && detector.id) {
      if (!toolIdMap[detector.id]) {
        toolIdMap[detector.id] = 0
      }
      toolIdMap[detector.id]++
    }
  })

  console.log('  Detected tools:')
  Object.entries(toolIdMap).forEach(([toolId, count]) => {
    console.log(`    - ${toolId}: ${count} process(es)`)
  })

  if (toolIdMap['rag-service']) {
    console.log('  ✅ rag-service detected in fleet')
  } else {
    console.log('  note: rag-service not found in these fixtures (expected in test env)')
  }
}

queryExample()
