import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('agent room detail header', () => {
  it('renders back navigation, status indicator, and markdown export action', () => {
    const source = read('src/modules/agent-room/components/layout/AgentRoomDetailPage.tsx');
    expect(source).toContain("{'<-'} Back");
    expect(source).toContain('statusBadgeClasses');
    expect(source).toContain('Export MD');
    expect(source).toContain('Pause');
    expect(source).toContain('Stop');
    expect(source).toContain('Finish');
    expect(source).not.toContain('Master');
  });

  it('keeps split detail layout with chat on left and infos on right', () => {
    const source = read('src/modules/agent-room/components/layout/AgentRoomDetailPage.tsx');
    expect(source).toContain('SwarmChatFeed');
    expect(source).toContain('CanvasPanel');
    expect(source).toContain('Current phase:');
  });
});
