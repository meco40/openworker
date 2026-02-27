import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('agent room split layout', () => {
  it('detail page chat section uses flex-1 for equal-width split', () => {
    const source = read('src/modules/agent-room/components/layout/AgentRoomDetailPage.tsx');
    expect(source).toContain('flex min-w-0 flex-1 flex-col');
  });

  it('canvas panel uses flex-1 for equal-width split', () => {
    const source = read('src/modules/agent-room/components/canvas/CanvasPanel.tsx');
    // Canvas aside must also be flex-1 for equal split
    expect(source).toContain('flex min-w-0 flex-1 flex-col');
  });
});
