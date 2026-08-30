// SDK Example 3: job status — session lifecycle
'use strict'
const { buildFleet } = require('./lib/sessions')
const fixtures = require('./test/fixtures')

function jobStatusExample () {
  const processFixtures = fixtures.processes
  const fleet = buildFleet(processFixtures)

  console.log('Job status flow: Fleet built from', processFixtures.length, 'processes')
  console.log('  - Tools:', fleet.tools.length)
  console.log('  - Sessions:', fleet.sessions.length)
  console.log('  - Tool count:', fleet.toolCount)
  console.log('  - Session count:', fleet.sessionCount)

  fleet.sessions.forEach((session, i) => {
    console.log(`  Session ${i + 1}: rootPid=${session.rootPid}, toolId=${session.toolId}, type=${session.type}`)
  })

  const ragServiceSessions = fleet.sessions.filter(s => s.toolId === 'rag-service')
  if (ragServiceSessions.length > 0) {
    console.log('  ✅ rag-service sessions found in fleet')
  } else {
    console.log('  note: rag-service excluded from sessions (daemon mode, expected)')
  }
}

jobStatusExample()
