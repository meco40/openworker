import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const EXCLUDED_DIRS = new Set([
  '.git',
  '.next',
  'node_modules',
  'dist',
  'demo',
  'backups',
  'workspaces',
  '.worktrees',
  'coverage',
]);

const EXPLICIT_ANY_PATTERNS = [
  /:\s*any\b/,
  /\bas\s+any\b/,
  /\bany\[\]/,
  /\bArray<any>/,
  /\bReadonlyArray<any>/,
  /<any>/,
];

const SELF_TEST_FILE = path.join(ROOT, 'tests', 'unit', 'no-explicit-any-guard.test.ts');

function collectTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }

    if (entry.isFile() && (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx'))) {
      if (path.resolve(fullPath) === path.resolve(SELF_TEST_FILE)) {
        continue;
      }
      files.push(fullPath);
    }
  }

  return files;
}

function findExplicitAnyLines(content: string): number[] {
  return content
    .split(/\r?\n/)
    .flatMap((line, index) =>
      EXPLICIT_ANY_PATTERNS.some((pattern) => pattern.test(line)) ? [index + 1] : [],
    );
}

describe('explicit any guard', () => {
  it('contains no explicit any usage in project TypeScript files', () => {
    const files = collectTsFiles(ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = findExplicitAnyLines(content);
      for (const line of lines) {
        violations.push(`${path.relative(ROOT, file)}:${line}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
