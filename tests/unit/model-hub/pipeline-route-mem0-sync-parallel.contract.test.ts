import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('model-hub pipeline mem0 sync strategy', () => {
  it('centralizes and parallelizes mem0 llm/embedder sync execution', () => {
    const routeSource = read('app/api/model-hub/pipeline/route.ts');

    expect(routeSource).toContain('async function runMem0Syncs');
    expect(routeSource).toContain('Promise.all([');
    expect(routeSource).toContain('const [mem0LlmSync, mem0EmbedderSync]');
    expect(routeSource).toContain('return { mem0LlmSync, mem0EmbedderSync };');
  });
});
