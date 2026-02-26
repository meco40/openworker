'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePersona } from '@/modules/personas/PersonaContext';
import {
  SWARM_PHASES,
  getSwarmPhaseLabel,
  type SwarmPhase,
  type ResolvedSwarmUnit,
} from '@/modules/agent-room/swarmPhases';
import { parseAgentTurns } from '@/modules/agent-room/agentTurnParser';
import { extractCommandCompletionText } from '@/modules/agent-room/completionText';
import { useAgentRoomRuntime } from '@/modules/agent-room/hooks/useAgentRoomRuntime';
import { useSwarmMessages } from '@/modules/agent-room/hooks/useSwarmMessages';
import LogicGraphPanel from '@/modules/agent-room/components/LogicGraphPanel';
import { SwarmChatFeed } from '@/modules/agent-room/components/SwarmChatFeed';
import { UserChatInput } from '@/modules/agent-room/components/UserChatInput';
import NewSwarmModal from '@/modules/agent-room/components/NewSwarmModal';

type CanvasTab = 'logic_graph' | 'artifact' | 'history' | 'conflict';

function canvasTabLabel(tab: CanvasTab): string {
  switch (tab) {
    case 'logic_graph':
      return 'Logic Graph';
    case 'artifact':
      return 'Artifact';
    case 'history':
      return 'History';
    case 'conflict':
      return 'Conflicts';
  }
}

