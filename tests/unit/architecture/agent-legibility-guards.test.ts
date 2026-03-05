import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relativePath), 'utf8');
}

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!full.endsWith('.ts') && !full.endsWith('.tsx')) continue;
    files.push(full);
  }
  return files;
}

function collectImports(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('import '))
    .map((line) => {
      const match = line.match(/from\s+['"]([^'"]+)['"]/);
      return match ? match[1] : '';
    })
    .filter(Boolean);
}

describe('agent legibility guards', () => {
  it('keeps stats engineering route thin by delegating to service', () => {
    const content = read('app/api/stats/engineering/route.ts');
    expect(content).toContain('collectEngineeringMetricsSnapshot');
    expect(content).not.toContain('SELECT ');
    expect(content).not.toContain('queryAll(');
  });

  it('enforces shared-layer import direction', () => {
    const files = collectFiles(path.resolve(ROOT, 'src/shared'));
    const violations: string[] = [];

    for (const file of files) {
      const imports = collectImports(fs.readFileSync(file, 'utf8'));
      for (const source of imports) {
        if (source.includes('/src/server/') || source.includes('/src/modules/')) {
          violations.push(`${path.relative(ROOT, file)} -> ${source}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('prevents direct server imports inside chat and mission-control UI modules', () => {
    const files = [
      ...collectFiles(path.resolve(ROOT, 'src/modules/chat')),
      ...collectFiles(path.resolve(ROOT, 'src/modules/mission-control')),
    ];
    const violations: string[] = [];

    for (const file of files) {
      const imports = collectImports(fs.readFileSync(file, 'utf8'));
      for (const source of imports) {
        if (source.startsWith('@/server/')) {
          violations.push(`${path.relative(ROOT, file)} -> ${source}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
