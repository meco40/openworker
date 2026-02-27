'use client';

import { useMemo } from 'react';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';
import { SwarmTaskCard } from './SwarmTaskCard';

interface AgentRoomEntryPageProps {
  swarms: SwarmRecord[];
  selectedSwarmId: string | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  onCreateClick: () => void;
  onOpenSwarm: (swarmId: string) => void;
  onDeleteSwarm: (swarmId: string) => void;
}

interface SwarmSection {
  key: 'running_hold' | 'idle' | 'completed' | 'aborted_error';
  title: string;
  items: SwarmRecord[];
}

export function AgentRoomEntryPage({
  swarms,
  selectedSwarmId,
  loading,
  error,
  notice,
  onCreateClick,
  onOpenSwarm,
  onDeleteSwarm,
}: AgentRoomEntryPageProps) {
  const sections = useMemo<SwarmSection[]>(
    () => [
      {
        key: 'running_hold',
        title: 'Running / Hold',
        items: swarms.filter((swarm) => swarm.status === 'running' || swarm.status === 'hold'),
      },
      {
        key: 'idle',
        title: 'Idle',
        items: swarms.filter((swarm) => swarm.status === 'idle'),
      },
      {
        key: 'completed',
        title: 'Completed',
        items: swarms.filter((swarm) => swarm.status === 'completed'),
      },
      {
        key: 'aborted_error',
        title: 'Aborted / Error',
        items: swarms.filter((swarm) => swarm.status === 'aborted' || swarm.status === 'error'),
      },
    ],
    [swarms],
  );

  return (
    <div className="flex h-full min-h-160 flex-col gap-4">
      <section className="rounded-xl border border-zinc-800 bg-[#060d20] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-2xl font-bold tracking-tight text-white">Agent Team</h2>
              <span className="rounded-full bg-cyan-500/20 px-2 py-0.5 text-xs font-semibold text-cyan-200">
                {swarms.length} Tasks
              </span>
            </div>
            <p className="mt-1 text-sm text-zinc-400">
              Create tasks and let your agent team collaborate on solutions.
            </p>
          </div>
          <button
            type="button"
            onClick={onCreateClick}
            className="rounded-lg border border-cyan-500/50 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/30"
          >
            + New Task
          </button>
        </div>
      </section>

      {loading && <p className="text-xs text-zinc-500">Loading tasks...</p>}
      {notice && <p className="text-xs text-amber-300">{notice}</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}

      <div className="space-y-5">
        {sections.map((section) => (
          <section key={section.key}>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-semibold tracking-wide text-zinc-300 uppercase">
                {section.title}
              </h3>
              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-semibold text-zinc-400">
                {section.items.length}
              </span>
            </div>

            {section.items.length > 0 ? (
              <div className="grid gap-3 xl:grid-cols-2">
                {section.items.map((swarm) => (
                  <SwarmTaskCard
                    key={swarm.id}
                    swarm={swarm}
                    selected={selectedSwarmId === swarm.id}
                    onOpen={onOpenSwarm}
                    onDelete={onDeleteSwarm}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-800 bg-[#040916] p-4 text-sm text-zinc-500">
                No tasks in this section yet.
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
