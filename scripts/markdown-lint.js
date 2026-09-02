#!/usr/bin/env node
// Docs lint pass: checks fenced code blocks and internal links in markdown files
// Run with: node scripts/markdown-lint.js

'use strict';

const fs = require('fs');
const path = require('path');

const MARKDOWN_ROOTS = ['.', 'docs'];
const IGNORE_PATTERNS = ['node_modules', '.git'];

function shouldIgnore(dir) {
  return IGNORE_PATTERNS.some(p => dir.includes(p));
}

function walkFiles(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (shouldIgnore(e.name)) continue;
      walkFiles(path.join(dir, e.name), results);
    } else if (e.name.endsWith('.md')) {
      results.push(path.join(dir, e.name));
    }
  }
  return results;
}

// Check fenced code blocks have opening language tag
function checkCodeBlocks(src, filePath) {
  const issues = [];
  // Match fenced code blocks: ```language or ```
  const blockRegex = /```(\w*)\n([\s\S]*?)\n```/g;
  let match;
  while ((match = blockRegex.exec(src)) !== null) {
    const language = match[1];
    const code = match[2];
    // If there's code but no language tag, flag it
    if (code.trim() && !language) {
      issues.push(`${filePath}: fenced code block without language tag`);
    }
    // Check for obvious shell/bash without proper tag
    if (code.includes('$ ') && !language) {
      issues.push(`${filePath}: shell-style code ($ prompt) without language tag`);
    }
  }
  return issues;
}

// Check markdown links for proper internal link format
function checkInternalLinks(src, filePath) {
  const issues = [];
  // Match markdown links: [text](url)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(src)) !== null) {
    const url = match[2];
    // Internal links should start with # or be a relative path
    const isInternalLinkStartingWithHash = url.startsWith('#');
    const isRelativePath = url.startsWith('./') || url.startsWith('../');
    // External URLs (starting with http:) are OK
    const isExternalUrl = url.startsWith('http://') || url.startsWith('https://');
    if (!isInternalLinkStartingWithHash && !isRelativePath && !isExternalUrl) {
      // Bare anchor without text
      if (url === '#') {
        issues.push(`${filePath}: empty internal link anchor`);
      }
    }
  }
  return issues;
}

async function main() {
  const files = walkFiles('.');
  console.log(`markdown-lint: checked ${files.length} markdown file(s)`);

  let allIssues = [];

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const codeBlockIssues = checkCodeBlocks(src, file);
    const linkIssues = checkInternalLinks(src, file);
    allIssues = allIssues.concat(codeBlockIssues, linkIssues);
  }

  if (allIssues.length > 0) {
    console.log('\nIssues found:');
    for (const issue of allIssues) {
      console.log('  ! ' + issue);
    }
    console.log(`\n${allIssues.length} issue(s) — markdown-lint FAILED`);
    process.exit(1);
  }

  console.log('\nmarkdown-lint OK — no issues found');
  process.exit(0);
}

main().catch(err => {
  console.error('markdown-lint error:', err.message);
  process.exit(1);
});
