// SDK Example 8: environment-switching guidance for local, staging, and production endpoints
'use strict'

/**
 * Environment switching demo for SDK consumers.
 *
 * Demonstrates how to configure the SDK for different environments
 * (local development, staging, production) and switch between them.
 *
 * Done when: the docs show the exact variables and the example
 * can be pointed at more than one base URL.
 */

const { detect, compileTools } = require('/home/ubuntu/projects/agent-2/lib/detect')
const fixtures = require('/home/ubuntu/projects/agent-2/test/fixtures')

// Environment configuration patterns
const ENVIRONMENTS = {
  LOCAL: {
    name: 'local',
    description: 'Local development environment',
    baseUrl: 'http://localhost:8080',
    apiKey: '[YOUR_LOCAL_API_KEY]',
    note: 'Use for local development only'
  },
  STAGING: {
    name: 'staging',
    description: 'Staging environment',
    baseUrl: 'https://staging.rag-service.example.com',
    apiKey: '[YOUR_STAGING_API_KEY]',
    note: 'Use for testing against staging deployment'
  },
  PRODUCTION: {
    name: 'production',
    description: 'Production environment',
    baseUrl: 'https://rag-service.example.com',
    apiKey: '[YOUR_PRODUCTION_API_KEY]',
    note: 'Use for production deployments'
  }
}

/**
 * Show environment configuration for a given environment name.
 * @param {string} envName - The environment name (LOCAL, STAGING, PRODUCTION)
 * @returns {Object} Environment configuration object
 */
function getEnvironmentConfig (envName) {
  const env = ENVIRONMENTS[envName]
  if (!env) {
    throw new Error('Unknown environment: ' + envName + '. Choose from: ' + Object.keys(ENVIRONMENTS).join(', '))
  }
  return env
}

/**
 * Demonstrate environment switching pattern.
 * Shows how to detect tools in different environments by configuring
 * the appropriate base URL and API key.
 * @param {string} envName - Target environment
 * @returns {Object} Detection result and environment info
 */
function switchEnvironment (envName) {
  const config = getEnvironmentConfig(envName)

  console.log('=== Environment Switching Example ===\n')
  console.log('Target environment: ' + config.name + '\n')
  console.log('Configuration:')
  console.log('  - Base URL: ' + config.baseUrl)
  console.log('  - API Key: ' + config.apiKey)
  console.log('  - Description: ' + config.description + '\n')
  console.log('  Note: ' + config.note + '\n')

  console.log('Detection pattern:')
  console.log('  1. Set the base URL to ' + config.baseUrl)
  console.log('  2. Provide the API key: ' + config.apiKey)
  console.log('  3. Call detect() with process fixtures')
  console.log('  4. Results will be filtered for the selected environment\n')

  // In a real SDK, you'd configure the client with these values
  // For this demo, just show the configuration
  console.log('SDK configuration pattern:')
  console.log('  sdk.configure({')
  console.log('    baseUrl: \"' + config.baseUrl + '\",')
  console.log('    apiKey: \"' + config.apiKey + '\"')
  console.log('  })')

  return {
    environment: config.name,
    baseUrl: config.baseUrl,
    apiKeyProvided: config.apiKey !== '[YOUR_' + config.name.toUpperCase() + '_API_KEY]',
    config: config
  }
}

function envSwitchingExample () {
  console.log('=== RAG Service SDK Environment Switching Example ===\n')

  // Demonstrate all three environments
  console.log('Available environments:\n')
  console.log('  1. LOCAL - ' + ENVIRONMENTS.LOCAL.description)
  console.log('  2. STAGING - ' + ENVIRONMENTS.STAGING.description)
  console.log('  3. PRODUCTION - ' + ENVIRONMENTS.PRODUCTION.description + '\n')

  // Switch to each environment
  ;['LOCAL', 'STAGING', 'PRODUCTION'].forEach(envName => {
    console.log('Switching to ' + envName + '...')
    switchEnvironment(envName)
    console.log('')
  })

  // Final result
  const finalConfig = switchEnvironment('PRODUCTION')
  console.log('=== Environment switching complete ===')
  console.log('Current environment: ' + finalConfig.environment)
  console.log('Base URL: ' + finalConfig.baseUrl)
  console.log('Remember to replace placeholder API keys with real values.')
}

envSwitchingExample()
