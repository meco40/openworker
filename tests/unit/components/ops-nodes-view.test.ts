import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NodesView from '@/modules/ops/components/NodesView';
import { useOpsNodes, type UseOpsNodesResult } from '@/modules/ops/hooks/useOpsNodes';

vi.mock('@/modules/ops/hooks/useOpsNodes', () => ({
  useOpsNodes: vi.fn(),
}));

const mockedUseOpsNodes = vi.mocked(useOpsNodes);

function buildState(partial: Partial<UseOpsNodesResult> = {}): UseOpsNodesResult {
  return {
    loading: false,
    refreshing: false,
    error: null,
    data: null,
    pendingAction: null,
    mutationError: null,
    mutationNotice: null,
    refresh: vi.fn(async () => {}),
    actions: {
      approveExecCommand: vi.fn(async () => {}),
      revokeExecCommand: vi.fn(async () => {}),
      clearExecApprovals: vi.fn(async () => {}),
      setChannelPersona: vi.fn(async () => {}),
      connectChannel: vi.fn(async () => {}),
      disconnectChannel: vi.fn(async () => {}),
      rotateChannelSecret: vi.fn(async () => {}),
      rejectTelegramPending: vi.fn(async () => {}),
      clearMutationNotice: vi.fn(() => {}),
    },
    ...partial,
  };
}

describe('NodesView', () => {
  beforeEach(() => {
    mockedUseOpsNodes.mockReturnValue(buildState());
  });

  it('renders loading state and refresh action', () => {
    mockedUseOpsNodes.mockReturnValue(buildState({ loading: true }));
    const html = renderToStaticMarkup(createElement(NodesView));

    expect(html).toContain('Nodes');
    expect(html).toContain('Loading node diagnostics...');
    expect(html).toContain('Refresh');
  });

  it('renders empty channel state', () => {
    mockedUseOpsNodes.mockReturnValue(
      buildState({
        data: {
          ok: true,
          nodes: {
            health: {
              status: 'ok',
              summary: { ok: 3, warning: 0, critical: 0, skipped: 0 },
              generatedAt: '2026-02-20T00:00:00.000Z',
            },
            doctor: {
              status: 'ok',
              findings: 0,
              recommendations: 0,
              generatedAt: '2026-02-20T00:00:00.000Z',
            },
            channels: [],
            personas: [],
            execApprovals: {
              total: 0,
              items: [],
            },
            telegramPairing: {
              status: 'idle',
              pendingChatId: null,
              pendingExpiresAt: null,
              hasPending: false,
            },
            automation: {
              activeRules: 0,
              queuedRuns: 0,
              runningRuns: 0,
              deadLetterRuns: 0,
              leaseAgeSeconds: null,
            },
            rooms: {
              totalRooms: 0,
              runningRooms: 0,
              totalMembers: 0,
              totalMessages: 0,
            },
            generatedAt: '2026-02-20T00:00:00.000Z',
          },
        },
      }),
    );

    const html = renderToStaticMarkup(createElement(NodesView));
    expect(html).toContain('No channel bindings found.');
  });

  it('renders diagnostics and channel rows', () => {
    mockedUseOpsNodes.mockReturnValue(
      buildState({
        data: {
          ok: true,
          nodes: {
            health: {
              status: 'warning',
              summary: { ok: 2, warning: 1, critical: 0, skipped: 0 },
              generatedAt: '2026-02-20T00:00:00.000Z',
            },
            doctor: {
              status: 'warning',
              findings: 2,
              recommendations: 3,
              generatedAt: '2026-02-20T00:00:00.000Z',
            },
            channels: [
              {
                channel: 'telegram:chat-1',
                status: 'healthy',
                externalPeerId: 'chat-1',
                peerName: 'Ops Room',
                transport: 'polling',
                lastSeenAt: '2026-02-20T00:10:00.000Z',
                personaId: 'persona-1',
                supportsInbound: true,
                supportsOutbound: true,
                supportsPairing: true,
                supportsStreaming: false,
                accounts: [],
              },
            ],
            personas: [
              {
                id: 'persona-1',
                name: 'Nexus',
                emoji: '🤖',
                vibe: 'operator',
                updatedAt: '2026-02-20T00:00:00.000Z',
              },
            ],
            execApprovals: {
              total: 1,
              items: [
                {
                  command: 'echo hello',
                  updatedAt: '2026-02-20T00:10:00.000Z',
                  fingerprint: 'fp-1',
                },
              ],
            },
            telegramPairing: {
              status: 'awaiting_code',
              pendingChatId: 'chat-99',
              pendingExpiresAt: '2026-02-20T00:20:00.000Z',
              hasPending: true,
            },
            automation: {
              activeRules: 2,
              queuedRuns: 1,
              runningRuns: 1,
              deadLetterRuns: 0,
              leaseAgeSeconds: 15,
            },
            rooms: {
              totalRooms: 4,
              runningRooms: 1,
              totalMembers: 9,
              totalMessages: 120,
            },
            generatedAt: '2026-02-20T00:10:00.000Z',
          },
        },
      }),
    );

    const html = renderToStaticMarkup(createElement(NodesView));
    expect(html).toContain('telegram:chat-1');
    expect(html).toContain('Health Status');
    expect(html).toContain('Doctor Findings');
    expect(html).toContain('Lease Age');
    expect(html).toContain('Exec Approvals');
    expect(html).toContain('Channel Controls');
    expect(html).toContain('Telegram Pending Pairing');
  });
});
