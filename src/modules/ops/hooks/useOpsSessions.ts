'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChannelType } from '@/shared/domain/types';
import type { OpsSessionsResponse } from '@/modules/ops/types';

interface ErrorPayload {
  ok?: boolean;
  error?: string;
}

interface SessionMutationPayload extends ErrorPayload {
  conversation?: {
    id: string;
  };
}

export interface UseOpsSessionsResult {
  query: string;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  data: OpsSessionsResponse | null;
  pendingConversationId: string | null;
  createDraft: string;
  renameDraftById: Record<string, string>;
  actions: {
    refresh: () => Promise<void>;
    setQuery: (value: string) => void;
    setCreateDraft: (value: string) => void;
    setRenameDraft: (conversationId: string, value: string) => void;
    createSession: () => Promise<void>;
    renameSession: (conversationId: string) => Promise<void>;
    deleteSession: (conversationId: string) => Promise<void>;
  };
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function readJson<T extends ErrorPayload>(response: Response): Promise<T> {
  const payload = (await response.json()) as T;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

export function useOpsSessions(): UseOpsSessionsResult {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OpsSessionsResponse | null>(null);
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState('');
  const [renameDraftById, setRenameDraftById] = useState<Record<string, string>>({});

  const queryString = useMemo(() => query.trim(), [query]);

  const refresh = useCallback(async () => {
    if (loading) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (queryString) {
        params.set('q', queryString);
      }

      const response = await fetch(`/api/ops/sessions?${params.toString()}`, { cache: 'no-store' });
      const payload = await readJson<OpsSessionsResponse>(response);
      setData(payload);
      setRenameDraftById((previous) => {
        const next = { ...previous };
        for (const session of payload.sessions) {
          if (!(session.id in next)) {
            next[session.id] = session.title;
          }
        }
        return next;
      });
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Failed to load sessions.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loading, queryString]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh();
    }, 180);
    return () => clearTimeout(timer);
  }, [refresh]);

  const createSession = useCallback(async () => {
    setPendingConversationId('create');
    setError(null);
    try {
      const title = createDraft.trim();
      const response = await fetch('/api/channels/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelType: ChannelType.WEBCHAT,
          title: title || undefined,
        }),
      });
      await readJson<SessionMutationPayload>(response);
      setCreateDraft('');
      await refresh();
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Failed to create session.'));
    } finally {
      setPendingConversationId(null);
    }
  }, [createDraft, refresh]);

  const renameSession = useCallback(
    async (conversationId: string) => {
      const nextTitle = String(renameDraftById[conversationId] || '').trim();
      if (!nextTitle) {
        setError('Title is required.');
        return;
      }

      setPendingConversationId(conversationId);
      setError(null);
      try {
        const response = await fetch('/api/channels/conversations', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId,
            title: nextTitle,
          }),
        });
        await readJson<SessionMutationPayload>(response);
        await refresh();
      } catch (requestError) {
        setError(getErrorMessage(requestError, 'Failed to rename session.'));
      } finally {
        setPendingConversationId(null);
      }
    },
    [refresh, renameDraftById],
  );

  const deleteSession = useCallback(
    async (conversationId: string) => {
      setPendingConversationId(conversationId);
      setError(null);
      try {
        const response = await fetch(
          `/api/channels/conversations?id=${encodeURIComponent(conversationId)}`,
          {
            method: 'DELETE',
          },
        );
        await readJson<SessionMutationPayload>(response);
        await refresh();
      } catch (requestError) {
        setError(getErrorMessage(requestError, 'Failed to delete session.'));
      } finally {
        setPendingConversationId(null);
      }
    },
    [refresh],
  );

  return {
    query,
    loading,
    refreshing,
    error,
    data,
    pendingConversationId,
    createDraft,
    renameDraftById,
    actions: {
      refresh,
      setQuery,
      setCreateDraft,
      setRenameDraft: (conversationId: string, value: string) => {
        setRenameDraftById((previous) => ({ ...previous, [conversationId]: value }));
      },
      createSession,
      renameSession,
      deleteSession,
    },
  };
}
