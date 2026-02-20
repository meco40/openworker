import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(process.cwd(), relativePath));
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf-8');
}

describe('folder architecture refactor guard', () => {
  it('keeps production source code under src/', () => {
    const legacyRootDirs = ['components', 'core', 'lib', 'messenger', 'services', 'skills'];
    const canonicalSrcDirs = [
      'src/components',
      'src/core',
      'src/lib',
      'src/messenger',
      'src/services',
      'src/skills',
    ];

    for (const legacyDir of legacyRootDirs) {
      expect(exists(legacyDir)).toBe(false);
    }

    for (const canonicalDir of canonicalSrcDirs) {
      expect(exists(canonicalDir)).toBe(true);
    }
  });

  it('stores shared app contracts in src/shared/domain', () => {
    expect(exists('types.ts')).toBe(false);
    expect(exists('constants.ts')).toBe(false);
    expect(exists('src/shared/domain/types.ts')).toBe(true);
    expect(exists('src/shared/domain/constants.ts')).toBe(true);
  });

  it('keeps app shell composition inside src/modules', () => {
    expect(exists('App.tsx')).toBe(false);
    expect(exists('src/modules/app-shell/App.tsx')).toBe(true);

    const appShell = read('src/modules/app-shell/AppShell.tsx');
    expect(appShell).toContain("import App from '@/modules/app-shell/App';");
    expect(appShell).not.toContain('../../../App');
  });
});
