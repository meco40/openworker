import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('agent room entry page actions', () => {
  it('defines status-grouped sections in the expected order', () => {
    const source = read('src/modules/agent-room/components/layout/AgentRoomEntryPage.tsx');

    const runningIndex = source.indexOf("title: 'Running / Hold'");
    const idleIndex = source.indexOf("title: 'Idle'");
    const completedIndex = source.indexOf("title: 'Completed'");
    const abortedIndex = source.indexOf("title: 'Aborted / Error'");

    expect(runningIndex).toBeGreaterThan(-1);
    expect(idleIndex).toBeGreaterThan(-1);
    expect(completedIndex).toBeGreaterThan(-1);
    expect(abortedIndex).toBeGreaterThan(-1);
    expect(runningIndex).toBeLessThan(idleIndex);
    expect(idleIndex).toBeLessThan(completedIndex);
    expect(completedIndex).toBeLessThan(abortedIndex);
  });

  it('keeps delete disabled for running or hold tasks', () => {
    const source = read('src/modules/agent-room/components/layout/SwarmTaskCard.tsx');
    expect(source).toContain("return status !== 'running' && status !== 'hold';");
    expect(source).toContain(
      "title={!deletable ? 'Stop this task before deleting.' : 'Delete task'}",
    );
  });
});
