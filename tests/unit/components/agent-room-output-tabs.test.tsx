import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SWARM_OUTPUT_TABS } from '@/modules/agent-room/swarmViewState';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('agent room output tabs', () => {
  it('exposes the four required output tabs', () => {
    expect(SWARM_OUTPUT_TABS).toEqual([
      'solution_artifact',
      'logic_graph',
      'history',
      'conflict_radar',
    ]);
  });

  it('switches over output tabs in AgentRoomView', () => {
    const source = read('src/modules/agent-room/components/AgentRoomView.tsx');
    expect(source).toContain("runtime.activeTab === 'solution_artifact'");
    expect(source).toContain("runtime.activeTab === 'logic_graph'");
    expect(source).toContain("runtime.activeTab === 'history'");
    expect(source).toContain("runtime.activeTab === 'conflict_radar'");
  });
});

