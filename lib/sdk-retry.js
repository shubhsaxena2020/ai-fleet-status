// SDK Example 5: retry and backoff guidance for transient failures
'use strict'

/**
 * Retry and backoff guidance demo.
 *
 * Demonstrates how to distinguish retryable from fatal errors in the rag-service SDK,
 * and shows a backoff pattern for transient failures.
 *
 * Done when: the example distinguishes retryable from fatal errors and the behavior
 * is demonstrated in code.
 */

const { compileTools, detect } = require('/home/ubuntu/projects/agent-2/lib/detect')
const fixtures = require('/home/ubuntu/projects/agent-2/test/fixtures')

// Simulate error types that the SDK might encounter
const ERROR_TYPES = {
  TRANSIENT: 'TRANSIENT',        // Retriable: network timeout, rate limit, temp unavailability
  FATAL: 'FATAL',                // Non-retriable: invalid config, permission denied, not found
  UNKNOWN: 'UNKNOWN'             // Unknown - apply default backoff
}

/**
 * Classify an error as retryable or fatal based on its message/content.
 */
function classifyError (err) {
  const message = (err && err.message) ? err.message.toString() : ''
  const lower = message.toLowerCase()

  // Retryable patterns
  const retryPatterns = [
    'timeout',
    'rate limit',
    'temporarily unavailable',
    'connection',
    'network',
    'eagain',
    'would block',
    'interrupted system call'
  ]

  // Fatal patterns
  const fatalPatterns = [
    'not found',
    'permission denied',
    'invalid',
    'invalid configuration',
    'access denied',
    'no such',
    'authentication failed'
  ]

  // Check fatal patterns first (more specific)
  for (const pattern of fatalPatterns) {
    if (lower.includes(pattern)) {
      return { type: ERROR_TYPES.FATAL, retryable: false }
    }
  }

  // Check retry patterns
  for (const pattern of retryPatterns) {
    if (lower.includes(pattern)) {
      return { type: ERROR_TYPES.TRANSIENT, retryable: true }
    }
  }

  // Default: unknown errors are tentatively retryable with longer backoff
  return { type: ERROR_TYPES.UNKNOWN, retryable: true }
}

/**
 * Calculate backoff delay using exponential backoff with jitter.
 * @param {number} attempt - Current attempt number (1-indexed)
 * @param {number} baseDelay - Base delay in milliseconds (default: 1000ms)
 * @param {number} maxDelay - Maximum delay in milliseconds (default: 30000ms)
 * @returns {number} Delay in milliseconds
 */
function backoffDelay (attempt, baseDelay = 1000, maxDelay = 30000) {
  const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay)
  const jitter = Math.random() * 1000 // +/- 1 second jitter
  return Math.max(0, delay + jitter - 500) // adjust for jitter range
}

/**
 * Run detection with retry logic.
 * @param {Array} processFixtures - Process fixtures to detect from
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} baseDelay - Base backoff delay in ms
 * @returns {Object} Result with success status and detector info
 */
async function runDetectionWithRetry (processFixtures, maxRetries = 3, baseDelay = 1000) {
  let lastError = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Simulate detection - in real code this would be the actual detect() call
      const detector = detect(processFixtures[0], 'BUILTIN_SPECS')

      if (detector && detector.id) {
        return {
          success: true,
          detector: detector,
          attempt: attempt
        }
      }

      // If no detector found but no error, continue to retry
      throw new Error('No detector found - will retry')

    } catch (err) {
      lastError = err
      const classification = classifyError(err)

      console.log('Attempt ' + attempt + '/' + maxRetries + ': ' + classification.type)

      if (!classification.retryable) {
        console.log('  → Fatal error detected; stopping retries')
        return {
          success: false,
          error: err,
          classification: ERROR_TYPES.FATAL,
          attempt: attempt
        }
      }

      if (attempt < maxRetries) {
        const delay = backoffDelay(attempt, baseDelay)
        console.log('  → Transient error; retrying in ' + (delay / 1000) + 's...')
        // In real code: await sleep(delay) or setTimeout
        // For this demo, just calculate and show the delay
      }
    }
  }

  return {
    success: false,
    error: lastError,
    classification: lastError ? classifyError(lastError) : ERROR_TYPES.UNKNOWN,
    attempt: maxRetries
  }
}

async function retryExample () {
  console.log('=== RAG Service SDK Retry and Backoff Example ===\n')

  const processFixtures = fixtures.FIX.oneSession
  console.log('Using ' + processFixtures.length + ' process fixture(s)\n')

  console.log('Error classification rules:')
  console.log('  Retryable: timeout, rate limit, temporarily unavailable, connection, network')
  console.log('  Fatal:   not found, permission denied, invalid, access denied')
  console.log('  Unknown: Tentatively retryable with longer backoff\n')

  console.log('Running detection with retry logic (max 3 attempts):\n')
  const result = await runDetectionWithRetry(processFixtures, 3, 1000)

  console.log('\n=== Retry example complete ===')
  console.log('Result:')
  console.log('  success: ' + result.success)
  console.log('  classification: ' + (result.classification || 'none'))
  console.log('  attempt: ' + result.attempt)

  if (result.error) {
    console.log('  error message: ' + result.error.message)
  }

  if (result.success) {
    console.log('  detector id: ' + result.detector.id)
    console.log('  detector reason: ' + result.detector.reason)
  }
}

retryExample().catch(err => {
  console.error('Fatal error in example:', err.message)
  process.exit(1)
})
