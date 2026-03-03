import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readHookSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'src/modules/agent-room/hooks/useAgentRoomRuntime.ts'),
    'utf8',
  );
}

function extractHandleAgentEventDeps(source: string): string {
  const match = source.match(
    /const handleAgentEvent = useCallback\([\s\S]*?\},\s*\[([^\]]*)\]\s*,?\s*\);/m,
  );
  return match?.[1] ?? '';
}

function extractLoadCatalogDeps(source: string): string {
  const match = source.match(/const loadCatalog = useCallback\([\s\S]*?\},\s*\[([^\]]*)\]\s*\);/m);
  return match?.[1] ?? '';
}

function readConnectionHookSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'src/modules/agent-room/hooks/useSwarmConnection.ts'),
    'utf8',
  );
}

describe('useAgentRoomRuntime websocket connection stability', () => {
  it('keeps event callback independent from swarm state to avoid reconnect loops', () => {
    const source = readHookSource();
    const deps = extractHandleAgentEventDeps(source);
    expect(deps).not.toContain('swarms');
  });

  it('keeps catalog loader callback independent from selectedSwarmId state', () => {
    const source = readHookSource();
    const deps = extractLoadCatalogDeps(source);
    expect(deps).not.toContain('selectedSwarmId');
  });

  it('reuses the shared gateway client instead of creating a second connection', () => {
    const source = readConnectionHookSource();
    expect(source).not.toContain('new AgentV2GatewayClient(');
  });
});
