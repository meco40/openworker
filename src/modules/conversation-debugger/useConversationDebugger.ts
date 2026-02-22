import { useState, useCallback, useEffect } from 'react';
import type { DebugConversationSummary, DebugTurn } from './types';

interface ConversationDebuggerState {
  conversations: DebugConversationSummary[];
  conversationsLoading: boolean;
  conversationsError: string | null;
  selectedConversationId: string | null;
  turns: DebugTurn[];
  turnsLoading: boolean;
  turnsError: string | null;
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
  const [turnsError, setTurnsError] = useState<string | null>(null);
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

  const loadTurns = useCallback(async (conversationId: string) => {
    setTurnsLoading(true);
    setTurnsError(null);
    setTurns([]);
    setSelectedTurnSeq(null);
    try {
      const res = await fetch(
        `/api/debug/conversations/${encodeURIComponent(conversationId)}/turns`,
      );
      const json = (await res.json()) as { ok: boolean; turns?: DebugTurn[]; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Failed to load turns');
      setTurns(json.turns ?? []);
    } catch (err) {
      setTurnsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setTurnsLoading(false);
    }
  }, []);

  const selectConversation = useCallback(
    (id: string) => {
      setSelectedConversationId(id);
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
    turnsError,
    selectedTurnSeq,
    replayModalOpen,
    replayFromSeq,
    replayLoading,
    replayError,
    lastReplayConversationId,
    loadConversations,
    selectConversation,
    selectTurn,
    openReplayModal,
    closeReplayModal,
    startReplay,
  };
}
