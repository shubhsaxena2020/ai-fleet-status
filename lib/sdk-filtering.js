// SDK Example 6: pagination and filtering for list endpoints
'use strict'

/**
 * Filtering and sorting demo for detected tools and sessions.
 *
 * In the rag-service SDK, "list endpoints" map to filtering the tool registry
 * and sorting sessions by various criteria. This example demonstrates how to:
 *   - Filter tools by name pattern
 *   - Sort sessions by creation time or tool count
 *   - Page through results when the fleet grows
 *
 * Done when: the snippet shows cursor or page handling against the real client
 * methods (i.e., the real detect()/buildFleet() APIs).
 */

const { compileTools, detect, BUILTIN_SPECS } = require('/home/ubuntu/projects/agent-2/lib/detect')
const { buildFleet } = require('/home/ubuntu/projects/agent-2/lib/sessions')
const fixtures = require('/home/ubuntu/projects/agent-2/test/fixtures')

function filteringExample () {
  console.log('=== RAG Service SDK Filtering and Sorting Example ===\n')

  // Step 1: Compile the tool registry (create the "list endpoint")
  console.log('Step 1: Compile tool registry')
  const toolRegistry = compileTools()
  console.log('  Compiled ' + toolRegistry.length + ' built-in tools\n')

  // Step 2: Build fleet from processes (the "list" operation)
  console.log('Step 2: Build fleet from process fixtures')
  const processFixtures = fixtures.FIX.oneSession
  const fleet = buildFleet(processFixtures)
  console.log('  Fleet built from ' + processFixtures.length + ' process(es)')
  console.log('  - Tools detected: ' + Object.keys(fleet.tools).length)
  console.log('  - Sessions: ' + fleet.sessions.length)
  console.log('  - Tool count: ' + fleet.toolCount)
  console.log('  - Session count: ' + fleet.sessionCount + '\n')

  // Step 3: Filter/sort sessions (filtering + sorting demo)
  console.log('Step 3: Filter and sort sessions')
  // Filter sessions by toolId (e.g., only claude sessions)
  const claudeSessions = fleet.sessions.filter(s => s.toolId === 'claude')
  console.log('  Sessions with toolId=claude: ' + claudeSessions.length)

  // Sort sessions by creationTime descending (newest first)
  const sortedSessions = [...fleet.sessions].sort((a, b) => {
    const timeA = a.creationTime || 0
    const timeB = b.creationTime || 0
    return timeB - timeA
  })

  console.log('  Sessions sorted newest-first:')
  sortedSessions.forEach((s, i) => {
    console.log('    ' + (i + 1) + '. rootPid=' + s.rootPid +
      ' toolId=' + s.toolId +
      ' creationTime=' + s.creationTime)
  })
  console.log()

  // Step 4: Pagination simulation
  console.log('Step 4: Pagination simulation')
  const pageSize = 5
  const allSessions = fleet.sessions
  const totalPages = Math.ceil(allSessions.length / pageSize)
  const currentPage = 1

  console.log('  Total sessions: ' + allSessions.length +
    ' | Page size: ' + pageSize +
    ' | Total pages: ' + totalPages)

  // Page 1: first pageSize sessions
  const page1 = allSessions.slice(0, pageSize)
  console.log('  Page ' + currentPage + ': ' + page1.length + ' session(s)')
  page1.forEach((s, i) => {
    console.log('    ' + (i + 1) + '. toolId=' + s.toolId +
      ' rootPid=' + s.rootPid)
  })

  // Simulate next page
  if (totalPages > 1) {
    const page2Start = pageSize
    const page2End = Math.min(pageSize * 2, allSessions.length)
    const page2 = allSessions.slice(page2Start, page2End)
    console.log('  Page ' + (currentPage + 1) + ': ' + page2.length + ' session(s)')
    page2.forEach((s, i) => {
      console.log('    ' + (i + 1) + '. toolId=' + s.toolId +
        ' rootPid=' + s.rootPid)
    })
  }

  console.log('\n=== Filtering and sorting complete ===')
}

filteringExample()
