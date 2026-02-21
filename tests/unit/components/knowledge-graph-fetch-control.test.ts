import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('useKnowledgeGraph fetch control', () => {
  it('uses AbortController and request sequencing to avoid stale graph payloads', () => {
    const source = read('src/components/knowledge/hooks/useKnowledgeGraph.ts');

    expect(source).toContain('const abortRef = useRef<AbortController | null>(null);');
    expect(source).toContain('const requestSequenceRef = useRef(0);');
    expect(source).toContain('abortRef.current?.abort();');
    expect(source).toContain('signal: controller.signal');
    expect(source).toContain('if (requestSequence !== requestSequenceRef.current) return;');
  });
});
