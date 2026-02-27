import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('master architecture guards', () => {
  it('keeps agent-room routing branch unchanged and independent from master', () => {
    const source = read('src/modules/app-shell/components/AppShellViewContent.tsx');
    expect(source).toContain('currentView === View.AGENT_ROOM');
    expect(source).toContain('label="Agent Room"');
    expect(source).toContain('currentView === View.MASTER');
  });

  it('keeps agent-room detail header free of master controls', () => {
    const source = read('src/modules/agent-room/components/layout/AgentRoomDetailPage.tsx');
    expect(source).not.toContain('Master');
    expect(source).not.toContain('approve_once');
    expect(source).not.toContain('approve_always');
  });
});
