import React from 'react';
import type { MasterStep } from '@/modules/master/types';

// ─── Step status badge ────────────────────────────────────────────────────────

const STEP_STATUS_CLASSES: Record<MasterStep['status'], string> = {
  pending: 'bg-zinc-800 text-zinc-500',
  running: 'bg-emerald-500/15 text-emerald-300',
  done: 'bg-indigo-500/15 text-indigo-300',
  error: 'bg-rose-500/15 text-rose-300',
  blocked: 'bg-amber-500/15 text-amber-300',
};

function StepStatusBadge({ status }: { status: MasterStep['status'] }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wide uppercase ${STEP_STATUS_CLASSES[status]}`}
    >
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
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-3 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
        Run Steps
        <span className="ml-2 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] text-zinc-600">
          {steps.length}
        </span>
      </h3>

      {loading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-zinc-500">
          <svg
            className="h-3.5 w-3.5 animate-spin"
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
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-4 text-center text-xs text-zinc-600">
          No steps recorded yet.
        </div>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {steps.map((step) => (
            <div
              key={step.id}
              className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] text-zinc-600">#{step.seq}</span>
                  <span className="text-xs font-semibold text-zinc-300 capitalize">
                    {step.phase}
                  </span>
                </div>
                <StepStatusBadge status={step.status} />
              </div>
              {step.output && (
                <p className="line-clamp-2 font-mono text-[10px] text-zinc-500">{step.output}</p>
              )}
              {step.status === 'error' && step.input && (
                <p className="line-clamp-2 font-mono text-[10px] text-rose-400">{step.input}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
