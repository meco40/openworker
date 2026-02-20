import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AgentsView from '@/modules/ops/components/AgentsView';
import { useOpsAgents, type UseOpsAgentsResult } from '@/modules/ops/hooks/useOpsAgents';

vi.mock('@/modules/ops/hooks/useOpsAgents', () => ({
  useOpsAgents: vi.fn(),
}));

const mockedUseOpsAgents = vi.mocked(useOpsAgents);

function buildState(partial: Partial<UseOpsAgentsResult> = {}): UseOpsAgentsResult {
  return {
    loading: false,
    refreshing: false,
    error: null,
    data: null,
    refresh: vi.fn(async () => {}),
    ...partial,
  };
}

describe('AgentsView', () => {
  beforeEach(() => {
    mockedUseOpsAgents.mockReturnValue(buildState());
  });

  it('renders loading state and refresh action', () => {
    mockedUseOpsAgents.mockReturnValue(buildState({ loading: true }));
    const html = renderToStaticMarkup(createElement(AgentsView));

    expect(html).toContain('Agents');
    expect(html).toContain('Loading agent runtime snapshot...');
    expect(html).toContain('Refresh');
  });

  it('renders empty rooms state', () => {
    mockedUseOpsAgents.mockReturnValue(
      buildState({
        data: {
          ok: true,
          query: { limit: 20 },
          agents: {
            personas: [],
            sampledRooms: [],
            generatedAt: '2026-02-20T00:00:00.000Z',
          },
        },
      }),
    );

    const html = renderToStaticMarkup(createElement(AgentsView));
    expect(html).toContain('No running agent rooms currently sampled.');
  });

  it('renders persona and room runtime details', () => {
    mockedUseOpsAgents.mockReturnValue(
      buildState({
        data: {
          ok: true,
          query: { limit: 20 },
          agents: {
            personas: [
              {
                id: 'persona-1',
                name: 'Nexus',
                emoji: '🤖',
                vibe: 'operator',
                updatedAt: '2026-02-20T00:00:00.000Z',
                activeRoomCount: 2,
              },
            ],
            sampledRooms: [
              {
                roomId: 'room-1',
                roomName: 'Ops Room',
                runState: 'running',
                memberCount: 2,
                runtimeByStatus: {
                  busy: 1,
                  idle: 1,
                },
                activeRun: {
                  runId: 'run-1',
                  runState: 'running',
                  leaseOwner: 'worker-a',
                  leaseExpiresAt: '2026-02-20T00:10:00.000Z',
                  heartbeatAt: '2026-02-20T00:09:58.000Z',
                },
              },
            ],
            generatedAt: '2026-02-20T00:00:00.000Z',
          },
        },
      }),
    );

    const html = renderToStaticMarkup(createElement(AgentsView));
    expect(html).toContain('Nexus');
    expect(html).toContain('Ops Room');
    expect(html).toContain('busy: 1');
    expect(html).toContain('Lease Owner');
  });
});
