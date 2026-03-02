import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('critical client files avoid barrel imports', () => {
  it('uses direct module imports instead of index barrels in hot paths', () => {
    const configEditor = read('src/components/ConfigEditor.tsx');
    const connectionStatus = read('src/components/ConnectionStatus.tsx');
    const knowledgeView = read('src/components/KnowledgeView.tsx');
    const knowledgeHook = read('src/components/knowledge/hooks/useKnowledgeGraph.ts');
    const logsView = read('src/components/LogsView.tsx');
    const memoryView = read('src/components/MemoryView.tsx');
    const profileView = read('src/components/ProfileView.tsx');
    const agentRoomDetail = read(
      'src/modules/agent-room/components/layout/AgentRoomDetailPage.tsx',
    );

    expect(configEditor).not.toContain("from '@/components/config/hooks'");
    expect(configEditor).not.toContain("from '@/components/config/components'");

    expect(connectionStatus).not.toContain("from '@/modules/gateway'");

    expect(knowledgeView).not.toContain("from '@/components/knowledge/graph'");
    expect(knowledgeView).not.toContain("from '@/components/knowledge/hooks'");
    expect(knowledgeHook).not.toContain("from '@/components/knowledge/graph'");

    expect(logsView).not.toContain("from '@/components/logs/hooks'");
    expect(logsView).not.toContain("from '@/components/logs/components'");

    expect(memoryView).not.toContain("from '@/components/memory/hooks'");
    expect(memoryView).not.toContain("from '@/components/memory/components'");

    expect(profileView).not.toContain("from '@/components/profile/hooks'");
    expect(profileView).not.toContain("from '@/components/profile/components'");

    expect(agentRoomDetail).not.toContain("from '@/modules/agent-room/components/canvas'");
  });
});