export default function AgentRoomView() {
  const { personas } = usePersona();
  const runtime = useAgentRoomRuntime();
  const swarmMessages = useSwarmMessages();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [canvasTab, setCanvasTab] = useState<CanvasTab>('logic_graph');
  const [canvasOpen, setCanvasOpen] = useState(true);
  /**
   * Tracks which phase has already received a divider in the current swarm view.
   * Prevents duplicate phase-divider messages when multiple agents run per phase.
   * Key: swarmId, Value: last phase for which a divider was added.
   */
  const lastDividerPhaseRef = useRef<Map<string, SwarmPhase | null>>(new Map());

  // Wire the runtime event dispatcher to the message hook.
  // Intercept agent.v2.command.started to open a streaming turn and insert a
  // phase divider before the first delta arrives — without this the chat feed
  // stays empty because appendToken/finalizeAgentTurn require a prior startAgentTurn.
  //
  // Uses runtime.lookupSwarmBySessionId (ref-based) instead of runtime.swarms
  // (React state) to avoid the race: the React re-render with the new sessionId
  // may not have flushed yet when command.started arrives from the WS.
  useEffect(() => {
    runtime.onAgentEventRef.current = (event) => {
      if (event.type === 'agent.v2.command.started' && event.commandId) {
        const swarm = runtime.lookupSwarmBySessionId(event.sessionId);
        if (swarm) {
          const commandInfo = runtime.getCommandInfo(event.commandId);
          const phase = (commandInfo?.phase as SwarmPhase) || (swarm.currentPhase as SwarmPhase);
          const speakerPersonaId = commandInfo?.personaId || swarm.leadPersonaId;
          const speakerPersona = personas.find((p) => p.id === speakerPersonaId);
          const lastDividerPhase = lastDividerPhaseRef.current.get(swarm.id) || null;
          if (lastDividerPhase !== phase) {
            swarmMessages.addPhaseDivider(phase);
            lastDividerPhaseRef.current.set(swarm.id, phase);
          }
          swarmMessages.startAgentTurn({
            commandId: event.commandId,
            personaId: speakerPersonaId,
            personaName: speakerPersona?.name ?? 'Agent',
            personaEmoji: speakerPersona?.emoji ?? '🤖',
            phase,
          });
        }
      }
      if (event.type === 'agent.v2.command.completed' && event.commandId) {
        const swarm = runtime.lookupSwarmBySessionId(event.sessionId);
        if (swarm) {
          const streamingText = swarmMessages.getStreamingContent(event.commandId);
          if (streamingText !== null) {
            const commandInfo = runtime.getCommandInfo(event.commandId);
            const fallbackPersonaId = commandInfo?.personaId || swarm.leadPersonaId;
            const completionText = extractCommandCompletionText(event);
            const rawText = streamingText.trim() ? streamingText : completionText;
            const resolvedUnits: ResolvedSwarmUnit[] = swarm.units.map((unit) => {
              const persona = personas.find((p) => p.id === unit.personaId);
              return {
                personaId: unit.personaId,
                role: unit.role,
                name: persona?.name ?? 'Agent',
                emoji: persona?.emoji ?? '\uD83E\uDD16',
              };
            });
            const parsedTurns = parseAgentTurns(rawText, resolvedUnits, fallbackPersonaId);
            swarmMessages.replaceStreamingWithTurns(event.commandId, parsedTurns);
            // Skip handleAgentEvent for completed commands — replaceStreamingWithTurns
            // already cleaned up the streaming entry. Calling finalizeAgentTurn again
            // would be a no-op but is fragile if ordering ever changes.
            return;
          }
        }
      }
      swarmMessages.handleAgentEvent(event);
    };
  });

  // Reset chat feed when the selected swarm changes.
  useEffect(() => {
    const swarm = runtime.selectedSwarm;
    if (!swarm) return;
    swarmMessages.resetForSwarm(swarm.id);
    // Reset phase divider tracking for this swarm
    lastDividerPhaseRef.current.delete(swarm.id);

    if (swarm.artifact) {
      const resolvedUnits: ResolvedSwarmUnit[] = swarm.units.map((unit) => {
        const persona = personas.find((p) => p.id === unit.personaId);
        return {
          personaId: unit.personaId,
          role: unit.role,
          name: persona?.name ?? 'Agent',
          emoji: persona?.emoji ?? '🤖',
        };
      });
      swarmMessages.hydrateFromArtifact(swarm.artifact, resolvedUnits, swarm.leadPersonaId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.selectedSwarmId]);

  const handleOperatorSend = useCallback(
    (content: string, mentionedPersonaId?: string) => {
      if (!runtime.selectedSwarm) return;
      let guidance = content;
      if (mentionedPersonaId) {
        const persona = personas.find((p) => p.id === mentionedPersonaId);
        if (persona) {
          guidance = `@${persona.name}: ${content}`;
        }
      }
      void runtime.steerSwarm(runtime.selectedSwarm.id, guidance);
      swarmMessages.addOperatorMessage(content);
    },
    [runtime, swarmMessages, personas],
  );

  const swarmPersonas = useMemo(() => {
    if (!runtime.selectedSwarm) return [];
    const unitIds = new Set(runtime.selectedSwarm.units.map((u) => u.personaId));
    return personas.filter((p) => unitIds.has(p.id));
  }, [personas, runtime.selectedSwarm]);

  if (!runtime.enabled) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="text-base font-semibold text-white">Agent Room disabled</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Set <code>NEXT_PUBLIC_AGENT_ROOM_ENABLED=true</code> to enable the Agent Room.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-160 gap-3">
      {/* ─── LEFT SIDEBAR ─────────────────────────────────────── */}
      <aside className="flex w-60 shrink-0 flex-col rounded-xl border border-zinc-800 bg-[#060d20] p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
            Agent Room
          </h2>
          {runtime.loading && <span className="text-[10px] text-zinc-500">loading…</span>}
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="mb-3 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs font-semibold tracking-wide text-cyan-100 transition-colors hover:bg-cyan-500/20"
        >
          + New Swarm
        </button>
        {/* Swarm list */}
        <div className="flex-1 space-y-1.5 overflow-auto">
          {runtime.swarms.map((swarm) => {
            const isSelected = runtime.selectedSwarmId === swarm.id;
            return (
              <button
                key={swarm.id}
                onClick={() => runtime.setSelectedSwarmId(swarm.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  isSelected
                    ? 'border-cyan-500/60 bg-cyan-500/10'
                    : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate text-xs font-semibold text-zinc-100">
                    {swarm.title}
                  </span>
                  <span
                    className={`ml-2 h-1.5 w-1.5 shrink-0 rounded-full ${
                      swarm.status === 'running'
                        ? 'animate-pulse bg-emerald-400'
                        : swarm.status === 'hold'
                          ? 'bg-amber-400'
                          : swarm.status === 'completed'
                            ? 'bg-indigo-400'
                            : swarm.status === 'error'
                              ? 'bg-rose-400'
                              : 'bg-zinc-600'
                    }`}
                  />
                </div>
                <div className="mt-0.5 truncate text-[10px] text-zinc-500">
                  {swarm.status.toUpperCase()} · {getSwarmPhaseLabel(swarm.currentPhase)}
                </div>
              </button>
            );
          })}
          {runtime.swarms.length === 0 && !runtime.loading && (
            <div className="rounded border border-dashed border-zinc-800 p-3 text-center text-xs text-zinc-500">
              No swarms yet. Create one above.
            </div>
          )}
        </div>

        {/* Selected swarm controls */}
        {runtime.selectedSwarm && (
          <div className="mt-3 space-y-1.5 border-t border-zinc-800 pt-3">
            <button
              disabled={runtime.deployState === 'deploying'}
              onClick={() =>
                runtime.selectedSwarm?.status === 'running'
                  ? void runtime.abortSwarm(runtime.selectedSwarm.id)
                  : void runtime.deploySwarm(runtime.selectedSwarm!.id)
              }
              className="w-full rounded border border-emerald-500/50 bg-emerald-500/10 px-2 py-1.5 text-[11px] font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {runtime.deployState === 'deploying'
                ? 'Deploying…'
                : runtime.selectedSwarm.status === 'running'
                  ? '■ Stop'
                  : runtime.selectedSwarm.status === 'hold'
                    ? '▶ Resume'
                    : '▶ Start'}
            </button>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={() => void runtime.forceNextPhase(runtime.selectedSwarm!.id)}
                className="rounded border border-indigo-500/40 px-2 py-1 text-[10px] text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-50"
              >
                Skip Phase
              </button>
              <button
                onClick={() => void runtime.abortSwarm(runtime.selectedSwarm!.id)}
                className="rounded border border-amber-500/40 px-2 py-1 text-[10px] text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
              >
                Abort
              </button>
              <button
                onClick={() => void runtime.forceComplete(runtime.selectedSwarm!.id)}
                className="rounded border border-violet-500/40 px-2 py-1 text-[10px] text-violet-300 hover:bg-violet-500/10 disabled:opacity-50"
              >
                Complete
              </button>
              <button
                onClick={() => {
                  if (!runtime.selectedSwarm) return;
                  const json = runtime.exportRunJson(runtime.selectedSwarm.id);
                  if (!json) return;
                  const blob = new Blob([json], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${runtime.selectedSwarm.title.replace(/\s+/g, '_').toLowerCase()}-run.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 hover:bg-zinc-800"
              >
                Export
              </button>
            </div>
            <button
              onClick={() => void runtime.deleteSwarm(runtime.selectedSwarm!.id)}
              className="w-full rounded border border-rose-500/30 px-2 py-1 text-[10px] text-rose-400 transition-colors hover:bg-rose-500/10"
            >
              Delete Swarm
            </button>
            {runtime.error && (
              <p className="mt-1 text-center text-[10px] text-rose-400">{runtime.error}</p>
            )}
          </div>
        )}
      </aside>

      {/* ─── CENTER: CHAT FEED ────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-[#050b19]">
        {/* Chat header */}
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <div className="min-w-0">
            {runtime.selectedSwarm ? (
              <>
                <h3 className="truncate text-sm font-semibold text-zinc-100">
                  {runtime.selectedSwarm.title}
                </h3>
                {/* Phase progress bar */}
                <div className="mt-1.5 flex items-center gap-1">
                  {SWARM_PHASES.map((phase) => {
                    const active = runtime.selectedSwarm?.currentPhase === phase;
                    const idx = SWARM_PHASES.indexOf(phase);
                    const currentIdx = SWARM_PHASES.indexOf(
                      runtime.selectedSwarm?.currentPhase ?? SWARM_PHASES[0],
                    );
                    return (
                      <div key={phase} className="flex items-center gap-1">
                        <div
                          className={`h-1 w-7 rounded-full transition-colors ${
                            active
                              ? 'bg-cyan-400'
                              : idx < currentIdx
                                ? 'bg-indigo-500/60'
                                : 'bg-zinc-700'
                          }`}
                          title={getSwarmPhaseLabel(phase)}
                        />
                      </div>
                    );
                  })}
                  <span className="ml-1 text-[10px] text-zinc-500">
                    {getSwarmPhaseLabel(runtime.selectedSwarm.currentPhase)}
                  </span>
                </div>
              </>
            ) : (
              <span className="text-sm text-zinc-500">Select a swarm</span>
            )}
          </div>
          <button
            onClick={() => setCanvasOpen((v) => !v)}
            className="ml-3 shrink-0 rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
            title={canvasOpen ? 'Hide canvas' : 'Show canvas'}
          >
            {canvasOpen ? '◀ Canvas' : '▶ Canvas'}
          </button>
        </div>

        {/* Chat feed */}
        <SwarmChatFeed messages={swarmMessages.messages} className="min-h-0 flex-1" />

        {/* Operator input */}
        <div className="shrink-0 border-t border-zinc-800 p-3">
          <UserChatInput
            onSend={handleOperatorSend}
            personas={swarmPersonas}
            disabled={
              !runtime.selectedSwarm ||
              runtime.selectedSwarm.status === 'completed' ||
              runtime.selectedSwarm.status === 'aborted'
            }
          />
        </div>
      </section>

      {/* ─── RIGHT: CANVAS PANEL ─────────────────────────────── */}
      {canvasOpen && (
        <aside className="flex min-w-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-[#060d20]">
          {/* Canvas tab bar */}
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 px-3 py-2">
            {(['logic_graph', 'artifact', 'history', 'conflict'] as CanvasTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setCanvasTab(tab)}
                className={`rounded px-2 py-1 text-[10px] whitespace-nowrap transition-colors ${
                  canvasTab === tab
                    ? 'bg-indigo-500/30 text-indigo-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {canvasTabLabel(tab)}
              </button>
            ))}
          </div>

          {/* Canvas content */}
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {canvasTab === 'logic_graph' && (
              <LogicGraphPanel
                artifact={runtime.selectedSwarm?.artifact || ''}
                currentPhase={runtime.selectedSwarm?.currentPhase as SwarmPhase | undefined}
                swarmStatus={runtime.selectedSwarm?.status}
              />
            )}
            {canvasTab === 'artifact' && (
              <pre className="text-[11px] leading-relaxed wrap-break-word whitespace-pre-wrap text-zinc-300">
                {runtime.selectedSwarm?.artifact || 'No artifact yet.'}
              </pre>
            )}
            {canvasTab === 'history' && (
              <div className="space-y-2">
                {(runtime.selectedSwarm?.artifactHistory ?? []).map((entry, i, arr) => {
                  // Show only the delta (new content) for each snapshot, not the
                  // full accumulated artifact which duplicates all previous turns.
                  const prev = i > 0 ? arr[i - 1] : '';
                  const delta = entry.startsWith(prev)
                    ? entry.slice(prev.length).trim()
                    : entry.trim();
                  // Extract the speaker name from the delta for the label
                  const speakerMatch = delta.match(/^\*\*\[([^\]]+)\]:\*\*/);
                  const label = speakerMatch
                    ? `Turn ${i + 1} — ${speakerMatch[1]}`
                    : `Turn ${i + 1}`;
                  return (
                    <details
                      key={`${i}-${entry.slice(0, 12)}`}
                      className="rounded border border-zinc-800 bg-zinc-950/40"
                      open={i >= arr.length - 3}
                    >
                      <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-semibold text-zinc-300 select-none hover:text-zinc-100">
                        {label}
                      </summary>
                      <div className="border-t border-zinc-800/50 px-2 py-1.5 text-[11px] whitespace-pre-wrap text-zinc-400">
                        {delta || '(empty)'}
                      </div>
                    </details>
                  );
                })}
                {!runtime.selectedSwarm?.artifactHistory?.length && (
                  <p className="pt-6 text-center text-xs text-zinc-600">No history yet.</p>
                )}
              </div>
            )}
            {canvasTab === 'conflict' && (
              <div className="space-y-2 text-xs text-zinc-400">
                <div className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/40 p-2">
                  <span>Friction Level</span>
                  <span
                    className={`font-semibold ${
                      runtime.selectedSwarm?.friction.level === 'high'
                        ? 'text-rose-400'
                        : runtime.selectedSwarm?.friction.level === 'medium'
                          ? 'text-amber-400'
                          : 'text-emerald-400'
                    }`}
                  >
                    {(runtime.selectedSwarm?.friction.level ?? 'low').toUpperCase()}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/40 p-2">
                  <span>Severity Score</span>
                  <span className="font-semibold text-zinc-200">
                    {runtime.selectedSwarm?.friction.confidence ?? 0}/100
                  </span>
                </div>
                {(runtime.selectedSwarm?.friction.reasons ?? []).length > 0 && (
                  <div className="rounded border border-zinc-800 bg-zinc-950/40 p-2">
                    <div className="mb-1.5 font-semibold text-zinc-300">Detected Signals</div>
                    <ul className="space-y-1.5">
                      {(runtime.selectedSwarm?.friction.reasons ?? []).map((reason, i) => (
                        <li
                          key={i}
                          className="rounded border border-zinc-800/50 bg-zinc-900/40 px-2 py-1 text-[11px] leading-relaxed text-zinc-400"
                        >
                          {reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(runtime.selectedSwarm?.friction.reasons ?? []).length === 0 && (
                  <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-center text-zinc-500">
                    No conflict signals detected in the current phase.
                  </div>
                )}
                {!runtime.selectedSwarm && (
                  <p className="pt-6 text-center text-zinc-600">No swarm selected.</p>
                )}
              </div>
            )}
          </div>
        </aside>
      )}

      <NewSwarmModal
        open={showCreateModal}
        personas={personas}
        creating={runtime.deployState === 'deploying'}
        onClose={() => setShowCreateModal(false)}
        onCreate={async (input) => {
          await runtime.createSwarm(input);
        }}
      />
    </div>
  );
}
