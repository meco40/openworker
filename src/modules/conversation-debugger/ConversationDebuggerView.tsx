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
    <div className="flex h-full flex-col overflow-hidden bg-zinc-950">
      {/* ── Page Header ─────────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-5 py-3">
        {/* Back button — visible only when detail pane is open on narrow screens */}
        {showDetailPane && (
          <button
            type="button"
            aria-label="Back to conversation list"
            onClick={() => selectConversation(selectedConversationId!)}
            className="mr-1 flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:hidden"
          >
            <span aria-hidden="true">←</span> Back
          </button>
        )}

        <div className="flex items-center gap-2">
          {/* Icon */}
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-900/40 text-blue-400"
            aria-hidden="true"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path
                fillRule="evenodd"
                d="M10 2a8 8 0 100 16A8 8 0 0010 2zm0 14a6 6 0 110-12 6 6 0 010 12zm-1-5a1 1 0 112 0v2a1 1 0 11-2 0v-2zm0-4a1 1 0 112 0 1 1 0 01-2 0z"
                clipRule="evenodd"
              />
            </svg>
          </span>
          <h1 className="text-sm font-semibold text-zinc-100">Conversation Debugger</h1>
        </div>

        {/* Conversation count chip */}
        {!conversationsLoading && conversations.length > 0 && (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-500">
            {filteredConversations.length}
            {filteredConversations.length !== conversations.length
              ? ` / ${String(conversations.length)}`
              : ''}
          </span>
        )}

        {/* Search */}
        <div className="relative ml-2 flex-1 sm:max-w-xs">
          <span
            className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-zinc-600"
            aria-hidden="true"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path
                fillRule="evenodd"
                d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                clipRule="evenodd"
              />
            </svg>
          </span>
          <input
            type="search"
            placeholder="Filter by ID or model…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Filter conversations"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/60 py-1.5 pr-3 pl-8 text-xs text-zinc-200 placeholder-zinc-600 transition-colors focus:border-blue-500 focus:bg-zinc-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch('')}
              className="absolute inset-y-0 right-2 flex items-center text-zinc-600 hover:text-zinc-400"
            >
              ×
            </button>
          )}
        </div>

        {/* Refresh */}
        <button
          type="button"
          onClick={() => void loadConversations()}
          disabled={conversationsLoading}
          aria-label="Refresh conversations"
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`h-3.5 w-3.5 ${conversationsLoading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z"
              clipRule="evenodd"
            />
          </svg>
          Refresh
        </button>
      </header>

      {/* ── Two-pane Body ────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 gap-0 overflow-hidden">
        {/* Left pane — conversation list */}
        <aside
          aria-label="Conversation list"
          className={`flex flex-col overflow-hidden border-r border-zinc-800 bg-zinc-900 ${
            showDetailPane ? 'hidden sm:flex sm:w-[32%] lg:w-[28%]' : 'flex w-full'
          }`}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-800/60 px-4 py-2.5">
            <span className="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
              Conversations
            </span>
          </div>
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
        </aside>

        {/* Right pane — turns + detail */}
        {showDetailPane && (
          <div className="flex min-w-0 flex-1 overflow-hidden">
            {/* Turn timeline */}
            <section
              aria-label="Turn timeline"
              className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-zinc-800 bg-zinc-900/80 xl:w-72"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-800/60 px-4 py-2.5">
                <span className="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
                  Turns
                </span>
                {turns.length > 0 && (
                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-600">
                    {turns.length}
                    {turnsHasMore ? '+' : ''}
                  </span>
                )}
              </div>
              <div className="flex-1 overflow-auto p-2">
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
            </section>

            {/* Detail panel */}
            <section
              aria-label="Turn detail"
              className="flex min-w-0 flex-1 flex-col overflow-hidden bg-zinc-950"
            >
              <div className="flex shrink-0 items-center border-b border-zinc-800/60 px-5 py-2.5">
                <span className="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
                  Turn Detail
                </span>
                {selectedTurn && (
                  <span className="ml-2 rounded bg-blue-900/40 px-1.5 py-0.5 font-mono text-[10px] text-blue-400">
                    T{selectedTurn.seq}
                  </span>
                )}
              </div>
              <div className="flex-1 overflow-auto px-5 py-4">
                <TurnDetailPanel turn={selectedTurn} onReplayFrom={openReplayModal} />
              </div>
            </section>
          </div>
        )}

        {/* Empty state when no conversation selected */}
        {!showDetailPane && !conversationsLoading && conversations.length > 0 && (
          <div className="hidden flex-1 items-center justify-center sm:flex">
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="text-4xl" aria-hidden="true">
                🔍
              </span>
              <p className="text-sm font-medium text-zinc-500">Select a conversation to debug</p>
              <p className="max-w-xs text-xs text-zinc-700">
                Choose a conversation from the list to inspect its turns, token usage, and tool
                calls.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Replay Modal ─────────────────────────────────────────────────── */}
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
