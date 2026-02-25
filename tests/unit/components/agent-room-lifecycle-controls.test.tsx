import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('agent room lifecycle controls', () => {
  it('includes deploy, phase, abort, complete, export and delete controls', () => {
    const source = read('src/modules/agent-room/components/AgentRoomView.tsx');
    expect(source).toContain('Deploy Agents');
    expect(source).toContain('Force Next Phase');
    expect(source).toContain('Force Complete');
    expect(source).toContain('Abort');
    expect(source).toContain('Export Run JSON');
    expect(source).toContain('Delete Swarm');
  });
});

