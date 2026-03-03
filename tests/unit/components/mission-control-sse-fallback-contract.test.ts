import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('mission-control sse fallback contract', () => {
  it('uses SSE connection status and a single fallback polling loop', () => {
    const workspacePage = read('app/mission-control/workspace/[slug]/WorkspaceClientPage.tsx');
    const useSSE = read('src/hooks/useSSE.ts');

    expect(useSSE).toContain('return { isConnected');
    expect(workspacePage).toContain('const { isConnected: isSseConnected } = useSSE();');
    expect(workspacePage).toContain('isSseConnected');
    expect(workspacePage).toContain('const fallbackSync = async () => {');
    expect(workspacePage).not.toContain('const eventPoll = setInterval(async () => {');
    expect(workspacePage).not.toContain('const taskPoll = setInterval(async () => {');
    expect(workspacePage).not.toContain('const connectionCheck = setInterval(async () => {');
  });
});
