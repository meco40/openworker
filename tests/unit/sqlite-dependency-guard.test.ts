import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'tests'];
const SQLITE_EXPERIMENTAL_IMPORT = /from\s+['"]node:sqlite['"]/;

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

describe('sqlite dependency guard', () => {
  it('does not use experimental node:sqlite imports in runtime or tests', () => {
    const violations: string[] = [];

    for (const relativeDir of SCAN_DIRS) {
      const dir = path.join(ROOT, relativeDir);
      for (const filePath of collectTsFiles(dir)) {
        const content = fs.readFileSync(filePath, 'utf8');
        if (SQLITE_EXPERIMENTAL_IMPORT.test(content)) {
          violations.push(path.relative(ROOT, filePath));
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
