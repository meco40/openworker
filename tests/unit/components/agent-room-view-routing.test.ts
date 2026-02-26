import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Agent Room view routing', () => {
  it('wires AgentRoomView dynamic import and view branch', () => {
    const source = read('src/modules/app-shell/components/AppShellViewContent.tsx');
    expect(source).toContain(
      "const AgentRoomView = dynamic(() => import('@/modules/agent-room/components/AgentRoomView')",
    );
    expect(source).toContain('currentView === View.AGENT_ROOM');
    expect(source).toContain('label="Agent Room"');
  });
});
