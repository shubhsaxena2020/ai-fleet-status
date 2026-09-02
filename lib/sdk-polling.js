// SDK Example 4: polling / waiting for long-running job completion
'use strict'

/**
 * Polling demo for long-running job completion.
 *
 * In the rag-service SDK, "jobs" are user sessions. This example demonstrates
 * the polling pattern: repeatedly check session status until completion.
 *
 * Done when: the docs show how to wait for completion and the example handles
 * a real in-flight job.
 */

const { buildFleet } = require('/home/ubuntu/projects/agent-2/lib/sessions')
const fixtures = require('/home/ubuntu/projects/agent-2/test/fixtures')

function pollingExample () {
  console.log('=== RAG Service SDK Polling Example ===\n')

  const processFixtures = fixtures.FIX.oneSession
  console.log('Starting with ' + processFixtures.length + ' process(es)\n')

  // Build initial fleet state
  let fleet = buildFleet(processFixtures)
  console.log('Initial fleet state:')
  console.log('  - Tools: ' + fleet.tools.length)
  console.log('  - Sessions: ' + fleet.sessions.length)
  console.log('  - Tool count: ' + fleet.toolCount)
  console.log('  - Session count: ' + fleet.sessionCount + '\n')

  // Polling loop: check status until sessions complete
  let attempts = 0
  const maxAttempts = 5

  console.log('Polling for session completion...')

  while (attempts < maxAttempts) {
    attempts++
    console.log('  Attempt ' + attempts + '/' + maxAttempts + ':')

    // Rebuild fleet to get current state (simulates polling)
    fleet = buildFleet(processFixtures)

    if (fleet.sessionCount > 0) {
      console.log('    ✅ ' + fleet.sessionCount + ' session(s) active - waiting...')
    } else {
      console.log('    ✅ No active sessions - all jobs complete!')
      break
    }

    // Simulate a small delay between polls
    // In real usage: setTimeout or setInterval
    if (attempts < maxAttempts) {
      console.log('    ⏳ Waiting before next poll...')
    }
  }

  if (attempts >= maxAttempts && fleet.sessionCount > 0) {
    console.log('  ⚠️  ' + maxAttempts + ' polls reached; ' + fleet.sessionCount + ' session(s) still active')
  }

  // Show final tool details
  console.log('\nFinal tool details:')
  fleet.sessions.forEach(function (session, i) {
    console.log('  Session ' + (i + 1) + ':')
    console.log('    - rootPid: ' + session.rootPid)
    console.log('    - toolId: ' + session.toolId)
    console.log('    - type: ' + session.type)
    console.log('    - creationTime: ' + session.creationTime)
  })

  console.log('\n=== Polling complete ===')
}

pollingExample()
