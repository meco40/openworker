import React, { useCallback } from 'react';
import type { MasterRun } from '@/modules/master/types';
import { RunStatusBadge } from './RunStatusBadge';

interface RunListProps {
  runs: MasterRun[];
  selectedRunId: string | null;
  runsPage: number;
  totalRunPages: number;
  onSelectRun: (id: string) => void;
  onPageChange: (page: number) => void;
}

export const RunList: React.FC<RunListProps> = ({
  runs,
  selectedRunId,
  runsPage,
  totalRunPages,
  onSelectRun,
  onPageChange,
}) => {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (runs.length === 0) return;
      const currentIndex = runs.findIndex((r) => r.id === selectedRunId);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(currentIndex + 1, runs.length - 1);
        onSelectRun(runs[next].id);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = Math.max(currentIndex - 1, 0);
        onSelectRun(runs[prev].id);
      }
    },
    [runs, selectedRunId, onSelectRun],
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      {/* Header */}
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/15">
            <svg
              className="h-3.5 w-3.5 text-emerald-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 10h16M4 14h16M4 18h16"
              />
            </svg>
          </div>
          <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">Runs</h3>
          <span className="ml-1 rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-zinc-500">
            {runs.length}
          </span>
        </div>
      </div>

      <div className="p-4">
        {runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-10 text-center">
            <svg
              className="mb-3 h-10 w-10 text-zinc-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            <p className="text-sm font-medium text-zinc-600">No runs yet</p>
            <p className="mt-1 text-xs text-zinc-700">Create your first Master Run above.</p>
          </div>
        ) : (
          <>
            <div
              role="listbox"
              aria-label="Master runs"
              className="space-y-2"
              onKeyDown={handleKeyDown}
            >
              {runs.map((run, index) => (
                <button
                  key={run.id}
                  type="button"
                  role="option"
                  aria-selected={selectedRunId === run.id}
                  tabIndex={
                    selectedRunId === run.id || (selectedRunId === null && index === 0) ? 0 : -1
                  }
                  onClick={() => onSelectRun(run.id)}
                  className={`w-full rounded-xl border p-3.5 text-left transition-all ${
                    selectedRunId === run.id
                      ? 'border-indigo-500/50 bg-indigo-900/20 shadow-lg shadow-indigo-900/10'
                      : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700 hover:bg-zinc-900/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-zinc-100">
                      {run.title}
                    </span>
                    <RunStatusBadge status={run.status} />
                  </div>
                  <p className="mt-1 line-clamp-1 text-xs text-zinc-500">{run.contract}</p>
                  {/* Progress bar */}
                  <div className="mt-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[9px] font-semibold tracking-wide text-zinc-600 uppercase">
                        Progress
                      </span>
                      <span className="font-mono text-[9px] font-semibold text-zinc-400">
                        {run.progress}%
                      </span>
                    </div>
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/80"
                      role="progressbar"
                      aria-valuenow={run.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          run.status === 'FAILED'
                            ? 'bg-rose-500'
                            : run.status === 'CANCELLED'
                              ? 'bg-zinc-500'
                              : run.status === 'COMPLETED'
                                ? 'bg-indigo-500'
                                : 'bg-emerald-500'
                        }`}
                        style={{ width: `${run.progress}%` }}
                      />
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {/* Pagination */}
            {totalRunPages > 1 && (
              <div className="mt-4 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onPageChange(Math.max(0, runsPage - 1))}
                  disabled={runsPage === 0}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[10px] font-bold tracking-wide text-zinc-400 uppercase transition-all hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ← Prev
                </button>
                <span className="font-mono text-[10px] text-zinc-500">
                  {runsPage + 1} / {totalRunPages}
                </span>
                <button
                  type="button"
                  onClick={() => onPageChange(Math.min(totalRunPages - 1, runsPage + 1))}
                  disabled={runsPage >= totalRunPages - 1}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[10px] font-bold tracking-wide text-zinc-400 uppercase transition-all hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
