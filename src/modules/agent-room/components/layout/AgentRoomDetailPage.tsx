'use client';

import {
  SWARM_PHASES,
  getPhaseRounds,
  getSwarmPhaseLabel,
  type SwarmPhase,
} from '@/modules/agent-room/swarmPhases';
import type { SwarmRecord, SwarmStatus } from '@/modules/agent-room/swarmTypes';
import type { SwarmMessage } from '@/modules/agent-room/hooks/useSwarmMessages';
import type { PersonaSummary } from '@/server/personas/personaTypes';
import { SwarmChatFeed } from '@/modules/agent-room/components/SwarmChatFeed';
import { UserChatInput } from '@/modules/agent-room/components/UserChatInput';
import { CanvasPanel } from '@/modules/agent-room/components/canvas';

interface AgentRoomDetailPageProps {
  swarm: SwarmRecord | null;
  messages: SwarmMessage[];
  error: string | null;
  swarmPersonas: PersonaSummary[];
  onBack: () => void;
  onExportMarkdown: (swarmId: string) => void;
  onPause: (swarmId: string) => void;
  onStop: (swarmId: string) => void;
  onFinish: (swarmId: string) => void;
  onSendMessage: (content: string, mentionedPersonaId?: string) => void;
}

function statusBadgeClasses(status: SwarmStatus): string {
  switch (status) {
    case 'running':
      return 'bg-emerald-500/20 text-emerald-200';
    case 'hold':
      return 'bg-amber-500/20 text-amber-200';
    case 'completed':
      return 'bg-indigo-500/20 text-indigo-200';
    case 'aborted':
      return 'bg-zinc-700/40 text-zinc-200';
    case 'error':
      return 'bg-rose-500/20 text-rose-200';
    default:
      return 'bg-cyan-500/20 text-cyan-200';
  }
}

export function AgentRoomDetailPage({
  swarm,
  messages,
  error,
  swarmPersonas,
  onBack,
  onExportMarkdown,
  onPause,
  onStop,
  onFinish,
  onSendMessage,
}: AgentRoomDetailPageProps) {
  if (!swarm) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-[#060d20] p-5">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
        >
          {'<-'} Back
        </button>
        <p className="mt-4 text-sm text-zinc-400">Task not found.</p>
      </section>
    );
  }

  const currentPhase = swarm.currentPhase as SwarmPhase;
  const currentIdx = SWARM_PHASES.indexOf(currentPhase);
  const inputDisabled = swarm.status === 'completed' || swarm.status === 'aborted';

  return (
    <div className="flex h-full min-h-160 flex-col gap-3 xl:flex-row">
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-[#050b19]">
        <header className="shrink-0 border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onBack}
                  className="rounded border border-zinc-700 px-2 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
                >
                  {'<-'} Back
                </button>
                <h2 className="truncate text-2xl font-bold text-white">{swarm.title}</h2>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${statusBadgeClasses(
                    swarm.status,
                  )}`}
                >
                  {swarm.status}
                </span>
              </div>
              <p className="mt-1 truncate text-sm text-zinc-400">{swarm.task}</p>
            </div>
            <button
              type="button"
              onClick={() => onExportMarkdown(swarm.id)}
              className="shrink-0 rounded border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
            >
              Export MD
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onPause(swarm.id)}
              disabled={swarm.status !== 'running' && swarm.status !== 'hold'}
              className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-500"
            >
              {swarm.status === 'hold' ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              onClick={() => onStop(swarm.id)}
              disabled={
                swarm.status === 'completed' ||
                swarm.status === 'aborted' ||
                swarm.status === 'error'
              }
              className="rounded border border-rose-500/50 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-200 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-500"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={() => onFinish(swarm.id)}
              disabled={
                swarm.status === 'completed' ||
                swarm.status === 'aborted' ||
                swarm.status === 'error'
              }
              className="rounded border border-indigo-500/50 bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-200 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-500"
            >
              Finish
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {SWARM_PHASES.map((phase, idx) => {
              const active = currentPhase === phase;
              return (
                <span
                  key={phase}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    active
                      ? 'bg-emerald-500/25 text-emerald-200'
                      : idx < currentIdx
                        ? 'bg-indigo-500/25 text-indigo-200'
                        : 'bg-zinc-800 text-zinc-400'
                  }`}
                >
                  {getSwarmPhaseLabel(phase)}
                </span>
              );
            })}
          </div>

          <p className="mt-2 text-xs text-zinc-500">
            Current phase: {getSwarmPhaseLabel(currentPhase)} · Turn {swarm.lastSeq} ·{' '}
            {getPhaseRounds(currentPhase) * swarm.units.length} turns per phase
          </p>
          {error && <p className="mt-1 text-xs text-rose-400">{error}</p>}
        </header>

        <SwarmChatFeed messages={messages} className="min-h-0 flex-1" />
        <div className="shrink-0 border-t border-zinc-800 p-3">
          <UserChatInput onSend={onSendMessage} personas={swarmPersonas} disabled={inputDisabled} />
        </div>
      </section>

      <CanvasPanel swarm={swarm} />
    </div>
  );
}
