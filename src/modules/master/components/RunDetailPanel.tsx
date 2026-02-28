import React from 'react';
import type { MasterStep } from '@/modules/master/types';

// ─── Step status config ───────────────────────────────────────────────────────

const STEP_STATUS_CLASSES: Record<MasterStep['status'], { badge: string; dot: string }> = {
  pending: { badge: 'bg-zinc-800/80 text-zinc-500 border-zinc-700/50', dot: 'bg-zinc-600' },
  running: {
    badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    dot: 'bg-emerald-400',
  },
  done: { badge: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30', dot: 'bg-indigo-400' },
  error: { badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30', dot: 'bg-rose-400' },
  blocked: { badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30', dot: 'bg-amber-400' },
};

function StepStatusBadge({ status }: { status: MasterStep['status'] }) {
  const cfg = STEP_STATUS_CLASSES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold tracking-wide uppercase ${cfg.badge}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${cfg.dot} ${status === 'running' ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {status}
    </span>
  );
}

// ─── RunDetailPanel ───────────────────────────────────────────────────────────

interface RunDetailPanelProps {
  steps: MasterStep[];
  loading?: boolean;
}

export const RunDetailPanel: React.FC<RunDetailPanelProps> = ({ steps, loading = false }) => {
  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      {/* Header */}
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/15">
            <svg
              className="h-3.5 w-3.5 text-violet-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
          <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
            Run Steps
          </h3>
          <span className="ml-1 rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-zinc-500">
            {steps.length}
          </span>
        </div>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="flex items-center gap-3 py-4 text-xs text-zinc-500">
            <svg
              className="h-4 w-4 animate-spin text-indigo-400"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Loading steps…
          </div>
        ) : steps.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-6 text-center text-xs text-zinc-600">
            No steps recorded yet.
          </div>
        ) : (
          /* Timeline layout */
          <div className="relative max-h-72 overflow-y-auto">
            {/* Vertical line */}
            <div className="absolute top-0 bottom-0 left-5 w-px bg-zinc-800" aria-hidden="true" />

            <div className="space-y-2 pl-11">
              {steps.map((step) => {
                const cfg = STEP_STATUS_CLASSES[step.status];
                return (
                  <div key={step.id} className="relative">
                    {/* Timeline dot */}
                    <div
                      className={`absolute top-3 -left-[30px] h-2.5 w-2.5 rounded-full border-2 border-zinc-900 ${cfg.dot} ${step.status === 'running' ? 'animate-pulse' : ''}`}
                      aria-hidden="true"
                    />
                    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[9px] font-bold text-zinc-600">
                            #{step.seq}
                          </span>
                          <span className="text-xs font-semibold text-zinc-200 capitalize">
                            {step.phase}
                          </span>
                        </div>
                        <StepStatusBadge status={step.status} />
                      </div>
                      {step.output && (
                        <p className="mt-2 line-clamp-2 rounded-lg bg-zinc-900/60 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-zinc-400">
                          {step.output}
                        </p>
                      )}
                      {step.status === 'error' && step.input && (
                        <p className="mt-2 line-clamp-2 rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-rose-400">
                          {step.input}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
