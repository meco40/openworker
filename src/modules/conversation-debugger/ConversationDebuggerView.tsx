import React, { useMemo, useState } from 'react';
import { useConversationDebugger } from './useConversationDebugger';
import ConversationPicker from './components/ConversationPicker';
import TurnTimeline from './components/TurnTimeline';
import TurnDetailPanel from './components/TurnDetailPanel';
import ReplayModal from './components/ReplayModal';
import type { DebugConversationSummary } from './types';

interface ConversationDebuggerViewProps {
  onNavigateToChat?: (conversationId: string) => void;
}

const ConversationDebuggerView: React.FC<ConversationDebuggerViewProps> = ({
  onNavigateToChat,
}) => {
  const {
    conversations,
    conversationsLoading,
    conversationsError,
    selectedConversationId,
    turns,
    turnsLoading,
    turnsLoadingMore,
    turnsHasMore,
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
    loadMoreTurns,
    openReplayModal,
    closeReplayModal,
    startReplay,
  } = useConversationDebugger();

  const [search, setSearch] = useState('');

  const filteredConversations = useMemo<DebugConversationSummary[]>(() => {
    if (!search.trim()) return conversations;
    const q = search.trim().toLowerCase();
    return conversations.filter(
      (c) =>
        c.conversationId.toLowerCase().includes(q) || (c.modelName ?? '').toLowerCase().includes(q),
    );
  }, [conversations, search]);

  const selectedTurn = useMemo(
    () => turns.find((t) => t.seq === selectedTurnSeq) ?? null,
    [turns, selectedTurnSeq],
  );

  const handleOpenChat = (conversationId: string) => {
    closeReplayModal();
    onNavigateToChat?.(conversationId);
  };

  const showDetailPane = !!selectedConversationId;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Page header */}
      <div className="mb-4 flex shrink-0 items-center gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">Conversation Debugger</h1>

        {/* Search */}
        <input
          type="text"
          placeholder="Filter by ID or model…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-2 w-56 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
        />

        <button
          type="button"
          onClick={() => void loadConversations()}
          className="ml-auto rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
        >
          ↻ Refresh
        </button>

        {/* Back button (mobile/narrow) */}
        {showDetailPane && (
          <button
            type="button"
            onClick={() => selectConversation(selectedConversationId!)}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 sm:hidden"
          >
            ← Back
          </button>
        )}
      </div>

      {/* Two-pane body */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        {/* Left pane — conversation list */}
        <div
          className={`flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 p-4 ${
            showDetailPane ? 'hidden sm:flex sm:w-[30%]' : 'flex w-full'
          }`}
        >
          <h2 className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
            Conversations ({filteredConversations.length})
          </h2>
          <div className="min-h-0 flex-1 overflow-auto">
            <ConversationPicker
              conversations={filteredConversations}
              loading={conversationsLoading}
              error={conversationsError}
              selectedId={selectedConversationId}
              onSelect={selectConversation}
              onRefresh={() => void loadConversations()}
            />
          </div>
        </div>

        {/* Right pane — turns + detail */}
        {showDetailPane && (
          <div className="flex min-w-0 flex-1 gap-4 overflow-hidden">
            {/* Turn timeline */}
            <div className="flex w-[22rem] shrink-0 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 p-3 xl:w-[26rem]">
              <h2 className="mb-2 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
                Turns
              </h2>
              <div className="flex-1 overflow-auto">
                <TurnTimeline
                  turns={turns}
                  loading={turnsLoading}
                  loadingMore={turnsLoadingMore}
                  error={turnsError}
                  hasMore={turnsHasMore}
                  selectedSeq={selectedTurnSeq}
                  onSelect={selectTurn}
                  onLoadMore={() => void loadMoreTurns()}
                />
              </div>
            </div>

            {/* Detail panel */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <h2 className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
                Turn Detail
              </h2>
              <div className="flex-1 overflow-auto">
                <TurnDetailPanel turn={selectedTurn} onReplayFrom={openReplayModal} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Replay modal */}
      <ReplayModal
        fromSeq={replayFromSeq}
        open={replayModalOpen}
        loading={replayLoading}
        error={replayError}
        lastReplayConversationId={lastReplayConversationId}
        onStartReplay={startReplay}
        onClose={closeReplayModal}
        onOpenChat={handleOpenChat}
      />
    </div>
  );
};

export default ConversationDebuggerView;
