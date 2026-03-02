import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('wave2 memory route modularization contracts', () => {
  it('keeps memory route as a thin verb router that delegates to server handlers', () => {
    const routeSource = read('app/api/memory/route.ts');

    expect(routeSource).toContain("from '@/server/memory/api'");
    expect(routeSource).toContain('handleMemoryGet');
    expect(routeSource).toContain('handleMemoryPost');
    expect(routeSource).toContain('handleMemoryPut');
    expect(routeSource).toContain('handleMemoryDelete');
    expect(routeSource).toContain('handleMemoryPatch');
    expect(routeSource).not.toContain('function parseStoreArgs(');
    expect(routeSource).not.toContain('function parseUpdateBody(');
    expect(routeSource).not.toContain('function resolveMemoryReadUserScopes(');
  });

  it('provides dedicated handler modules per memory http verb', () => {
    const apiEntry = read('src/server/memory/api/index.ts');

    expect(apiEntry).toContain("from './getHandler'");
    expect(apiEntry).toContain("from './postHandler'");
    expect(apiEntry).toContain("from './putHandler'");
    expect(apiEntry).toContain("from './deleteHandler'");
    expect(apiEntry).toContain("from './patchHandler'");
  });
});
