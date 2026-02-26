'use client';

import {
  SWARM_PHASES,
  getSwarmPhaseLabel,
  getPhaseRounds,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';

interface ChatHeaderProps {
  swarm: SwarmRecord | null;
  onToggleCanvas: () => void;
  canvasOpen: boolean;
}

export function ChatHeader({ swarm, onToggleCanvas, canvasOpen }: ChatHeaderProps) {
  if (!swarm) {
    return (
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <span className="text-sm text-zinc-500">Select a swarm</span>
        <button
          onClick={onToggleCanvas}
          className="ml-3 shrink-0 rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
          title={canvasOpen ? 'Hide canvas' : 'Show canvas'}
        >
          {canvasOpen ? '◀ Canvas' : '▶ Canvas'}
        </button>
      </div>
    );
  }

  const currentIdx = SWARM_PHASES.indexOf(swarm.currentPhase as SwarmPhase);

  return (
    <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-2.5">
      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-zinc-100">{swarm.title}</h3>
        <div className="mt-1.5 flex items-center gap-1">
          {SWARM_PHASES.map((phase, idx) => {
            const active = swarm.currentPhase === phase;
            return (
              <div key={phase} className="flex items-center gap-1">
                <div
                  className={`h-1 w-7 rounded-full transition-colors ${
                    active ? 'bg-cyan-400' : idx < currentIdx ? 'bg-indigo-500/60' : 'bg-zinc-700'
                  }`}
                  title={getSwarmPhaseLabel(phase)}
                />
              </div>
            );
          })}
          <span className="ml-1 text-[10px] text-zinc-500">
            {getSwarmPhaseLabel(swarm.currentPhase as SwarmPhase)}
          </span>
          {swarm.status === 'running' && (
            <span className="ml-2 text-[10px] text-cyan-400/70 tabular-nums">
              Turn {swarm.lastSeq} ·{' '}
              {getPhaseRounds(swarm.currentPhase as SwarmPhase) * swarm.units.length} per phase
            </span>
          )}
        </div>
      </div>
      <button
        onClick={onToggleCanvas}
        className="ml-3 shrink-0 rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
        title={canvasOpen ? 'Hide canvas' : 'Show canvas'}
      >
        {canvasOpen ? '◀ Canvas' : '▶ Canvas'}
      </button>
    </div>
  );
}
