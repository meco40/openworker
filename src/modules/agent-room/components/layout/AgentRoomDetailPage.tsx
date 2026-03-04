'use client';

import {
  SWARM_PHASES,
  getPhaseRounds,
  getSwarmPhaseLabel,
  type SwarmPhase,
} from '@/shared/domain/swarmPhases';
import type { SwarmRecord, SwarmStatus } from '@/modules/agent-room/swarmTypes';
import type { SwarmMessage } from '@/modules/agent-room/hooks/useSwarmMessages';
import type { PersonaSummary } from '@/server/personas/personaTypes';
import { SwarmChatFeed } from '@/modules/agent-room/components/SwarmChatFeed';
import { UserChatInput } from '@/modules/agent-room/components/UserChatInput';
import { CanvasPanel } from '@/modules/agent-room/components/canvas/CanvasPanel';

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Status badge ─────────────────────────────────────────────────────────────

function statusBadgeClasses(status: SwarmStatus): string {
  switch (status) {
    case 'running':
      return 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30';
    case 'hold':
      return 'bg-amber-500/20 text-amber-200 border-amber-500/30';
    case 'completed':
      return 'bg-indigo-500/20 text-indigo-200 border-indigo-500/30';
    case 'aborted':
      return 'bg-zinc-700/40 text-zinc-200 border-zinc-600';
    case 'error':
      return 'bg-rose-500/20 text-rose-200 border-rose-500/30';
    default:
      return 'bg-cyan-500/20 text-cyan-200 border-cyan-500/30';
  }
}

// ─── Phase progress ───────────────────────────────────────────────────────────

interface PhaseProgressProps {
  currentPhase: SwarmPhase;
}

const PhaseProgress: React.FC<PhaseProgressProps> = ({ currentPhase }) => {
  const currentIdx = SWARM_PHASES.indexOf(currentPhase);

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="list" aria-label="Phase progress">
      {SWARM_PHASES.map((phase, idx) => {
        const active = currentPhase === phase;
        const done = idx < currentIdx;
        return (
          <span
            key={phase}
            role="listitem"
            className={`rounded border px-2 py-0.5 font-mono text-[9px] font-black tracking-widest uppercase transition-colors ${
              active
                ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-200'
                : done
                  ? 'border-indigo-500/20 bg-indigo-500/10 text-indigo-400'
                  : 'border-zinc-800 bg-zinc-950 text-zinc-600'
            }`}
          >
            {getSwarmPhaseLabel(phase)}
          </span>
        );
      })}
    </div>
  );
};

// ─── Detail header ────────────────────────────────────────────────────────────

interface DetailHeaderProps {
  swarm: SwarmRecord;
  onBack: () => void;
  onExportMarkdown: (swarmId: string) => void;
  onPause: (swarmId: string) => void;
  onStop: (swarmId: string) => void;
  onFinish: (swarmId: string) => void;
}

