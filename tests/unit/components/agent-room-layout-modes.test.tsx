import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SWARM_LAYOUT_MODES } from '@/modules/agent-room/swarmViewState';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('agent room layout modes', () => {
  it('keeps split/chat/board layout modes', () => {
    expect(SWARM_LAYOUT_MODES).toEqual(['split', 'chat', 'board']);
  });

  it('renders layout mode controls in AgentRoomView', () => {
    const source = read('src/modules/agent-room/components/AgentRoomView.tsx');
    expect(source).toContain('SWARM_LAYOUT_MODES.map');
    expect(source).toContain('layoutLabel(mode)');
  });
});
