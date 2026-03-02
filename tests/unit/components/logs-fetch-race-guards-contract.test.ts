import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('logs hook fetch race guards', () => {
  it('uses abort + request sequencing for logs fetch flows', () => {
    const logsHook = read('src/components/logs/hooks/useLogs.ts');

    expect(logsHook).toContain('const abortRef = useRef<AbortController | null>(null);');
    expect(logsHook).toContain('const requestSequenceRef = useRef(0);');
    expect(logsHook).toContain('abortRef.current?.abort();');
    expect(logsHook).toContain('signal: controller.signal');
    expect(logsHook).toContain('if (requestSequence !== requestSequenceRef.current) return;');
    const loadingClears = logsHook.match(/setIsLoading\(false\);/g) ?? [];
    expect(loadingClears.length).toBeGreaterThanOrEqual(2);
  });
});
