import React from 'react';
import type { CronRunStatus, CronRule } from '@/modules/cron/types';

// ─── Run Status Badge ────────────────────────────────────────────────────────

const RUN_STATUS_META: Record<CronRunStatus, { label: string; className: string; dot: string }> = {
  queued: {
    label: 'Queued',
    className: 'text-amber-300 bg-amber-900/30 border-amber-700/40',
    dot: 'bg-amber-400',
  },
  running: {
    label: 'Running',
    className: 'text-sky-300 bg-sky-900/30 border-sky-700/40',
    dot: 'bg-sky-400 animate-pulse',
  },
  succeeded: {
    label: 'Succeeded',
    className: 'text-emerald-300 bg-emerald-900/30 border-emerald-700/40',
    dot: 'bg-emerald-400',
  },
  failed: {
    label: 'Failed',
    className: 'text-rose-300 bg-rose-900/30 border-rose-700/40',
    dot: 'bg-rose-400',
  },
  dead_letter: {
    label: 'Dead Letter',
    className: 'text-red-300 bg-red-900/30 border-red-700/40',
    dot: 'bg-red-400',
  },
  skipped: {
    label: 'Skipped',
    className: 'text-zinc-400 bg-zinc-800/60 border-zinc-700/40',
    dot: 'bg-zinc-500',
  },
};

interface RunStatusBadgeProps {
  status: CronRunStatus;
}

export const RunStatusBadge: React.FC<RunStatusBadgeProps> = ({ status }) => {
  const meta = RUN_STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase ${meta.className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
};

// ─── Rule Status Badge ───────────────────────────────────────────────────────

interface RuleStatusBadgeProps {
  rule: CronRule;
}

export const RuleStatusBadge: React.FC<RuleStatusBadgeProps> = ({ rule }) => {
  if (!rule.enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-zinc-700/40 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-bold tracking-wider text-zinc-400 uppercase">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
        Paused
      </span>
    );
  }
  if (rule.consecutiveFailures > 0 || rule.lastError) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-amber-700/40 bg-amber-900/20 px-2 py-0.5 text-[10px] font-bold tracking-wider text-amber-300 uppercase">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Degraded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-emerald-700/40 bg-emerald-900/20 px-2 py-0.5 text-[10px] font-bold tracking-wider text-emerald-300 uppercase">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
      Active
    </span>
  );
};
