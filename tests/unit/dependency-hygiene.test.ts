import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  const filePath = path.resolve(process.cwd(), 'package.json');
  return JSON.parse(readFileSync(filePath, 'utf8')) as PackageJson;
}

describe('dependency hygiene', () => {
  it('does not keep legacy eslint resolver packages when lint is oxlint-only', () => {
    const pkg = readPackageJson();
    expect(pkg.devDependencies?.['eslint-import-resolver-typescript']).toBeUndefined();
  });

  it('declares postcss used by postcss.config.mjs', () => {
    const pkg = readPackageJson();
    expect(pkg.devDependencies?.postcss || pkg.dependencies?.postcss).toBeTypeOf('string');
  });

  it('declares @next/env used by runtime scripts', () => {
    const pkg = readPackageJson();
    expect(pkg.devDependencies?.['@next/env'] || pkg.dependencies?.['@next/env']).toBeTypeOf(
      'string',
    );
  });
});
