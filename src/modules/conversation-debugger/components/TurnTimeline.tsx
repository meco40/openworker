import React from 'react';
import type { DebugTurn } from '../types';

interface TurnTimelineProps {
  turns: DebugTurn[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
  onLoadMore: () => void;
}

function riskColor(level: string | undefined): string {
  if (level === 'HIGH') return 'bg-red-500';
  if (level === 'MEDIUM') return 'bg-amber-400';
  return 'bg-emerald-500';
}

const TurnTimeline: React.FC<TurnTimelineProps> = ({
  turns,
  loading,
  loadingMore,
  error,
  hasMore,
  selectedSeq,
  onSelect,
  onLoadMore,
}) => {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-zinc-500">
        Loading turns…
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-zinc-600">
        No turns found for this conversation.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 overflow-auto pr-1">
      {error && (
        <div className="mb-2 rounded border border-red-900/60 bg-red-950/40 px-2 py-1 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {turns.map((turn) => (
        <button
          key={turn.seq}
          type="button"
          onClick={() => onSelect(turn.seq)}
          className={`group flex flex-col gap-1 rounded-lg border px-3 py-2 text-left text-xs leading-relaxed transition-colors ${
            selectedSeq === turn.seq
              ? 'border-blue-600 bg-blue-950/30'
              : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600 hover:bg-zinc-800/50'
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 font-medium ${
                selectedSeq === turn.seq ? 'bg-blue-800 text-blue-100' : 'bg-zinc-700 text-zinc-300'
              }`}
            >
              T{turn.seq}
            </span>

            <span
              className={`h-2 w-2 rounded-full ${riskColor(turn.riskLevel)}`}
              title={`Risk: ${turn.riskLevel ?? 'LOW'}`}
            />

            {turn.toolCalls && turn.toolCalls.length > 0 && (
              <span className="rounded bg-violet-900/60 px-1.5 py-0.5 text-[10px] text-violet-300">
                {turn.toolCalls.length} tool{turn.toolCalls.length === 1 ? '' : 's'}
              </span>
            )}

            {turn.memoryContext && (
              <span className="rounded bg-teal-900/60 px-1.5 py-0.5 text-[10px] text-teal-300">
                M
              </span>
            )}

            <span className="ml-auto shrink-0 text-zinc-600">
              {((turn.promptTokens ?? 0) + (turn.completionTokens ?? 0)).toLocaleString()} tok
            </span>
            {turn.latencyMs != null && (
              <span className="shrink-0 text-zinc-600">{turn.latencyMs}ms</span>
            )}
          </div>

          {turn.userPreview && <p className="truncate text-zinc-400">{turn.userPreview}</p>}
          {turn.modelName && <p className="truncate text-[10px] text-zinc-600">{turn.modelName}</p>}
        </button>
      ))}

      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="mt-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loadingMore ? 'Loading older turns…' : 'Load older turns'}
        </button>
      )}
    </div>
  );
};

export default TurnTimeline;
