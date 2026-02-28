import React from 'react';
import type { DebugConversationSummary } from '../types';
import { Spinner, EmptyState, ErrorBanner, Badge, formatRelativeTime } from './ui-helpers';

interface ConversationPickerProps {
  conversations: DebugConversationSummary[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}

// ─── Conversation Card ────────────────────────────────────────────────────────

interface ConversationCardProps {
  conv: DebugConversationSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

const ConversationCard: React.FC<ConversationCardProps> = ({ conv, isSelected, onSelect }) => {
  const shortId = conv.conversationId.slice(0, 8);
  const restId = conv.conversationId.slice(8, 20);

  return (
    <button
      type="button"
      onClick={() => onSelect(conv.conversationId)}
      aria-pressed={isSelected}
      aria-label={`Debug conversation ${conv.conversationId}`}
      className={`group w-full rounded-lg border px-3 py-2.5 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        isSelected
          ? 'border-blue-600/60 bg-blue-950/30 shadow-sm shadow-blue-900/20'
          : 'border-zinc-800/60 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-800/40'
      }`}
    >
      {/* Row 1: ID + time */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-xs leading-none">
          <span className={isSelected ? 'text-blue-300' : 'text-zinc-300'}>{shortId}</span>
          <span className="text-zinc-600">{restId}</span>
          {conv.conversationId.length > 20 && <span className="text-zinc-700">…</span>}
        </span>
        <span className="shrink-0 text-[10px] text-zinc-600" title={conv.lastActivity}>
          {formatRelativeTime(conv.lastActivity)}
        </span>
      </div>

      {/* Row 2: model badge */}
      {conv.modelName && (
        <div className="mb-2">
          <Badge variant="zinc" className="max-w-full truncate">
            {conv.modelName}
          </Badge>
        </div>
      )}

      {/* Row 3: metrics */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="text-zinc-700" aria-hidden="true">
            ↕
          </span>
          <span>
            {conv.turnCount} turn{conv.turnCount === 1 ? '' : 's'}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <span className="text-zinc-700" aria-hidden="true">
            ◈
          </span>
          <span>{conv.totalTokens.toLocaleString()} tok</span>
        </span>
        {conv.totalCostUsd != null && (
          <span className="flex items-center gap-1">
            <span className="text-zinc-700" aria-hidden="true">
              $
            </span>
            <span>{conv.totalCostUsd.toFixed(4)}</span>
          </span>
        )}

        {/* Debug CTA — only visible on hover/selected */}
        <span
          className={`ml-auto text-[10px] font-medium transition-opacity ${
            isSelected
              ? 'text-blue-400 opacity-100'
              : 'text-zinc-600 opacity-0 group-hover:opacity-100'
          }`}
          aria-hidden="true"
        >
          {isSelected ? '● Debugging' : 'Debug →'}
        </span>
      </div>
    </button>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

const ConversationPicker: React.FC<ConversationPickerProps> = ({
  conversations,
  loading,
  error,
  selectedId,
  onSelect,
  onRefresh,
}) => {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <Spinner size="md" />
        <span className="text-xs text-zinc-600">Loading conversations…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <ErrorBanner message={error} onRetry={onRefresh} />
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <EmptyState
        icon={
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-10 w-10"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
            />
          </svg>
        }
        title="No conversations yet"
        description="Conversations appear here after the first AI dispatch with a linked conversation ID."
        action={
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Refresh
          </button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5 p-2" role="list" aria-label="Conversations">
      {conversations.map((conv) => (
        <div key={conv.conversationId} role="listitem">
          <ConversationCard
            conv={conv}
            isSelected={selectedId === conv.conversationId}
            onSelect={onSelect}
          />
        </div>
      ))}
    </div>
  );
};

export default ConversationPicker;
