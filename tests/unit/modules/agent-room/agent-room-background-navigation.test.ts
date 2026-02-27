import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('agent room background navigation', () => {
  it('keeps runtime mounted while switching between entry and detail views', () => {
    const source = read('src/modules/agent-room/components/AgentRoomView.tsx');

    expect(source).toContain('const runtime = useAgentRoomRuntime();');
    expect(source).toContain("const [pageMode, setPageMode] = useState<'entry' | 'detail'>");
    expect(source).toContain("pageMode === 'entry' ?");
    expect(source).toContain('AgentRoomEntryPage');
    expect(source).toContain('AgentRoomDetailPage');
  });

  it('removes internal swarm sidebar and falls back to entry if selected task disappears', () => {
    const source = read('src/modules/agent-room/components/AgentRoomView.tsx');

    expect(source).not.toContain('<SwarmSidebar');
    expect(source).toContain('The selected task no longer exists.');
    expect(source).toContain("setPageMode('entry');");
  });
});