const DetailHeader: React.FC<DetailHeaderProps> = ({
  swarm,
  onBack,
  onExportMarkdown,
  onPause,
  onStop,
  onFinish,
}) => {
  const currentPhase = swarm.currentPhase as SwarmPhase;
  const isRunning = swarm.status === 'running';
  const isHold = swarm.status === 'hold';
  const isActive = isRunning || isHold;
  const isFinished =
    swarm.status === 'completed' || swarm.status === 'aborted' || swarm.status === 'error';

  return (
    <header className="relative shrink-0 overflow-hidden border-b border-zinc-800/60 bg-zinc-900/60 px-5 py-4 backdrop-blur-sm">
      {/* Ambient glow for running tasks */}
      {isRunning && (
        <div className="pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full bg-emerald-500/8 blur-3xl" />
      )}

      {/* ── Top row: back + title + status + export ── */}
      <div className="relative z-10 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {/* Back button */}
          <button
            type="button"
            onClick={onBack}
            className="flex shrink-0 items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-[9px] font-black tracking-widest text-zinc-300 uppercase transition-all hover:border-zinc-600 hover:bg-zinc-800 hover:text-white active:scale-95"
            aria-label="Back to task list"
          >
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            Back
          </button>

          {/* Title */}
          <h2 className="truncate text-lg font-black tracking-tight text-white">{swarm.title}</h2>

          {/* Status badge */}
          <span
            className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[9px] font-black tracking-widest uppercase ${statusBadgeClasses(swarm.status)}`}
          >
            {swarm.status}
          </span>
        </div>

        {/* Export button */}
        <button
          type="button"
          onClick={() => onExportMarkdown(swarm.id)}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-[9px] font-black tracking-widest text-zinc-300 uppercase transition-all hover:border-zinc-600 hover:bg-zinc-800 hover:text-white active:scale-95"
          aria-label="Export as Markdown"
        >
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          Export MD
        </button>
      </div>

      {/* ── Task description ── */}
      <p className="relative z-10 mt-1.5 truncate text-sm text-zinc-400">{swarm.task}</p>

      {/* ── Action buttons ── */}
      <div className="relative z-10 mt-3 flex flex-wrap gap-2">
        {/* Pause / Resume */}
        <button
          type="button"
          onClick={() => onPause(swarm.id)}
          disabled={!isActive}
          className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-mono text-[9px] font-black tracking-widest uppercase transition-all active:scale-95 ${
            isActive
              ? 'border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:border-amber-500/60 hover:bg-amber-500/20'
              : 'cursor-not-allowed border border-zinc-700 bg-transparent text-zinc-500'
          }`}
          aria-label={isHold ? 'Resume task' : 'Pause task'}
        >
          {isHold ? (
            <>
              <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
              Resume
            </>
          ) : (
            <>
              <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
              Pause
            </>
          )}
        </button>

        {/* Stop */}
        <button
          type="button"
          onClick={() => onStop(swarm.id)}
          disabled={isFinished}
          className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-mono text-[9px] font-black tracking-widest uppercase transition-all active:scale-95 ${
            !isFinished
              ? 'border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:border-rose-500/60 hover:bg-rose-500/20'
              : 'cursor-not-allowed border border-zinc-700 bg-transparent text-zinc-500'
          }`}
          aria-label="Stop task"
        >
          <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
          Stop
        </button>

        {/* Finish */}
        <button
          type="button"
          onClick={() => onFinish(swarm.id)}
          disabled={isFinished}
          className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 font-mono text-[9px] font-black tracking-widest uppercase transition-all active:scale-95 ${
            !isFinished
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500'
              : 'cursor-not-allowed border border-zinc-700 bg-transparent text-zinc-500'
          }`}
          aria-label="Finish task"
        >
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M5 13l4 4L19 7"
            />
          </svg>
          Finish
        </button>
      </div>

      {/* ── Phase progress ── */}
      <div className="relative z-10 mt-3">
        <PhaseProgress currentPhase={currentPhase} />
      </div>

      {/* ── Turn info ── */}
      <div className="relative z-10 mt-2 flex flex-wrap items-center gap-3">
        <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[9px] text-zinc-400">
          Phase: {getSwarmPhaseLabel(currentPhase)}
        </span>
        <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[9px] text-zinc-500">
          Turn {swarm.lastSeq}
        </span>
        <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[9px] text-zinc-600">
          {getPhaseRounds(currentPhase) * swarm.units.length} turns/phase
        </span>
      </div>
    </header>
  );
};

// ─── AgentRoomDetailPage ──────────────────────────────────────────────────────

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
      <section className="rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-[9px] font-black tracking-widest text-zinc-300 uppercase transition-all hover:border-zinc-600 hover:bg-zinc-800 hover:text-white active:scale-95"
        >
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.5}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Back
        </button>
        <p className="mt-4 text-sm text-zinc-400">Task not found.</p>
      </section>
    );
  }

  const inputDisabled = swarm.status === 'completed' || swarm.status === 'aborted';

  return (
    <div className="animate-in fade-in flex h-full min-h-160 flex-col gap-3 duration-200 xl:flex-row">
      {/* ── Main chat section ── */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900/40">
        {/* Header */}
        <DetailHeader
          swarm={swarm}
          onBack={onBack}
          onExportMarkdown={onExportMarkdown}
          onPause={onPause}
          onStop={onStop}
          onFinish={onFinish}
        />

        {/* Error banner */}
        {error && (
          <div className="flex shrink-0 items-center gap-2 border-b border-rose-500/20 bg-rose-500/5 px-5 py-2.5">
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

        {/* Chat feed */}
        <SwarmChatFeed messages={messages} className="min-h-0 flex-1" />

        {/* Input */}
        <div className="shrink-0 border-t border-zinc-800/60 p-3">
          <UserChatInput onSend={onSendMessage} personas={swarmPersonas} disabled={inputDisabled} />
        </div>
      </section>

      {/* ── Canvas panel ── */}
      <CanvasPanel swarm={swarm} />
    </div>
  );
}
