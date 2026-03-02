'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChannelType } from '@/shared/domain/types';
import type { OpsSessionsResponse } from '@/modules/ops/types';
import { buildConversationDeleteErrorMessage } from '@/modules/app-shell/conversationDeleteError';
import { getErrorMessage, readJsonOrThrow } from './http';

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
  limit: number;
  activeMinutes: string;
  includeGlobalRequested: boolean;
  includeUnknown: boolean;
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
    setLimit: (value: number) => void;
    setActiveMinutes: (value: string) => void;
    setIncludeGlobalRequested: (value: boolean) => void;
    setIncludeUnknown: (value: boolean) => void;
    setCreateDraft: (value: string) => void;
    setRenameDraft: (conversationId: string, value: string) => void;
    createSession: () => Promise<void>;
    renameSession: (conversationId: string) => Promise<void>;
    deleteSession: (conversationId: string) => Promise<void>;
  };
}

export function useOpsSessions(): UseOpsSessionsResult {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(200);
  const [activeMinutes, setActiveMinutes] = useState('');
  const [includeGlobalRequested, setIncludeGlobalRequested] = useState(false);
  const [includeUnknown, setIncludeUnknown] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OpsSessionsResponse | null>(null);
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState('');
  const [renameDraftById, setRenameDraftById] = useState<Record<string, string>>({});
  const initialLoadRef = useRef(true);

  const queryString = useMemo(() => query.trim(), [query]);
  const activeMinutesString = useMemo(() => activeMinutes.trim(), [activeMinutes]);

  const refresh = useCallback(async () => {
    if (initialLoadRef.current) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (queryString) {
        params.set('q', queryString);
      }
      if (activeMinutesString) {
        params.set('activeMinutes', activeMinutesString);
      }
      if (includeGlobalRequested) {
        params.set('includeGlobal', '1');
      }
      if (!includeUnknown) {
        params.set('includeUnknown', '0');
      }

      const response = await fetch(`/api/ops/sessions?${params.toString()}`, { cache: 'no-store' });
      const payload = await readJsonOrThrow<OpsSessionsResponse>(response);
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
      initialLoadRef.current = false;
    }
  }, [activeMinutesString, includeGlobalRequested, includeUnknown, limit, queryString]);

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
      await readJsonOrThrow<SessionMutationPayload>(response);
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
        await readJsonOrThrow<SessionMutationPayload>(response);
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
        let payload: SessionMutationPayload = {};
        try {
          payload = (await response.json()) as SessionMutationPayload;
        } catch {
          payload = {};
        }
        if (!response.ok || payload.ok === false) {
          throw new Error(
            buildConversationDeleteErrorMessage({
              status: response.status,
              payloadError: payload.error,
              fallback: 'Failed to delete session.',
            }),
          );
        }
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
    limit,
    activeMinutes,
    includeGlobalRequested,
    includeUnknown,
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
      setLimit: (value: number) => {
        if (!Number.isFinite(value)) {
          return;
        }
        setLimit(Math.min(200, Math.max(1, Math.floor(value))));
      },
      setActiveMinutes,
      setIncludeGlobalRequested,
      setIncludeUnknown,
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
