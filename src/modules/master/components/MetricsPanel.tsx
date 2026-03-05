import React from 'react';
import type { MasterMetrics } from '@/modules/master/types';

interface KpiCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent?: string;
}

function KpiCard({
  label,
  value,
  icon,
  accent = 'text-indigo-400 bg-indigo-500/10',
}: KpiCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-4 transition-colors hover:border-zinc-700/80">
      <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${accent}`}>{icon}</div>
      <div>
        <div className="font-mono text-2xl font-black text-white tabular-nums">{value}</div>
        <div className="mt-0.5 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
          {label}
        </div>
      </div>
    </div>
  );
}

function formatRate(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  return `${Math.round(value * 100)}%`;
}

interface MetricsPanelProps {
  metrics: MasterMetrics | null;
}

export const MetricsPanel: React.FC<MetricsPanelProps> = ({ metrics }) => {
  if (!metrics) {
    return (
      <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
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
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
            </div>
            <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
              Metrics
            </h3>
          </div>
        </div>
        <div className="p-6">
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-8 text-center">
            <svg
              className="mx-auto mb-3 h-8 w-8 text-zinc-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            <p className="text-sm text-zinc-600">Run Master once to populate metrics</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/15">
              <svg
                className="h-3.5 w-3.5 text-violet-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
            </div>
            <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
              Metrics
            </h3>
          </div>
          {metrics?.generated_at && (
            <span className="font-mono text-[9px] text-zinc-600">
              {new Date(metrics.generated_at).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <KpiCard
          label="Completion"
          value={formatRate(metrics?.run_completion_rate)}
          accent="text-emerald-400 bg-emerald-500/10"
          icon={
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        />
        <KpiCard
          label="Verify Pass"
          value={formatRate(metrics?.verify_pass_rate)}
          accent="text-indigo-400 bg-indigo-500/10"
          icon={
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
              />
            </svg>
          }
        />
        <KpiCard
          label="Delegation"
          value={formatRate(metrics?.delegation_success_rate)}
          accent="text-sky-400 bg-sky-500/10"
          icon={
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
              />
            </svg>
          }
        />
      </div>
    </section>
  );
};
