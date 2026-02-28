import React from 'react';
import type { MasterRunStatus } from '@/modules/master/types';

interface StatusConfig {
  label: string;
  className: string;
  pulse: boolean;
}

const STATUS_CONFIG: Record<MasterRunStatus, StatusConfig> = {
  IDLE: { label: 'Idle', className: 'bg-zinc-800 text-zinc-400 border-zinc-700', pulse: false },
  ANALYZING: {
    label: 'Analyzing',
    className: 'bg-sky-500/15 text-sky-200 border-sky-500/30',
    pulse: true,
  },
  PLANNING: {
    label: 'Planning',
    className: 'bg-violet-500/15 text-violet-200 border-violet-500/30',
    pulse: true,
  },
  DELEGATING: {
    label: 'Delegating',
    className: 'bg-cyan-500/15 text-cyan-200 border-cyan-500/30',
    pulse: true,
  },
  EXECUTING: {
    label: 'Executing',
    className: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
    pulse: true,
  },
  VERIFYING: {
    label: 'Verifying',
    className: 'bg-teal-500/15 text-teal-200 border-teal-500/30',
    pulse: true,
  },
  REFINING: {
    label: 'Refining',
    className: 'bg-blue-500/15 text-blue-200 border-blue-500/30',
    pulse: true,
  },
  AWAITING_APPROVAL: {
    label: 'Awaiting Approval',
    className: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
    pulse: true,
  },
  COMPLETED: {
    label: 'Completed',
    className: 'bg-indigo-500/15 text-indigo-200 border-indigo-500/30',
    pulse: false,
  },
  FAILED: {
    label: 'Failed',
    className: 'bg-rose-500/15 text-rose-200 border-rose-500/30',
    pulse: false,
  },
};

interface RunStatusBadgeProps {
  status: MasterRunStatus;
  size?: 'sm' | 'xs';
}

export const RunStatusBadge: React.FC<RunStatusBadgeProps> = ({ status, size = 'xs' }) => {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.IDLE;
  const textClass = size === 'sm' ? 'text-[11px]' : 'text-[9px]';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono font-semibold tracking-wide uppercase ${textClass} ${cfg.className}`}
    >
      {cfg.pulse && (
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-80"
          aria-hidden="true"
        />
      )}
      {cfg.label}
    </span>
  );
};
