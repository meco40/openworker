import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('agent room layout modes', () => {
  it('routes AgentRoomView between entry and detail pages', () => {
    const source = read('src/modules/agent-room/components/AgentRoomView.tsx');
    expect(source).toContain("const [pageMode, setPageMode] = useState<'entry' | 'detail'>");
    expect(source).toContain('AgentRoomEntryPage');
    expect(source).toContain('AgentRoomDetailPage');
  });
});
