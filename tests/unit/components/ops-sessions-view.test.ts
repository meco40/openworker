import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SessionsView from '@/modules/ops/components/SessionsView';
import { useOpsSessions, type UseOpsSessionsResult } from '@/modules/ops/hooks/useOpsSessions';
import { ChannelType } from '@/shared/domain/types';

vi.mock('@/modules/ops/hooks/useOpsSessions', () => ({
  useOpsSessions: vi.fn(),
}));

const mockedUseOpsSessions = vi.mocked(useOpsSessions);

function buildState(partial: Partial<UseOpsSessionsResult> = {}): UseOpsSessionsResult {
  return {
    query: '',
    loading: false,
    refreshing: false,
    error: null,
    data: null,
    pendingConversationId: null,
    createDraft: '',
    renameDraftById: {},
    actions: {
      refresh: vi.fn(async () => {}),
      setQuery: vi.fn(),
      setCreateDraft: vi.fn(),
      setRenameDraft: vi.fn(),
      createSession: vi.fn(async () => {}),
      renameSession: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => {}),
    },
    ...partial,
  };
}

describe('SessionsView', () => {
  beforeEach(() => {
    mockedUseOpsSessions.mockReturnValue(buildState());
  });

  it('renders loading state and session actions shell', () => {
    mockedUseOpsSessions.mockReturnValue(buildState({ loading: true }));
    const html = renderToStaticMarkup(createElement(SessionsView));

    expect(html).toContain('Sessions');
    expect(html).toContain('Search sessions');
    expect(html).toContain('Create Session');
    expect(html).toContain('Loading sessions...');
  });

  it('renders empty state when no sessions are returned', () => {
    mockedUseOpsSessions.mockReturnValue(
      buildState({
        data: {
          ok: true,
          query: { q: '', limit: 50 },
          sessions: [],
          generatedAt: '2026-02-20T00:00:00.000Z',
        },
      }),
    );

    const html = renderToStaticMarkup(createElement(SessionsView));
    expect(html).toContain('No sessions matched the current query.');
  });

  it('renders session rows with rename and delete actions', () => {
    mockedUseOpsSessions.mockReturnValue(
      buildState({
        renameDraftById: { 'conv-1': 'Renamed title' },
        data: {
          ok: true,
          query: { q: '', limit: 50 },
          sessions: [
            {
              id: 'conv-1',
              channelType: ChannelType.WEBCHAT,
              externalChatId: 'ext-1',
              title: 'First Session',
              modelOverride: null,
              personaId: null,
              createdAt: '2026-02-20T00:00:00.000Z',
              updatedAt: '2026-02-20T00:10:00.000Z',
            },
          ],
          generatedAt: '2026-02-20T00:10:00.000Z',
        },
      }),
    );

    const html = renderToStaticMarkup(createElement(SessionsView));
    expect(html).toContain('First Session');
    expect(html).toContain('Rename');
    expect(html).toContain('Delete');
    expect(html).toContain('Channel');
  });
});
