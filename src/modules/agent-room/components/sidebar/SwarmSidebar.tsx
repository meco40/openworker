'use client';

import React from 'react';
import type { SwarmRecord, SwarmStatus } from '@/modules/agent-room/swarmTypes';
import { getSwarmPhaseLabel } from '@/modules/agent-room/swarmPhases';

interface SwarmSidebarProps {
  swarms: SwarmRecord[];
  selectedSwarmId: string | null;
  selectedSwarm: SwarmRecord | null;
  loading: boolean;
  error: string | null;
  deployState: 'idle' | 'deploying';
  onSelectSwarm: (id: string) => void;
  onCreateClick: () => void;
  onDeploy: (swarmId: string) => void;
  onAbort: (swarmId: string) => void;
  onForceNextPhase: (swarmId: string) => void;
  onForceComplete: (swarmId: string) => void;
  onDelete: (swarmId: string) => void;
  onExport: (swarmId: string) => void;
  onExportMarkdown?: (swarmId: string) => void;
  onFork?: (swarmId: string) => void;
  onChain?: (swarmId: string) => void;
}

function StatusDot({ status }: { status: SwarmStatus }) {
  const colorClass =
    status === 'running'
      ? 'animate-pulse bg-emerald-400'
      : status === 'hold'
        ? 'bg-amber-400'
        : status === 'completed'
          ? 'bg-indigo-400'
          : status === 'error'
            ? 'bg-rose-400'
            : 'bg-zinc-600';
  return <span className={`ml-2 h-1.5 w-1.5 shrink-0 rounded-full ${colorClass}`} />;
}

export function SwarmSidebar({
  swarms,
  selectedSwarmId,
  selectedSwarm,
  loading,
  error,
  deployState,
  onSelectSwarm,
  onCreateClick,
  onDeploy,
  onAbort,
  onForceNextPhase,
  onForceComplete,
  onDelete,
  onExport,
  onExportMarkdown,
  onFork,
  onChain,
}: SwarmSidebarProps) {
  const [confirmAction, setConfirmAction] = React.useState<'delete' | 'abort' | null>(null);

  const handleConfirmedAction = React.useCallback(() => {
    if (!selectedSwarm) return;
    if (confirmAction === 'delete') onDelete(selectedSwarm.id);
    if (confirmAction === 'abort') onAbort(selectedSwarm.id);
    setConfirmAction(null);
  }, [confirmAction, selectedSwarm, onDelete, onAbort]);

  return (
    <aside className="flex w-60 shrink-0 flex-col rounded-xl border border-zinc-800 bg-[#060d20] p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
          Agent Room
        </h2>
        {loading && <span className="text-[10px] text-zinc-500">loading…</span>}
      </div>

      <button
        onClick={onCreateClick}
        className="mb-3 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs font-semibold tracking-wide text-cyan-100 transition-colors hover:bg-cyan-500/20"
      >
        + New Swarm
      </button>

      {/* Swarm list */}
      <div className="flex-1 space-y-1.5 overflow-auto">
        {swarms.map((swarm) => {
          const isSelected = selectedSwarmId === swarm.id;
          return (
            <button
              key={swarm.id}
              onClick={() => onSelectSwarm(swarm.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                isSelected
                  ? 'border-cyan-500/60 bg-cyan-500/10'
                  : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="truncate text-xs font-semibold text-zinc-100">{swarm.title}</span>
                <StatusDot status={swarm.status} />
              </div>
              <div className="mt-0.5 truncate text-[10px] text-zinc-500">
                {swarm.status.toUpperCase()} · {getSwarmPhaseLabel(swarm.currentPhase)}
              </div>
              <div className="mt-0.5 flex gap-2 text-[9px] text-zinc-600">
                <span>{swarm.units.length} agents</span>
                <span>·</span>
                <span>{swarm.lastSeq} turns</span>
                {swarm.consensusScore > 0 && (
                  <>
                    <span>·</span>
                    <span>{swarm.consensusScore}%</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
        {swarms.length === 0 && !loading && (
          <div className="rounded border border-dashed border-zinc-800 p-3 text-center text-xs text-zinc-500">
            No swarms yet. Create one above.
          </div>
        )}
      </div>

      {/* Selected swarm controls */}
      {selectedSwarm && (
        <div className="mt-3 space-y-1.5 border-t border-zinc-800 pt-3">
          <button
            disabled={deployState === 'deploying'}
            onClick={() =>
              selectedSwarm?.status === 'running'
                ? onAbort(selectedSwarm.id)
                : onDeploy(selectedSwarm.id)
            }
            className="w-full rounded border border-emerald-500/50 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {deployState === 'deploying'
              ? 'Deploying…'
              : selectedSwarm.status === 'running'
                ? '■ Stop'
                : selectedSwarm.status === 'hold'
                  ? '▶ Resume'
                  : '▶ Start'}
          </button>

          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => onForceNextPhase(selectedSwarm.id)}
              className="rounded border border-indigo-500/40 px-2 py-1 text-[10px] text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-50"
            >
              Skip Phase
            </button>
            <button
              onClick={() => setConfirmAction('abort')}
              className="rounded border border-amber-500/40 px-2 py-1 text-[10px] text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
            >
              Abort
            </button>
            <button
              onClick={() => onForceComplete(selectedSwarm.id)}
              className="rounded border border-violet-500/40 px-2 py-1 text-[10px] text-violet-300 hover:bg-violet-500/10 disabled:opacity-50"
            >
              Complete
            </button>
            <button
              onClick={() => onExport(selectedSwarm.id)}
              className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800"
            >
              JSON
            </button>
            {onExportMarkdown && (
              <button
                onClick={() => onExportMarkdown(selectedSwarm.id)}
                className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800"
              >
                MD
              </button>
            )}
            {onFork && (
              <button
                onClick={() => onFork(selectedSwarm.id)}
                className="rounded border border-teal-500/40 px-2 py-1 text-[10px] text-teal-300 hover:bg-teal-500/10"
                title="Fork this swarm to explore an alternative path"
              >
                Fork
              </button>
            )}
            {onChain && selectedSwarm.status === 'completed' && (
              <button
                onClick={() => onChain(selectedSwarm.id)}
                className="rounded border border-indigo-500/40 px-2 py-1 text-[10px] text-indigo-300 hover:bg-indigo-500/10"
                title="Chain a new swarm from this swarm's output"
              >
                Chain
              </button>
            )}
          </div>

          <button
            onClick={() => setConfirmAction('delete')}
            className="w-full rounded border border-rose-500/30 px-2 py-1 text-[10px] text-rose-400 transition-colors hover:bg-rose-500/10"
          >
            Delete Swarm
          </button>

          {confirmAction && (
            <div className="mt-1.5 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-center">
              <p className="mb-1.5 text-[10px] text-amber-200">
                {confirmAction === 'delete' ? 'Delete this swarm?' : 'Abort this swarm?'}
              </p>
              <div className="flex gap-1.5">
                <button
                  onClick={handleConfirmedAction}
                  className="flex-1 rounded border border-rose-500/50 bg-rose-500/20 px-2 py-1 text-[10px] font-semibold text-rose-200 hover:bg-rose-500/30"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setConfirmAction(null)}
                  className="flex-1 rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {error && <p className="mt-1 text-center text-[10px] text-rose-400">{error}</p>}
        </div>
      )}
    </aside>
  );
}
