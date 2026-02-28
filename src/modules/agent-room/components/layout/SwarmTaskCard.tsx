'use client';

import type { SwarmRecord, SwarmStatus } from '@/modules/agent-room/swarmTypes';
import { getSwarmPhaseLabel } from '@/modules/agent-room/swarmPhases';

// ─── Status helpers ───────────────────────────────────────────────────────────

interface StatusConfig {
  dotClass: string;
  badgeClass: string;
  pulse: boolean;
  label: string;
}

function getStatusConfig(status: SwarmStatus): StatusConfig {
  switch (status) {
    case 'running':
      return {
        dotClass: 'bg-emerald-400',
        badgeClass: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200',
        pulse: true,
        label: 'Running',
      };
    case 'hold':
      return {
        dotClass: 'bg-amber-400',
        badgeClass: 'border-amber-500/30 bg-amber-500/15 text-amber-200',
        pulse: false,
        label: 'Hold',
      };
    case 'completed':
      return {
        dotClass: 'bg-indigo-400',
        badgeClass: 'border-indigo-500/30 bg-indigo-500/15 text-indigo-200',
        pulse: false,
        label: 'Completed',
      };
    case 'error':
      return {
        dotClass: 'bg-rose-400',
        badgeClass: 'border-rose-500/30 bg-rose-500/15 text-rose-200',
        pulse: false,
        label: 'Error',
      };
    case 'aborted':
      return {
        dotClass: 'bg-zinc-500',
        badgeClass: 'border-zinc-600 bg-zinc-700/20 text-zinc-300',
        pulse: false,
        label: 'Aborted',
      };
    default:
      return {
        dotClass: 'bg-cyan-400',
        badgeClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200',
        pulse: false,
        label: 'Idle',
      };
  }
}

function canDelete(status: SwarmStatus): boolean {
  return status !== 'running' && status !== 'hold';
}

// ─── SwarmTaskCard ────────────────────────────────────────────────────────────

export interface SwarmTaskCardProps {
  swarm: SwarmRecord;
  selected: boolean;
  onOpen: (swarmId: string) => void;
  onDelete: (swarmId: string) => void;
}

export function SwarmTaskCard({ swarm, selected, onOpen, onDelete }: SwarmTaskCardProps) {
  const cfg = getStatusConfig(swarm.status);
  const deletable = canDelete(swarm.status);
  const isActive = swarm.status === 'running' || swarm.status === 'hold';

  const formattedDate = new Date(swarm.updatedAt).toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <article
      className={`group relative flex flex-col gap-3 overflow-hidden rounded-3xl border p-5 transition-all duration-200 ${
        selected
          ? 'border-cyan-500/60 bg-cyan-500/10 shadow-lg shadow-cyan-950/20'
          : isActive
            ? 'border-emerald-500/25 bg-zinc-900/40 shadow-lg shadow-emerald-950/10 hover:border-emerald-500/40 hover:bg-zinc-900/60'
            : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/60'
      }`}
    >
      {/* Ambient glow for active tasks */}
      {isActive && (
        <div className="pointer-events-none absolute -top-8 -right-8 h-24 w-24 rounded-full bg-emerald-500/8 blur-2xl" />
      )}

      {/* ── Header row ── */}
      <div className="relative z-10 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* Status dot */}
          <span
            className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${cfg.dotClass} ${cfg.pulse ? 'animate-pulse' : ''}`}
            aria-hidden="true"
          />
          {/* Title */}
          <h3 className="truncate text-base leading-snug font-bold text-white">{swarm.title}</h3>
        </div>

        {/* Status badge */}
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] font-black tracking-widest uppercase ${cfg.badgeClass}`}
        >
          {cfg.label}
        </span>
      </div>

      {/* ── Task description ── */}
      <p className="relative z-10 line-clamp-2 text-sm leading-relaxed text-zinc-400">
        {swarm.task}
      </p>

      {/* ── Meta chips ── */}
      <div className="relative z-10 flex flex-wrap items-center gap-2">
        <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[9px] text-zinc-400">
          {getSwarmPhaseLabel(swarm.currentPhase)}
        </span>
        <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[9px] text-zinc-500">
          {swarm.units.length} agent{swarm.units.length !== 1 ? 's' : ''}
        </span>
        <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[9px] text-zinc-500">
          Turn {swarm.lastSeq}
        </span>
      </div>

      {/* ── Footer row ── */}
      <div className="relative z-10 flex items-center justify-between gap-2 border-t border-zinc-800/60 pt-2">
        <span className="font-mono text-[9px] text-zinc-600">{formattedDate}</span>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onOpen(swarm.id)}
            className="rounded-xl bg-indigo-600 px-3 py-1.5 text-[10px] font-black tracking-widest text-white uppercase shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 active:scale-95"
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => onDelete(swarm.id)}
            disabled={!deletable}
            title={!deletable ? 'Stop this task before deleting.' : 'Delete task'}
            className="rounded-xl border border-rose-500/40 px-3 py-1.5 text-[10px] font-black tracking-widest text-rose-300 uppercase transition-all hover:border-rose-500/60 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-500"
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  );
}
