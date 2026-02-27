'use client';

import React from 'react';
import type { CronMetrics } from '@/modules/cron/types';

function formatLeaseAge(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  return `${Math.floor(value / 3600)}h`;
}

interface MetricCardProps {
  label: string;
  value: string | number;
  icon: string;
  accent?: 'default' | 'emerald' | 'sky' | 'rose' | 'amber';
}

const ACCENT_CLASSES: Record<NonNullable<MetricCardProps['accent']>, string> = {
  default: 'text-zinc-400',
  emerald: 'text-emerald-400',
  sky: 'text-sky-400',
  rose: 'text-rose-400',
  amber: 'text-amber-400',
};

const MetricCard: React.FC<MetricCardProps> = ({ label, value, icon, accent = 'default' }) => {
  const accentClass = ACCENT_CLASSES[accent];
  return (
    <div className="relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 transition-all hover:border-zinc-700">
      <div className="absolute right-3 top-3 text-lg opacity-30">{icon}</div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{label}</div>
      <div className={`mt-2 text-2xl font-black ${accentClass}`}>{value}</div>
    </div>
  );
};

interface CronMetricsPanelProps {
  metrics: CronMetrics | null;
}

export const CronMetricsPanel: React.FC<CronMetricsPanelProps> = ({ metrics }) => {
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <MetricCard
        label="Active Rules"
        value={metrics?.activeRules ?? 0}
        icon="✅"
        accent={metrics && metrics.activeRules > 0 ? 'emerald' : 'default'}
      />
      <MetricCard
        label="Queued"
        value={metrics?.queuedRuns ?? 0}
        icon="⏳"
        accent={metrics && metrics.queuedRuns > 0 ? 'amber' : 'default'}
      />
      <MetricCard
        label="Running"
        value={metrics?.runningRuns ?? 0}
        icon="⚡"
        accent={metrics && metrics.runningRuns > 0 ? 'sky' : 'default'}
      />
      <MetricCard
        label="Dead Letter"
        value={metrics?.deadLetterRuns ?? 0}
        icon="💀"
        accent={metrics && metrics.deadLetterRuns > 0 ? 'rose' : 'default'}
      />
      <MetricCard
        label="Lease Age"
        value={formatLeaseAge(metrics?.leaseAgeSeconds)}
        icon="🔒"
        accent="default"
      />
    </section>
  );
};
