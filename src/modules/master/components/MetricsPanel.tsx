import React from 'react';
import type { MasterMetrics } from '@/modules/master/types';

interface KpiCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
}

function KpiCard({ label, value, icon }: KpiCardProps) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
            {label}
          </div>
          <div className="mt-1.5 text-xl font-bold text-white tabular-nums">{value}</div>
        </div>
        <div className="mt-0.5 text-zinc-600">{icon}</div>
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
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-4 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
        Metrics
      </h3>

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard
          label="Completion"
          value={formatRate(metrics?.run_completion_rate)}
          icon={
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        />
        <KpiCard
          label="Verify Pass"
          value={formatRate(metrics?.verify_pass_rate)}
          icon={
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
              />
            </svg>
          }
        />
        <KpiCard
          label="Delegation"
          value={formatRate(metrics?.delegation_success_rate)}
          icon={
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
              />
            </svg>
          }
        />
      </div>

      {metrics?.generated_at && (
        <p className="mt-3 font-mono text-[10px] text-zinc-600">
          Updated: {new Date(metrics.generated_at).toLocaleString()}
        </p>
      )}
    </section>
  );
};
