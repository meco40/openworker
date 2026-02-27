import React from 'react';
import type { DebugTurn } from '../types';
import { Spinner, EmptyState, ErrorBanner, Badge, riskDotClass } from './ui-helpers';

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

// ─── Turn Card ────────────────────────────────────────────────────────────────

interface TurnCardProps {
  turn: DebugTurn;
  isSelected: boolean;
  onSelect: (seq: number) => void;
}

const TurnCard: React.FC<TurnCardProps> = ({ turn, isSelected, onSelect }) => {
  const totalTokens = (turn.promptTokens ?? 0) + (turn.completionTokens ?? 0);
  const hasTools = turn.toolCalls && turn.toolCalls.length > 0;
  const hasMemory = !!turn.memoryContext;

  return (
    <button
      type="button"
      onClick={() => onSelect(turn.seq)}
      aria-pressed={isSelected}
      aria-label={`Turn ${String(turn.seq)}${turn.userPreview ? `: ${turn.userPreview.slice(0, 60)}` : ''}`}
      className={`group relative w-full rounded-lg border px-3 py-2.5 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        isSelected
          ? 'border-blue-600/60 bg-blue-950/25 shadow-sm shadow-blue-900/20'
          : 'border-zinc-800/60 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-800/30'
      }`}
    >
      {/* Timeline connector line */}
      <span
        className="absolute top-0 bottom-0 left-0 w-0.5 rounded-full"
        style={{
          background: isSelected
            ? 'rgb(37 99 235 / 0.6)'
            : 'rgb(63 63 70 / 0.4)',
        }}
        aria-hidden="true"
      />

      {/* Row 1: seq badge + risk dot + badges */}
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          className={`inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded px-1 font-mono text-[10px] font-bold leading-none ${
            isSelected ? 'bg-blue-800/80 text-blue-100' : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          T{turn.seq}
        </span>

        {/* Risk dot */}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${riskDotClass(turn.riskLevel)}`}
          title={`Risk: ${(turn.riskLevel ?? 'low').toUpperCase()}`}
          aria-label={`Risk level: ${turn.riskLevel ?? 'low'}`}
        />

        {/* Tool calls badge */}
        {hasTools && (
          <Badge variant="violet">
            {turn.toolCalls.length} tool{turn.toolCalls.length === 1 ? '' : 's'}
          </Badge>
        )}

        {/* Memory badge */}
        {hasMemory && (
          <Badge variant="teal" title="Has memory context">
            M
          </Badge>
        )}

        {/* Metrics — right-aligned */}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-zinc-600">
          {totalTokens > 0 && <span>{totalTokens.toLocaleString()} tok</span>}
          {turn.latencyMs != null && <span>{turn.latencyMs}ms</span>}
        </span>
      </div>

      {/* Row 2: user preview */}
      {turn.userPreview && (
        <p className="mb-0.5 truncate text-[11px] leading-snug text-zinc-400">
          {turn.userPreview}
        </p>
      )}

      {/* Row 3: model name */}
      {turn.modelName && (
        <p className="truncate text-[10px] text-zinc-700">{turn.modelName}</p>
      )}
    </button>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

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
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <Spinner size="md" />
        <span className="text-xs text-zinc-600">Loading turns…</span>
      </div>
    );
  }

  if (turns.length === 0 && !error) {
    return (
      <EmptyState
        title="No turns found"
        description="This conversation has no recorded turns."
      />
    );
  }

  return (
    <div className="flex flex-col gap-1" role="list" aria-label="Turn timeline">
      {/* Inline error (non-blocking — show above turns if any loaded) */}
      {error && (
        <div className="mb-1">
          <ErrorBanner message={error} compact />
        </div>
      )}

      {turns.map((turn) => (
        <div key={turn.seq} role="listitem">
          <TurnCard
            turn={turn}
            isSelected={selectedSeq === turn.seq}
            onSelect={onSelect}
          />
        </div>
      ))}

      {/* Load more */}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-3 py-2 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loadingMore ? (
            <>
              <Spinner size="sm" />
              Loading older turns…
            </>
          ) : (
            <>
              <span aria-hidden="true">↑</span>
              Load older turns
            </>
          )}
        </button>
      )}
    </div>
  );
};

export default TurnTimeline;
