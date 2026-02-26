import { getMessageRepository, getMessageService } from '@/server/channels/messages/runtime';
import { getAgentV2SessionManager } from '@/server/agent-v2/runtime';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import type { SwarmPhase } from '@/shared/domain/swarmPhases';
import type { AgentRoomSwarmRecord } from '@/server/channels/messages/repository/types';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';
import {
  computeNextPhaseAfterTurn,
  countStructuredTurns,
  parseTurnDirectives,
  shouldCompleteSwarmAfterTurnWithTurnCount,
  stripLeadingSpeakerPrefix,
  stripTrailingOtherSpeakerTurns,
} from '@/server/agent-room/prompt';
import {
  deriveConflictRadar,
  pushArtifactSnapshot,
  buildArtifactWithNewTurn,
  clampConsensusScore,
  getAgentSessionEntry,
  updatePhaseBufferSessions,
} from '@/server/agent-room/services';
import { resolveSwarmUnits, resolveSpeakerPersonaId } from './swarmResolution.service';

const REPLAY_LIMIT = 2000;

/**
 * Checks whether the current turn has completed and, if so,
 * updates the artifact, consensus, friction, and phase state.
 */
export async function checkTurnCompletion(swarm: AgentRoomSwarmRecord): Promise<void> {
  const repo = getMessageRepository();
  const manager = getAgentV2SessionManager();
  const messageService = getMessageService();
  const commandId = swarm.currentDeployCommandId;
  if (!commandId || !swarm.sessionId) return;

  let events: AgentV2EventEnvelope[] = [];
  try {
    events = manager.replaySessionEvents({
      sessionId: swarm.sessionId,
      userId: swarm.userId,
      fromSeq: swarm.lastSeq,
      limit: REPLAY_LIMIT,
    });
  } catch (replayErr) {
    console.warn(
      `[swarm-orchestrator] replay failed for swarm=${swarm.id}, falling back:`,
      replayErr instanceof Error ? replayErr.message : replayErr,
    );
  }

  if (events.length === 0) {
    const terminalEvent = manager.getCommandResult(commandId, swarm.sessionId);
    if (!terminalEvent) return;
    events.push(terminalEvent);
  }

  const completionEvent = findCompletionEvent(events, commandId);
  if (!completionEvent) return;

  const newSeq = events[events.length - 1]?.seq ?? swarm.lastSeq;

  if (completionEvent.type === 'agent.v2.error') {
    const errorBuffer = (swarm.phaseBuffer ?? []).filter((e) => e.type === 'agentsession');
    const errorSwarm = repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
      currentDeployCommandId: null,
      status: 'error',
      holdFlag: true,
      lastSeq: newSeq,
      phaseBuffer: errorBuffer,
    });
    broadcastToUser(
      swarm.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      {
        swarmId: swarm.id,
        status: 'updated',
        swarm: errorSwarm ?? undefined,
        updatedAt: new Date().toISOString(),
      },
      { protocol: 'v2' },
    );
    return;
  }

  const rawText = extractCompletedText(completionEvent);
  const units = resolveSwarmUnits(swarm);
  const speakerPersonaId = resolveSpeakerPersonaId(swarm, messageService);
  const speaker =
    units.find((unit) => unit.personaId === speakerPersonaId) ||
    units.find((unit) => unit.personaId === swarm.leadPersonaId) ||
    units[0];

  const parsed = parseTurnDirectives({
    rawText,
    speakerPersonaId: speaker?.personaId || swarm.leadPersonaId,
    leadPersonaId: swarm.leadPersonaId,
    currentPhase: swarm.currentPhase as SwarmPhase,
  });
  const normalizedBody = stripLeadingSpeakerPrefix(
    parsed.cleanText || rawText,
    speaker?.name || '',
  );
  const speakerBoundBody = stripTrailingOtherSpeakerTurns(
    normalizedBody || rawText,
    speaker?.name || '',
    units.map((unit) => unit.name),
  );
  const finalText = speakerBoundBody || normalizedBody || '(no content)';
  const turnLine = `**[${speaker?.name || 'Agent'}]:** ${finalText}`;

  const consensusScore = clampConsensusScore(swarm.consensusScore + parsed.consensusDelta);

  const phaseResult = computeNextPhaseAfterTurn({
    currentPhase: swarm.currentPhase as SwarmPhase,
    artifactAfterTurn: swarm.artifact ? `${swarm.artifact}\n\n${turnLine}` : turnLine,
    numAgents: units.length,
  });

  const totalTurns = countStructuredTurns(
    swarm.artifact ? `${swarm.artifact}\n\n${turnLine}` : turnLine,
  );
  const hardCapReached = shouldCompleteSwarmAfterTurnWithTurnCount(
    swarm.currentPhase as SwarmPhase,
    totalTurns,
  );
  const shouldComplete = phaseResult.swarmComplete || hardCapReached;
  const nextPhase = (shouldComplete ? swarm.currentPhase : phaseResult.nextPhase) as SwarmPhase;

  // B9: Reset consensus score to neutral baseline (50) on phase transitions
  const CONSENSUS_PHASE_RESET = 50;
  const finalConsensus =
    phaseResult.phaseComplete && !shouldComplete ? CONSENSUS_PHASE_RESET : consensusScore;

  const newArtifact = buildArtifactWithNewTurn(
    swarm.artifact,
    turnLine,
    swarm.currentPhase as SwarmPhase,
    phaseResult.phaseComplete && !shouldComplete,
    nextPhase,
  );

  const newHistory = pushArtifactSnapshot(swarm.artifactHistory ?? [], newArtifact);
  const friction = deriveConflictRadar(newArtifact);

  const speakerEntry = getAgentSessionEntry(swarm.phaseBuffer ?? [], speaker?.personaId || '');
  const completionBuffer = speakerEntry
    ? updatePhaseBufferSessions(
        (swarm.phaseBuffer ?? []).filter((e) => e.type !== 'speaker'),
        { ...speakerEntry, lastSeq: newSeq },
      )
    : (swarm.phaseBuffer ?? []).filter((e) => e.type === 'agentsession');

  // C3: When phase completes (but swarm continues), inject a phase summary marker
  // so the next turn from the lead agent summarizes phase findings.
  if (phaseResult.phaseComplete && !shouldComplete) {
    completionBuffer.push({
      type: 'phaseSummaryPending',
      fromPhase: swarm.currentPhase,
    });
  }

  // Pause between phases: if the phase just completed (but swarm isn't done)
  // and pauseBetweenPhases is enabled, set status to 'hold' so the user can review.
  const shouldPause =
    phaseResult.phaseComplete && !shouldComplete && Boolean(swarm.pauseBetweenPhases);

  const updatedSwarm = repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
    currentDeployCommandId: null,
    artifact: newArtifact,
    artifactHistory: newHistory,
    friction,
    consensusScore: finalConsensus,
    currentPhase: nextPhase,
    holdFlag: shouldPause,
    status: shouldComplete ? 'completed' : shouldPause ? 'hold' : 'running',
    lastSeq: newSeq,
    phaseBuffer: completionBuffer,
  });

  broadcastToUser(
    swarm.userId,
    GatewayEvents.AGENT_ROOM_SWARM,
    {
      swarmId: swarm.id,
      status: 'updated',
      swarm: updatedSwarm ?? undefined,
      updatedAt: new Date().toISOString(),
    },
    { protocol: 'v2' },
  );
}

/**
 * Finds the terminal event (completion or error) for a given commandId.
 */
export function findCompletionEvent(
  events: AgentV2EventEnvelope[],
  commandId: string,
): AgentV2EventEnvelope | null {
  for (const event of events) {
    if (event.commandId !== commandId) continue;
    if (event.type === 'agent.v2.command.completed' || event.type === 'agent.v2.error') {
      return event;
    }
  }
  return null;
}

/**
 * Extracts the completed text from a command completion event payload.
 */
export function extractCompletedText(event: AgentV2EventEnvelope): string {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.result === 'object' && payload.result !== null) {
    const result = payload.result as Record<string, unknown>;
    if (typeof result.message === 'string') return result.message;
    if (typeof result.content === 'string') return result.content;
  }
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.message === 'string') return payload.message;
  return '';
}
