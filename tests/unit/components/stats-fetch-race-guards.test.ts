import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('stats fetch race guards', () => {
  it('uses abort + request sequencing in stats and prompt logs fetch flows', () => {
    const statsView = read('src/components/stats/StatsView.tsx');
    const promptLogsHook = read('src/components/stats/prompt-logs/hooks/usePromptLogs.ts');

    expect(statsView).toContain('const abortRef = useRef<AbortController | null>(null);');
    expect(statsView).toContain('const requestSequenceRef = useRef(0);');
    expect(statsView).toContain('abortRef.current?.abort();');
    expect(statsView).toContain('signal: controller.signal');
    expect(statsView).toContain('if (requestSequence !== requestSequenceRef.current) return;');

    expect(promptLogsHook).toContain('const abortRef = useRef<AbortController | null>(null);');
    expect(promptLogsHook).toContain('const requestSequenceRef = useRef(0);');
    expect(promptLogsHook).toContain('abortRef.current?.abort();');
    expect(promptLogsHook).toContain('signal: controller.signal');
    expect(promptLogsHook).toContain('if (requestSequence !== requestSequenceRef.current) return;');
  });
});
