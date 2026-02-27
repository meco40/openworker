'use client';

import type { SwarmRecord, SwarmStatus } from '@/modules/agent-room/swarmTypes';
import { getSwarmPhaseLabel } from '@/modules/agent-room/swarmPhases';

interface SwarmTaskCardProps {
  swarm: SwarmRecord;
  selected: boolean;
  onOpen: (swarmId: string) => void;
  onDelete: (swarmId: string) => void;
}

function statusClasses(status: SwarmStatus): string {
  switch (status) {
    case 'running':
      return 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200';
    case 'hold':
      return 'border-amber-500/30 bg-amber-500/15 text-amber-200';
    case 'completed':
      return 'border-indigo-500/30 bg-indigo-500/15 text-indigo-200';
    case 'error':
      return 'border-rose-500/30 bg-rose-500/15 text-rose-200';
    case 'aborted':
      return 'border-zinc-600 bg-zinc-700/20 text-zinc-300';
    default:
      return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200';
  }
}

function canDelete(status: SwarmStatus): boolean {
  return status !== 'running' && status !== 'hold';
}

export function SwarmTaskCard({ swarm, selected, onOpen, onDelete }: SwarmTaskCardProps) {
  const deletable = canDelete(swarm.status);
  return (
    <article
      className={`rounded-xl border p-4 transition-colors ${
        selected
          ? 'border-cyan-500/60 bg-cyan-500/10'
          : 'border-zinc-800 bg-[#060d20] hover:border-zinc-700'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="truncate text-lg font-semibold text-white">{swarm.title}</h3>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${statusClasses(
            swarm.status,
          )}`}
        >
          {swarm.status}
        </span>
      </div>

      <p className="mt-2 line-clamp-2 text-sm text-zinc-300">{swarm.task}</p>

      <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-zinc-500">
        <span>{getSwarmPhaseLabel(swarm.currentPhase)}</span>
        <span>{swarm.units.length} agents</span>
        <span>{swarm.lastSeq} turns</span>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs text-zinc-500">
          {new Date(swarm.updatedAt).toLocaleString([], {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onOpen(swarm.id)}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-800"
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => onDelete(swarm.id)}
            disabled={!deletable}
            title={!deletable ? 'Stop this task before deleting.' : 'Delete task'}
            className="rounded border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-500"
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  );
}
