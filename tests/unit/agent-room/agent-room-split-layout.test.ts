import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('agent room split layout', () => {
  it('keeps chat and canvas panel in an equal-width split when canvas is open', () => {
    const source = read('src/modules/agent-room/components/AgentRoomView.tsx');
    expect(source).toContain(
      'className="flex min-w-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-[#050b19]"',
    );
    expect(source).toContain(
      'className="flex min-w-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-[#060d20]"',
    );
  });
});
