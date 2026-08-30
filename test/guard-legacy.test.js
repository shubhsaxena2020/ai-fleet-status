// Test to ensure legacy modules are not required by extension.js
// Deleted legacy modules: lib/tool-config.js, lib/process-chains.js, lib/process-list.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const extensionPath = join(process.cwd(), 'extension.js');

test('extension.js does not require deleted legacy modules', () => {
  const content = readFileSync(extensionPath, 'utf8');

  // Check for require statements of the deleted modules
  const forbidden = [
    "require('./lib/tool-config')",
    "require('./lib/process-chains')",
    "require('./lib/process-list')",
  ];

  for (const forbiddenRequire of forbidden) {
    if (content.includes(forbiddenRequire)) {
      throw new Error(`extension.js must not contain ${forbiddenRequire}`);
    }
  }
});