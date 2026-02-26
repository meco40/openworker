'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePersona } from '@/modules/personas/PersonaContext';
import type { SwarmPhase } from '@/modules/agent-room/swarmPhases';
import { parseAgentTurns } from '@/modules/agent-room/agentTurnParser';
import { extractCommandCompletionText } from '@/modules/agent-room/completionText';
import { useAgentRoomRuntime } from '@/modules/agent-room/hooks/useAgentRoomRuntime';
import { useSwarmMessages } from '@/modules/agent-room/hooks/useSwarmMessages';
import { SwarmSidebar } from './sidebar';
import { ChatHeader, SwarmChatFeed, UserChatInput } from './chat';
import { CanvasPanel } from './canvas';
import NewSwarmModal from './NewSwarmModal';

export default function AgentRoomView() {
  const { personas } = usePersona();
  const runtime = useAgentRoomRuntime();
  const swarmMessages = useSwarmMessages();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(true);
  const lastDividerPhaseRef = useRef<Map<string, SwarmPhase | null>>(new Map());

  // Wire runtime event dispatcher to message hook
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
            const resolvedUnits = swarm.units.map((unit) => {
              const persona = personas.find((p) => p.id === unit.personaId);
              return {
                personaId: unit.personaId,
                role: unit.role,
                name: persona?.name ?? 'Agent',
                emoji: persona?.emoji ?? '🤖',
              };
            });
            const parsedTurns = parseAgentTurns(rawText, resolvedUnits, fallbackPersonaId);
            swarmMessages.replaceStreamingWithTurns(event.commandId, parsedTurns);
            return;
          }
        }
      }
      swarmMessages.handleAgentEvent(event);
    };
  });

  // Reset chat feed when selected swarm changes
  const selectedSwarm = runtime.selectedSwarm;

  useEffect(() => {
    const swarm = selectedSwarm;
    if (!swarm) return;
    swarmMessages.resetForSwarm(swarm.id);
    lastDividerPhaseRef.current.delete(swarm.id);

    if (swarm.artifact) {
      const resolvedUnits = swarm.units.map((unit) => {
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
  }, [selectedSwarm, swarmMessages, personas]);

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

  const handleExport = useCallback(
    (swarmId: string) => {
      const json = runtime.exportRunJson(swarmId);
      if (!json) return;
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${runtime.selectedSwarm?.title.replace(/\s+/g, '_').toLowerCase()}-run.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [runtime],
  );

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
      <SwarmSidebar
        swarms={runtime.swarms}
        selectedSwarmId={runtime.selectedSwarmId}
        selectedSwarm={runtime.selectedSwarm}
        loading={runtime.loading}
        error={runtime.error}
        deployState={runtime.deployState}
        onSelectSwarm={runtime.setSelectedSwarmId}
        onCreateClick={() => setShowCreateModal(true)}
        onDeploy={runtime.deploySwarm}
        onAbort={runtime.abortSwarm}
        onForceNextPhase={runtime.forceNextPhase}
        onForceComplete={runtime.forceComplete}
        onDelete={runtime.deleteSwarm}
        onExport={handleExport}
      />

      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-[#050b19]">
        <ChatHeader
          swarm={runtime.selectedSwarm}
          onToggleCanvas={() => setCanvasOpen((v) => !v)}
          canvasOpen={canvasOpen}
        />
        <SwarmChatFeed messages={swarmMessages.messages} className="min-h-0 flex-1" />
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

      {canvasOpen && <CanvasPanel swarm={runtime.selectedSwarm} />}

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
