// SDK Error Mapping Helper
'use strict'

/**
 * Compact error mapping for SDK consumers.
 *
 * Maps SDK error codes and messages to user-friendly categories,
 * distinguishing retryable transient errors from fatal configuration errors.
 *
 * Done when: the helper maps SDK error codes to user-friendly messages
 * and distinguishes retryable from fatal.
 */

const ERROR_CATEGORIES = {
  // Transient/retryable errors
  TRANSIENT: 'transient',
  // Permanent/fatal errors
  FATAL: 'fatal',
  // Configuration errors
  CONFIG: 'config',
  // Unknown/other
  UNKNOWN: 'unknown'
}

/**
 * Map an SDK error to a categorized user-friendly message.
 * @param {Error|string} err - The error or error message string
 * @returns {ErrorMapping} The categorized error mapping
 */
function mapError (err) {
  const message = (err && typeof err.message === 'string') ? err.message : (err || '')
  const lower = message.toLowerCase()

  // Fatal / configuration errors (non-retryable)
  const fatalPatterns = [
    { pattern: /not found|no such/i, message: 'Resource not found', category: ERROR_CATEGORIES.FATAL, retryHint: false },
    { pattern: /permission denied|access denied/i, message: 'Permission denied — check your configuration', category: ERROR_CATEGORIES.FATAL, retryHint: false },
    { pattern: /invalid configuration/i, message: 'Invalid configuration — verify your setup', category: ERROR_CATEGORIES.CONFIG, retryHint: false },
    { pattern: /authentication failed|unauthorized/i, message: 'Authentication failed — check your API key', category: ERROR_CATEGORIES.FATAL, retryHint: false }
  ]

  for (const { pattern, message, category, retryHint } of fatalPatterns) {
    if (pattern.test(lower)) {
      return { category, message, retryHint }
    }
  }

  // Transient / retryable errors
  const transientPatterns = [
    { pattern: /timeout/i, message: 'Operation timed out', category: ERROR_CATEGORIES.TRANSIENT, retryHint: true, suggestedDelayMs: 3000 },
    { pattern: /rate limit/i, message: 'Rate limit exceeded', category: ERROR_CATEGORIES.TRANSIENT, retryHint: true, suggestedDelayMs: 5000 },
    { pattern: /temporarily unavailable|unavailable/i, message: 'Service temporarily unavailable', category: ERROR_CATEGORIES.TRANSIENT, retryHint: true, suggestedDelayMs: 2000 },
    { pattern: /connection|network/i, message: 'Network connection issue', category: ERROR_CATEGORIES.TRANSIENT, retryHint: true, suggestedDelayMs: 5000 },
    { pattern: /eagain|would block|interrupted system call/i, message: 'Transient system error', category: ERROR_CATEGORIES.TRANSIENT, retryHint: true, suggestedDelayMs: 1000 }
  ]

  for (const { pattern, message, category, retryHint, suggestedDelayMs } of transientPatterns) {
    if (pattern.test(lower)) {
      return { category, message, retryHint, suggestedDelayMs }
    }
  }

  // Default: unknown error — tentatively retryable with longer backoff
  return {
    category: ERROR_CATEGORIES.UNKNOWN,
    message: 'Unexpected error — ' + (message ? message.substring(0, 100) : 'no message provided'),
    retryHint: true,
    suggestedDelayMs: 10000
  }
}

/**
 * Create a user-friendly error from an SDK error.
 * @param {Error|string} err - The error or error message string
 * @returns {Object} Formatted error with category, message, and retry guidance
 */
function formatError (err) {
  const mapping = mapError(err)

  const result = {
    category: mapping.category,
    message: mapping.message,
    retryable: mapping.retryHint !== false,
    retryDelayMs: mapping.suggestedDelayMs || 5000
  }

  // Add category-specific guidance
  if (mapping.category === ERROR_CATEGORIES.FATAL) {
    result.advice = 'Check your configuration and try again. This is not a transient error.'
  } else if (mapping.category === ERROR_CATEGORIES.TRANSIENT) {
    result.advice = 'Retry with exponential backoff. The issue is likely temporary.'
  } else if (mapping.category === ERROR_CATEGORIES.CONFIG) {
    result.advice = 'Review your configuration settings and verify they are correct.'
  } else {
    result.advice = 'An unexpected error occurred. Retry with backoff if appropriate.'
  }

  return result
}

/**
 * Example: Map multiple errors and show their categories.
 * @param {Array} errors - Array of error objects or messages
 * @returns {Array} Array of formatted error mappings
 */
function batchMapErrors (errors) {
  return errors.map(err => formatError(err))
}

module.exports = {
  mapError,
  formatError,
  batchMapErrors,
  ERROR_CATEGORIES
}
