import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SessionsView from '@/modules/ops/components/SessionsView';
import { useOpsSessions, type UseOpsSessionsResult } from '@/modules/ops/hooks/useOpsSessions';
import { ChannelType } from '@/shared/domain/types';
import type { MockProcedure } from '../../helpers/mockProcedure';

vi.mock('@/modules/ops/hooks/useOpsSessions', () => ({
  useOpsSessions: vi.fn<MockProcedure>(),
}));

const mockedUseOpsSessions = vi.mocked(useOpsSessions);

function buildState(partial: Partial<UseOpsSessionsResult> = {}): UseOpsSessionsResult {
  return {
    query: '',
    limit: 200,
    activeMinutes: '',
    includeGlobalRequested: false,
    includeUnknown: true,
    loading: false,
    refreshing: false,
    error: null,
    data: null,
    pendingConversationId: null,
    createDraft: '',
    renameDraftById: {},
    actions: {
      refresh: vi.fn<() => Promise<void>>(async () => {}),
      setQuery: vi.fn<MockProcedure>(),
      setLimit: vi.fn<MockProcedure>(),
      setActiveMinutes: vi.fn<MockProcedure>(),
      setIncludeGlobalRequested: vi.fn<MockProcedure>(),
      setIncludeUnknown: vi.fn<MockProcedure>(),
      setCreateDraft: vi.fn<MockProcedure>(),
      setRenameDraft: vi.fn<MockProcedure>(),
      createSession: vi.fn<() => Promise<void>>(async () => {}),
      renameSession: vi.fn<() => Promise<void>>(async () => {}),
      deleteSession: vi.fn<() => Promise<void>>(async () => {}),
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
    expect(html).toContain('Active within minutes');
    expect(html).toContain('Include global sessions');
    expect(html).toContain('Loading sessions...');
  });

  it('renders empty state when no sessions are returned', () => {
    mockedUseOpsSessions.mockReturnValue(
      buildState({
        data: {
          ok: true,
          query: {
            q: '',
            limit: 50,
            activeMinutes: null,
            includeGlobalRequested: false,
            includeGlobalApplied: false,
            includeUnknown: true,
          },
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
          query: {
            q: '',
            limit: 50,
            activeMinutes: null,
            includeGlobalRequested: false,
            includeGlobalApplied: false,
            includeUnknown: true,
          },
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
