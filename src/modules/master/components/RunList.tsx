import React from 'react';
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
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-3 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
        Runs
        <span className="ml-2 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">
          {runs.length}
        </span>
      </h3>

      {runs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-6 text-center text-sm text-zinc-600">
          No runs yet. Create your first Master Run above.
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelectRun(run.id)}
                className={`w-full rounded-xl border p-3 text-left transition-all ${
                  selectedRunId === run.id
                    ? 'border-indigo-500/60 bg-indigo-900/20'
                    : 'border-zinc-700 bg-zinc-950/60 hover:border-zinc-600 hover:bg-zinc-900'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-zinc-100">{run.title}</span>
                  <RunStatusBadge status={run.status} />
                </div>
                <p className="mt-1 line-clamp-1 text-xs text-zinc-500">{run.contract}</p>
                {/* Progress bar */}
                <div className="mt-2.5 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] text-zinc-600">Progress</span>
                    <span className="font-mono text-[9px] text-zinc-500">{run.progress}%</span>
                  </div>
                  <div
                    className="h-1 w-full overflow-hidden rounded-full bg-zinc-800"
                    role="progressbar"
                    aria-valuenow={run.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        run.status === 'FAILED'
                          ? 'bg-rose-500'
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
            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => onPageChange(Math.max(0, runsPage - 1))}
                disabled={runsPage === 0}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[10px] font-bold text-zinc-400 transition-all hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
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
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[10px] font-bold text-zinc-400 transition-all hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
