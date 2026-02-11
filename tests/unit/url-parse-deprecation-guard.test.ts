import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'tests'];
const SCAN_FILES = ['server.ts'];

const DEPRECATED_URL_PARSE_PATTERNS = [
  /import\s+\{\s*parse(?:\s+as\s+\w+)?\s*\}\s+from\s+['"]node:url['"]/,
  /import\s+\{\s*parse(?:\s+as\s+\w+)?\s*\}\s+from\s+['"]url['"]/,
  /\brequire\(['"]node:url['"]\)\.parse\s*\(/,
  /\brequire\(['"]url['"]\)\.parse\s*\(/,
  /\burl\.parse\s*\(/,
];

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
      if (DEPRECATED_URL_PARSE_PATTERNS.some((pattern) => pattern.test(content))) {
        violations.push(path.relative(ROOT, filePath));
      }
    }

    expect(violations).toEqual([]);
  });
});
