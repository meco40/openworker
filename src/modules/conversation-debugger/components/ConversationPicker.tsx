import React from 'react';
import type { DebugConversationSummary } from '../types';

interface ConversationPickerProps {
  conversations: DebugConversationSummary[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

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
      <div className="flex items-center justify-center py-12 text-sm text-zinc-500">
        Loading conversations…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/30 p-4 text-sm text-red-400">
        {error}
        <button onClick={onRefresh} className="ml-3 underline hover:text-red-200" type="button">
          Retry
        </button>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-zinc-500">
        <span className="text-sm">No conversations logged yet.</span>
        <p className="max-w-xs text-center text-xs text-zinc-600">
          Conversations appear here after the first AI dispatch with a linked conversation ID.
        </p>
        <button onClick={onRefresh} className="text-xs text-zinc-400 underline" type="button">
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500">
            <th className="py-2 pr-3 font-medium">Conversation</th>
            <th className="py-2 pr-3 text-right font-medium">Turns</th>
            <th className="py-2 pr-3 text-right font-medium">Tokens</th>
            <th className="py-2 pr-3 text-right font-medium">Cost</th>
            <th className="py-2 pr-3 font-medium">Last Activity</th>
            <th className="py-2 pr-3 font-medium">Model</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {conversations.map((conv) => (
            <tr
              key={conv.conversationId}
              className={`border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/30 ${
                selectedId === conv.conversationId ? 'bg-zinc-800/50' : ''
              }`}
            >
              <td className="max-w-[140px] overflow-hidden py-2 pr-3 font-mono text-ellipsis whitespace-nowrap text-zinc-300">
                <span title={conv.conversationId}>{conv.conversationId.slice(0, 18)}…</span>
              </td>
              <td className="py-2 pr-3 text-right text-zinc-400">{conv.turnCount}</td>
              <td className="py-2 pr-3 text-right text-zinc-400">
                {conv.totalTokens.toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-right text-zinc-400">
                {conv.totalCostUsd != null ? `$${conv.totalCostUsd.toFixed(4)}` : '—'}
              </td>
              <td className="py-2 pr-3 text-zinc-500" title={conv.lastActivity}>
                {formatRelativeTime(conv.lastActivity)}
              </td>
              <td className="max-w-[120px] overflow-hidden py-2 pr-3 text-ellipsis whitespace-nowrap text-zinc-500">
                {conv.modelName || '—'}
              </td>
              <td className="py-2">
                <button
                  onClick={() => onSelect(conv.conversationId)}
                  className="rounded bg-zinc-700 px-2 py-0.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-600"
                  type="button"
                >
                  Debug →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default ConversationPicker;
