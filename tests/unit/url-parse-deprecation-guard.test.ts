import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'tests'];
const SCAN_FILES = ['server.ts'];

const DEPRECATED_URL_PARSE_SNIPPETS = [
  "require('node:url').parse(",
  'require("node:url").parse(',
  "require('url').parse(",
  'require("url").parse(',
  'url.parse(',
];

function containsDeprecatedUrlParse(content: string): boolean {
  const normalized = content.replace(/\s+/g, ' ');
  const hasParseImport =
    normalized.includes('import { parse') || normalized.includes('import {parse');
  const importsNodeUrl =
    normalized.includes("from 'node:url'") || normalized.includes('from "node:url"');
  const importsUrl = normalized.includes("from 'url'") || normalized.includes('from "url"');

  if (hasParseImport && (importsNodeUrl || importsUrl)) {
    return true;
  }

  return DEPRECATED_URL_PARSE_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function collectTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }

    if (entry.isFile() && (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx'))) {
      // Skip this test file itself — it contains the deprecated patterns as string literals
      if (fullPath.includes('url-parse-deprecation-guard')) continue;
      files.push(fullPath);
    }
  }

  return files;
}

describe('url.parse deprecation guard', () => {
  it('does not use deprecated url.parse patterns', () => {
    const filesToScan: string[] = [];

    for (const relativeDir of SCAN_DIRS) {
      filesToScan.push(...collectTsFiles(path.join(ROOT, relativeDir)));
    }

    for (const relativeFile of SCAN_FILES) {
      filesToScan.push(path.join(ROOT, relativeFile));
    }

    const violations: string[] = [];

    for (const filePath of filesToScan) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (containsDeprecatedUrlParse(content)) {
        violations.push(path.relative(ROOT, filePath));
      }
    }

    expect(violations).toEqual([]);
  });
});
