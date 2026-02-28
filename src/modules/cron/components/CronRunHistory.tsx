'use client';

import React from 'react';
import type { CronRun } from '@/modules/cron/types';
import { RunStatusBadge } from '@/modules/cron/components/CronStatusBadge';
import type { UseCronRulesResult } from '@/modules/cron/hooks/useCronRules';

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

interface CronRunHistoryProps {
  runs: CronRun[];
  historyLimit: number;
  historyLoading: boolean;
  historyError: string | null;
  selectedRuleName: string | null;
  onSetHistoryLimit: UseCronRulesResult['actions']['setHistoryLimit'];
}

const HISTORY_LIMIT_OPTIONS = [20, 50, 100, 200, 500];

export const CronRunHistory: React.FC<CronRunHistoryProps> = ({
  runs,
  historyLimit,
  historyLoading,
  historyError,
  selectedRuleName,
  onSetHistoryLimit,
}) => {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div>
          <h3 className="text-sm font-bold text-zinc-100">Run History</h3>
          {selectedRuleName ? (
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Showing runs for{' '}
              <span className="font-semibold text-zinc-300">{selectedRuleName}</span>
            </p>
          ) : (
            <p className="mt-0.5 text-[11px] text-zinc-500">Select a rule to view its runs.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label
            htmlFor="cron-history-depth"
            className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase"
          >
            Run history depth
          </label>
          <select
            id="cron-history-depth"
            value={String(historyLimit)}
            onChange={(e) => onSetHistoryLimit(Number.parseInt(e.target.value, 10))}
            className="rounded-lg border border-zinc-700/60 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {HISTORY_LIMIT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Body */}
      <div className="p-4">
        {historyLoading && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-400" />
            Loading run history…
          </div>
        )}

        {!historyLoading && historyError && (
          <div className="rounded-lg border border-rose-800/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
            {historyError}
          </div>
        )}

        {!historyLoading && !historyError && !runs.length && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="mb-2 text-3xl opacity-20">📋</div>
            <p className="text-xs text-zinc-500">No runs for the selected rule yet.</p>
          </div>
        )}

        {!historyLoading && !historyError && runs.length > 0 && (
          <div className="space-y-2">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
};

// ─── Run Card ─────────────────────────────────────────────────────────────────

interface RunCardProps {
  run: CronRun;
}

const RunCard: React.FC<RunCardProps> = ({ run }) => {
  const duration = formatDuration(run.startedAt, run.finishedAt);

  return (
    <article className="rounded-lg border border-zinc-800/60 bg-zinc-950/60 p-3 transition-colors hover:border-zinc-700/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <RunStatusBadge status={run.status} />
          {run.triggerSource === 'manual' && (
            <span className="rounded border border-zinc-700/40 bg-zinc-800/60 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-zinc-500 uppercase">
              Manual
            </span>
          )}
          {run.attempt > 1 && (
            <span className="rounded border border-amber-700/30 bg-amber-900/20 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-amber-400 uppercase">
              Attempt {run.attempt}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-zinc-500">
          {duration && <span>⏱ {duration}</span>}
          <span>{formatDateTime(run.createdAt)}</span>
        </div>
      </div>

      {run.errorMessage && (
        <div className="mt-2 rounded border border-rose-800/30 bg-rose-950/20 px-2 py-1.5">
          <p className="text-[11px] font-semibold text-rose-400">Error</p>
          <p className="mt-0.5 text-[11px] text-rose-300/80">{run.errorMessage}</p>
        </div>
      )}

      {run.resultSummary && (
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">{run.resultSummary}</p>
      )}
    </article>
  );
};
