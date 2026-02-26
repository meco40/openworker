import crypto from 'node:crypto';
import { getMessageRepository, getMessageService } from '@/server/channels/messages/runtime';
import { getAgentV2SessionManager } from '@/server/agent-v2/runtime';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import type { SwarmPhase } from '@/shared/domain/swarmPhases';
import type { AgentRoomSwarmRecord } from '@/server/channels/messages/repository/types';
import {
  buildSimpleTurnPrompt,
  chooseNextSpeakerPersonaId,
  countStructuredTurns,
  extractRecentTurnHistory,
  getSimpleSwarmMaxTurns,
} from '@/server/agent-room/prompt';
import { getSwarmPhaseLabel } from '@/shared/domain/swarmPhases';
import {
  getAgentSessionEntry,
  updatePhaseBufferSessions,
} from '@/server/agent-room/services/agentSession.service';
import { resolveSwarmUnits } from '@/server/agent-room/services/swarmResolution.service';

/**
 * Dispatches the next agent turn for a running swarm.
 *
 * Selects the next speaker via round-robin, resolves or creates a session,
 * enqueues the prompt, and broadcasts the update.
 */
export async function dispatchNextTurn(swarm: AgentRoomSwarmRecord): Promise<void> {
  const repo = getMessageRepository();
  const manager = getAgentV2SessionManager();
  const messageService = getMessageService();

  const units = resolveSwarmUnits(swarm);
  if (units.length === 0) {
    console.warn(`[swarm-orchestrator] swarm=${swarm.id} has no units, skipping turn dispatch`);
    return;
  }

  const turnCount = countStructuredTurns(swarm.artifact);
  const maxTurns = getSimpleSwarmMaxTurns();
  if (turnCount >= maxTurns) {
    const completedSwarm = repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
      status: 'completed',
      currentPhase: 'result',
      holdFlag: false,
      currentDeployCommandId: null,
    });
    broadcastToUser(
      swarm.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      {
        swarmId: swarm.id,
        status: 'updated',
        swarm: completedSwarm ?? undefined,
        updatedAt: new Date().toISOString(),
      },
      { protocol: 'v2' },
    );
    return;
  }

  // C2: Check for speaker override from targeted steering (@mention)
  const overrideEntry = (swarm.phaseBuffer ?? []).find((e) => e.type === 'speakerOverride');
  const overridePersonaId = overrideEntry ? overrideEntry.personaId : null;

  // C3: Check for pending phase summary — lead agent summarizes phase findings
  const summaryEntry = (swarm.phaseBuffer ?? []).find((e) => e.type === 'phaseSummaryPending');
  const isSummaryTurn = Boolean(summaryEntry);

  const nextSpeakerPersonaId = isSummaryTurn
    ? swarm.leadPersonaId
    : (overridePersonaId ??
      chooseNextSpeakerPersonaId({
        turnCount,
        leadPersonaId: swarm.leadPersonaId,
        units: swarm.units,
        currentPhase: swarm.currentPhase,
      }));
  const speaker =
    units.find((unit) => unit.personaId === nextSpeakerPersonaId) ||
    units.find((unit) => unit.personaId === swarm.leadPersonaId) ||
    units[0];
  if (!speaker) return;

  const recentHistory = extractRecentTurnHistory(swarm.artifact, 8);
  const currentPhase = swarm.currentPhase as SwarmPhase;

  // C3: If this is a summary turn, build a summary-specific prompt
  let prompt: string;
  if (isSummaryTurn && summaryEntry && summaryEntry.type === 'phaseSummaryPending') {
    const phaseLabel = getSwarmPhaseLabel(summaryEntry.fromPhase as SwarmPhase);
    prompt = [
      `You are the lead agent for "${swarm.title}".`,
      `The "${phaseLabel}" phase has just concluded.`,
      '',
      'Provide a concise synthesis of the key findings, decisions, and outcomes from this phase.',
      'Focus on:',
      '- Main conclusions reached',
      '- Points of agreement and disagreement',
      '- Key insights that should inform the next phase',
      '',
      'Recent discussion:',
      recentHistory || '(no prior turns)',
    ].join('\n');
  } else {
    prompt = buildSimpleTurnPrompt({
      swarmTitle: swarm.title,
      task: swarm.task,
      phase: currentPhase,
      speaker,
      leadPersonaId: swarm.leadPersonaId,
      recentHistory,
      units,
    });
  }

  let sessionId: string | null = null;
  let priorLastSeq = 0;
  let isNewSession = false;

  const existingEntry = getAgentSessionEntry(swarm.phaseBuffer ?? [], speaker.personaId);

  if (existingEntry) {
    sessionId = existingEntry.sessionId;
    priorLastSeq = existingEntry.lastSeq;
    try {
      priorLastSeq = manager.getSession(sessionId, swarm.userId).lastSeq;
    } catch {
      // keep stored value
    }
  }

  if (!sessionId) {
    const started = await manager.startSession({
      userId: swarm.userId,
      title: swarm.title,
      personaId: speaker.personaId,
      conversationId: swarm.conversationId,
    });
    sessionId = started.session.id;
    priorLastSeq = started.session.lastSeq;
    isNewSession = true;
  }

  messageService.setPersonaId(swarm.conversationId, speaker.personaId, swarm.userId);

  const commandId = `agent-command-${crypto.randomUUID()}`;

  const updatedBuffer = updatePhaseBufferSessions(
    (swarm.phaseBuffer ?? []).filter(
      (e) =>
        e.type !== 'speaker' && e.type !== 'speakerOverride' && e.type !== 'phaseSummaryPending',
    ),
    { personaId: speaker.personaId, sessionId, lastSeq: priorLastSeq },
  );
  updatedBuffer.push({ type: 'speaker', personaId: speaker.personaId });

  const dispatchedSwarm = repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
    currentDeployCommandId: commandId,
    lastSeq: priorLastSeq,
    sessionId,
    phaseBuffer: updatedBuffer,
  });

  broadcastToUser(
    swarm.userId,
    GatewayEvents.AGENT_ROOM_SWARM,
    {
      swarmId: swarm.id,
      status: 'updated',
      swarm: dispatchedSwarm ?? undefined,
      sessionId,
      commandId,
      currentPhase: swarm.currentPhase,
      leadPersonaId: swarm.leadPersonaId,
      agentPersonaId: speaker.personaId,
      updatedAt: new Date().toISOString(),
    },
    { protocol: 'v2' },
  );

  if (isNewSession) {
    await manager.enqueueInput({
      sessionId,
      userId: swarm.userId,
      content: prompt,
      idempotencyKey: `swarm-${swarm.id}:turn-${turnCount}`,
      commandId,
    });
    return;
  }

  await manager.enqueueFollowUp({
    sessionId,
    userId: swarm.userId,
    content: prompt,
    idempotencyKey: `swarm-${swarm.id}:turn-${turnCount}`,
    commandId,
  });
}
