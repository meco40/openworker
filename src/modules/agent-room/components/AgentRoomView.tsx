'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePersona } from '@/modules/personas/PersonaContext';
import type { SwarmPhase } from '@/shared/domain/swarmPhases';
import { parseAgentTurns } from '@/modules/agent-room/agentTurnParser';
import { extractCommandCompletionText } from '@/modules/agent-room/completionText';
import { useAgentRoomRuntime } from '@/modules/agent-room/hooks/useAgentRoomRuntime';
import { useSwarmMessages } from '@/modules/agent-room/hooks/useSwarmMessages';
import { useConfirmDialog } from '@/components/shared/ConfirmDialogProvider';
import { AgentRoomDetailPage, AgentRoomEntryPage } from './layout';
import NewSwarmModal from './NewSwarmModal';

export default function AgentRoomView() {
  const confirm = useConfirmDialog();
  const { personas } = usePersona();
  const runtime = useAgentRoomRuntime();
  const {
    messages: chatMessages,
    resetForSwarm,
    hydrateFromArtifact,
    addPhaseDivider,
    addOperatorMessage,
    startAgentTurn,
    handleAgentEvent: handleMessageEvent,
    getStreamingContent,
    replaceStreamingWithTurns,
  } = useSwarmMessages();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [pageMode, setPageMode] = useState<'entry' | 'detail'>('entry');
  const [notice, setNotice] = useState<string | null>(null);
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
            addPhaseDivider(phase);
            lastDividerPhaseRef.current.set(swarm.id, phase);
          }
          startAgentTurn({
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
          const streamingText = getStreamingContent(event.commandId);
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
            replaceStreamingWithTurns(event.commandId, parsedTurns);
            return;
          }
        }
      }
      handleMessageEvent(event);
    };
  }, [
    runtime,
    personas,
    addPhaseDivider,
    startAgentTurn,
    getStreamingContent,
    replaceStreamingWithTurns,
    handleMessageEvent,
  ]);

  // Reset chat feed when selected swarm changes
  const selectedSwarm = runtime.selectedSwarm;

  useEffect(() => {
    const swarm = selectedSwarm;
    if (!swarm) return;
    resetForSwarm(swarm.id);
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
      hydrateFromArtifact(swarm.artifact, resolvedUnits, swarm.leadPersonaId);
    }
  }, [selectedSwarm, resetForSwarm, hydrateFromArtifact, personas]);

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
      addOperatorMessage(content);
    },
    [runtime, addOperatorMessage, personas],
  );

  const swarmPersonas = useMemo(() => {
    if (!runtime.selectedSwarm) return [];
    const unitIds = new Set(runtime.selectedSwarm.units.map((u) => u.personaId));
    return personas.filter((p) => unitIds.has(p.id));
  }, [personas, runtime.selectedSwarm]);

  const handleExportMarkdown = useCallback(
    (swarmId: string) => {
      const md = runtime.exportRunMarkdown(swarmId);
      if (!md) return;
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const title = runtime.selectedSwarm?.title || 'swarm';
      a.download = `${title.replace(/\s+/g, '_').toLowerCase()}-run.md`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [runtime],
  );

  const handleOpenSwarm = useCallback(
    (swarmId: string) => {
      runtime.setSelectedSwarmId(swarmId);
      setPageMode('detail');
      setNotice(null);
    },
    [runtime],
  );

  const handleBackToEntry = useCallback(() => {
    setPageMode('entry');
  }, []);

  const handleDeleteSwarm = useCallback(
    async (swarmId: string) => {
      const swarm = runtime.swarms.find((item) => item.id === swarmId);
      if (!swarm) return;
      if (swarm.status === 'running' || swarm.status === 'hold') {
        return;
      }
      const shouldDelete = await confirm({
        title: 'Task löschen?',
        description: 'Delete this task permanently?',
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (!shouldDelete) return;
      void runtime.deleteSwarm(swarmId);
      if (runtime.selectedSwarmId === swarmId) {
        setPageMode('entry');
      }
    },
    [confirm, runtime],
  );

  const handlePauseSwarm = useCallback(
    (swarmId: string) => {
      void runtime.pauseSwarm(swarmId);
    },
    [runtime],
  );

  const handleStopSwarm = useCallback(
    async (swarmId: string) => {
      const shouldStop = await confirm({
        title: 'Task stoppen?',
        description: 'Stop this task and abort it?',
        confirmLabel: 'Stop',
        tone: 'danger',
      });
      if (!shouldStop) return;
      void runtime.abortSwarm(swarmId).then(() => {
        setPageMode('entry');
      });
    },
    [confirm, runtime],
  );

  const handleFinishSwarm = useCallback(
    async (swarmId: string) => {
      const shouldFinish = await confirm({
        title: 'Task abschließen?',
        description: 'Mark this task as finished?',
        confirmLabel: 'Finish',
        tone: 'danger',
      });
      if (!shouldFinish) return;
      void runtime.forceComplete(swarmId);
    },
    [confirm, runtime],
  );

  useEffect(() => {
    if (pageMode !== 'detail') return;
    if (!runtime.selectedSwarmId) {
      setPageMode('entry');
      return;
    }
    if (!runtime.selectedSwarm) {
      setPageMode('entry');
      setNotice('The selected task no longer exists.');
    }
  }, [pageMode, runtime.selectedSwarm, runtime.selectedSwarmId]);

  return (
    <div className="h-full">
      {pageMode === 'entry' ? (
        <AgentRoomEntryPage
          swarms={runtime.swarms}
          selectedSwarmId={runtime.selectedSwarmId}
          loading={runtime.loading}
          error={runtime.error}
          notice={notice}
          onCreateClick={() => setShowCreateModal(true)}
          onOpenSwarm={handleOpenSwarm}
          onDeleteSwarm={handleDeleteSwarm}
        />
      ) : (
        <AgentRoomDetailPage
          swarm={runtime.selectedSwarm}
          messages={chatMessages}
          error={runtime.error}
          swarmPersonas={swarmPersonas}
          onBack={handleBackToEntry}
          onExportMarkdown={handleExportMarkdown}
          onPause={handlePauseSwarm}
          onStop={handleStopSwarm}
          onFinish={handleFinishSwarm}
          onSendMessage={handleOperatorSend}
        />
      )}

      <NewSwarmModal
        open={showCreateModal}
        personas={personas}
        creating={runtime.deployState === 'deploying'}
        onClose={() => setShowCreateModal(false)}
        onCreate={async (input) => {
          const created = await runtime.createSwarm(input);
          if (created?.id) {
            await runtime.deploySwarm(created.id);
            runtime.setSelectedSwarmId(created.id);
            setPageMode('detail');
            setNotice(null);
          }
          return created;
        }}
      />
    </div>
  );
}
