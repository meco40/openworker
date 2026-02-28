'use client';

import { useMemo } from 'react';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';
import { SwarmTaskCard } from './SwarmTaskCard';

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Empty section placeholder ────────────────────────────────────────────────

const EmptySectionPlaceholder: React.FC = () => (
  <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-5 py-4 text-sm text-zinc-600">
    No tasks in this section yet.
  </div>
);

// ─── Loading state ────────────────────────────────────────────────────────────

const LoadingIndicator: React.FC = () => (
  <div className="flex items-center gap-2 py-2 text-xs text-zinc-500">
    <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
    Loading tasks…
  </div>
);

// ─── AgentRoomEntryPage ───────────────────────────────────────────────────────

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

  const activeCount = sections[0].items.length;

  return (
    <div className="animate-in fade-in flex h-full min-h-160 flex-col gap-5 duration-300">
      {/* ── Hero header (Model Hub style) ── */}
      <section className="group relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900/40 p-7 shadow-2xl">
        {/* Ambient glow */}
        <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-cyan-600/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-indigo-600/8 blur-3xl" />

        <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <h2 className="text-3xl font-black tracking-tight text-white uppercase">
                Agent Team
              </h2>
              {/* Task count chip */}
              <div className="flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-2 py-1">
                <span
                  className={`h-2 w-2 rounded-full ${activeCount > 0 ? 'animate-pulse bg-emerald-500' : 'bg-zinc-600'}`}
                  aria-hidden="true"
                />
                <span className="font-mono text-[10px] text-zinc-400">
                  {activeCount > 0 ? `${activeCount} ACTIVE` : `${swarms.length} TASKS`}
                </span>
              </div>
            </div>
            <p className="max-w-lg text-sm leading-relaxed text-zinc-500">
              Create tasks and let your agent team collaborate on solutions. Each swarm runs
              autonomously through structured phases.
            </p>
          </div>

          <button
            type="button"
            onClick={onCreateClick}
            className="rounded-2xl bg-indigo-600 px-6 py-3.5 text-[10px] font-black tracking-widest text-white uppercase shadow-2xl shadow-indigo-600/30 transition-all hover:bg-indigo-500 active:scale-95"
          >
            + New Task
          </button>
        </div>
      </section>

      {/* ── Status messages ── */}
      {loading && <LoadingIndicator />}
      {notice && (
        <div className="flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <svg
            className="h-4 w-4 shrink-0 text-amber-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-xs font-medium text-amber-300">{notice}</p>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-2xl border border-rose-500/20 bg-rose-500/5 px-4 py-3">
          <svg
            className="h-4 w-4 shrink-0 text-rose-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
            />
          </svg>
          <p className="text-xs font-medium text-rose-400">{error}</p>
        </div>
      )}

      {/* ── Sections ── */}
      <div className="space-y-7 pb-8">
        {sections.map((section) => (
          <section key={section.key} aria-label={section.title}>
            {/* Section header */}
            <div className="mb-3 flex items-center gap-2.5">
              <h3 className="text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                {section.title}
              </h3>
              <span className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">
                {section.items.length}
              </span>
              {section.key === 'running_hold' && section.items.length > 0 && (
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"
                  aria-hidden="true"
                />
              )}
            </div>

            {/* Section content */}
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
              <EmptySectionPlaceholder />
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
