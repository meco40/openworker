import { useState, useCallback, useEffect } from 'react';
import type { DebugConversationSummary, DebugTurn } from './types';

interface ConversationDebuggerState {
  conversations: DebugConversationSummary[];
  conversationsLoading: boolean;
  conversationsError: string | null;
  selectedConversationId: string | null;
  turns: DebugTurn[];
  turnsLoading: boolean;
  turnsLoadingMore: boolean;
  turnsError: string | null;
  turnsHasMore: boolean;
  turnsNextBeforeSeq: number | null;
  selectedTurnSeq: number | null;
  replayModalOpen: boolean;
  replayFromSeq: number | null;
  replayLoading: boolean;
  replayError: string | null;
  lastReplayConversationId: string | null;
}

interface ConversationDebuggerActions {
  loadConversations: () => Promise<void>;
  selectConversation: (id: string) => void;
  selectTurn: (seq: number) => void;
  loadMoreTurns: () => Promise<void>;
  openReplayModal: (fromSeq: number) => void;
  closeReplayModal: () => void;
  startReplay: (modelOverride?: string) => Promise<string | null>;
}

export function useConversationDebugger(): ConversationDebuggerState & ConversationDebuggerActions {
  const [conversations, setConversations] = useState<DebugConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<DebugTurn[]>([]);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [turnsLoadingMore, setTurnsLoadingMore] = useState(false);
  const [turnsError, setTurnsError] = useState<string | null>(null);
  const [turnsHasMore, setTurnsHasMore] = useState(false);
  const [turnsNextBeforeSeq, setTurnsNextBeforeSeq] = useState<number | null>(null);
  const [selectedTurnSeq, setSelectedTurnSeq] = useState<number | null>(null);

  const [replayModalOpen, setReplayModalOpen] = useState(false);
  const [replayFromSeq, setReplayFromSeq] = useState<number | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [lastReplayConversationId, setLastReplayConversationId] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
    setConversationsLoading(true);
    setConversationsError(null);
    try {
      const res = await fetch('/api/debug/conversations');
      const json = (await res.json()) as {
        ok: boolean;
        conversations?: DebugConversationSummary[];
        error?: string;
      };
      if (!json.ok) throw new Error(json.error ?? 'Failed to load conversations');
      setConversations(json.conversations ?? []);
    } catch (err) {
      setConversationsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  const loadTurns = useCallback(
    async (conversationId: string, options?: { beforeSeq?: number; append?: boolean }) => {
      const append = options?.append === true;
      const beforeSeq = options?.beforeSeq;
      if (append) {
        setTurnsLoadingMore(true);
      } else {
        setTurnsLoading(true);
        setTurns([]);
        setSelectedTurnSeq(null);
      }
      setTurnsError(null);
      const query = new URLSearchParams({ limit: '50' });
      if (beforeSeq != null && Number.isFinite(beforeSeq) && beforeSeq > 0) {
        query.set('beforeSeq', String(Math.floor(beforeSeq)));
      }
      type TurnsResponse = {
        ok: boolean;
        turns?: DebugTurn[];
        error?: string;
        pagination?: {
          hasMore?: boolean;
          nextBeforeSeq?: number | null;
        };
      };
      try {
        const res = await fetch(
          `/api/debug/conversations/${encodeURIComponent(conversationId)}/turns?${query.toString()}`,
        );
        const json = (await res.json()) as TurnsResponse;
        if (!json.ok) throw new Error(json.error ?? 'Failed to load turns');
        const incomingTurns = json.turns ?? [];
        setTurns((previous) => {
          if (!append) return incomingTurns;
          const bySeq = new Map<number, DebugTurn>();
          for (const turn of previous) bySeq.set(turn.seq, turn);
          for (const turn of incomingTurns) bySeq.set(turn.seq, turn);
          return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
        });
        setTurnsHasMore(Boolean(json.pagination?.hasMore));
        setTurnsNextBeforeSeq(json.pagination?.nextBeforeSeq ?? null);
      } catch (err) {
        setTurnsError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        if (append) {
          setTurnsLoadingMore(false);
        } else {
          setTurnsLoading(false);
        }
      }
    },
    [],
  );

  const loadMoreTurns = useCallback(async () => {
    if (
      !selectedConversationId ||
      !turnsHasMore ||
      turnsLoadingMore ||
      turnsNextBeforeSeq == null
    ) {
      return;
    }
    try {
      await loadTurns(selectedConversationId, { append: true, beforeSeq: turnsNextBeforeSeq });
    } catch {
      // loadTurns already updates error/loading states.
    }
  }, [selectedConversationId, turnsHasMore, turnsLoadingMore, turnsNextBeforeSeq, loadTurns]);

  const selectConversation = useCallback(
    (id: string) => {
      setSelectedConversationId(id);
      setTurnsHasMore(false);
      setTurnsNextBeforeSeq(null);
      void loadTurns(id);
    },
    [loadTurns],
  );

  const selectTurn = useCallback((seq: number) => {
    setSelectedTurnSeq(seq);
  }, []);

  const openReplayModal = useCallback((fromSeq: number) => {
    setReplayFromSeq(fromSeq);
    setReplayModalOpen(true);
    setReplayError(null);
    setLastReplayConversationId(null);
  }, []);

  const closeReplayModal = useCallback(() => {
    setReplayModalOpen(false);
    setReplayFromSeq(null);
    setReplayError(null);
  }, []);

  const startReplay = useCallback(
    async (modelOverride?: string): Promise<string | null> => {
      if (!selectedConversationId || replayFromSeq == null) return null;
      setReplayLoading(true);
      setReplayError(null);
      try {
        const res = await fetch(
          `/api/debug/conversations/${encodeURIComponent(selectedConversationId)}/replay`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromSeq: replayFromSeq, modelOverride }),
          },
        );
        const json = (await res.json()) as {
          ok: boolean;
          newConversationId?: string;
          error?: string;
        };
        if (!json.ok) throw new Error(json.error ?? 'Replay failed');
        setLastReplayConversationId(json.newConversationId ?? null);
        return json.newConversationId ?? null;
      } catch (err) {
        setReplayError(err instanceof Error ? err.message : 'Replay failed');
        return null;
      } finally {
        setReplayLoading(false);
      }
    },
    [selectedConversationId, replayFromSeq],
  );

  // Auto-load conversations on mount
  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  return {
    conversations,
    conversationsLoading,
    conversationsError,
    selectedConversationId,
    turns,
    turnsLoading,
    turnsLoadingMore,
    turnsError,
    turnsHasMore,
    turnsNextBeforeSeq,
    selectedTurnSeq,
    replayModalOpen,
    replayFromSeq,
    replayLoading,
    replayError,
    lastReplayConversationId,
    loadConversations,
    selectConversation,
    selectTurn,
    loadMoreTurns,
    openReplayModal,
    closeReplayModal,
    startReplay,
  };
}
