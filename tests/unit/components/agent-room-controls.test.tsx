import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('agent room operator controls', () => {
  it('includes guidance and specialist controls in AgentRoomView', () => {
    const source = read('src/modules/agent-room/components/AgentRoomView.tsx');
    expect(source).toContain('Operator Guidance');
    expect(source).toContain('Send Guidance');
    expect(source).toContain('Add Specialist Persona');
    expect(source).toContain('Add Persona');
  });
});
