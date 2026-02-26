import crypto from 'node:crypto';
import { getMessageRepository, getMessageService } from '@/server/channels/messages/runtime';
import { getAgentV2SessionManager } from '@/server/agent-v2/runtime';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import type { ResolvedSwarmUnit, SwarmPhase } from '@/modules/agent-room/swarmPhases';
import type { AgentRoomSwarmRecord } from '@/server/channels/messages/repository/types';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';

// Modular services
import {
  buildSimpleTurnPrompt,
  chooseNextSpeakerPersonaId,
  computeNextPhaseAfterTurn,
  countStructuredTurns,
  extractRecentTurnHistory,
  getSimpleSwarmMaxTurns,
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
  extractSpeakerFromPhaseBuffer,
} from '@/server/agent-room/services';

const REPLAY_LIMIT = 2000;

const processing = new Set<string>();

export async function runOrchestratorOnce(): Promise<void> {
  const repo = getMessageRepository();
  if (!repo.listRunningSwarms) return;

  const runningSwarms = repo.listRunningSwarms(50);

  for (const swarm of runningSwarms) {
    if (processing.has(swarm.id)) continue;
    processing.add(swarm.id);
    try {
      await processSwarmTick(swarm);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err || '');
      const isRateLimit = /429|too many requests|rate.limit|resource.exhausted/i.test(errMsg);

      if (isRateLimit) {
        console.warn(
          `[swarm-orchestrator] rate limited for swarm ${swarm.id}, will retry next tick`,
        );
      } else {
        console.error(`[swarm-orchestrator] tick failed for swarm ${swarm.id}:`, err);
        try {
          const r = getMessageRepository();
          const errorSwarm = r.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
            status: 'error',
            holdFlag: true,
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
        } catch {
          // best effort
        }
      }
    } finally {
      processing.delete(swarm.id);
    }
  }
}

async function processSwarmTick(swarm: AgentRoomSwarmRecord): Promise<void> {
  const repo = getMessageRepository();
  if (!repo.updateAgentRoomSwarm || !repo.getAgentRoomSwarm) return;

  const fresh = repo.getAgentRoomSwarm(swarm.id, swarm.userId);
  if (!fresh || fresh.status !== 'running') return;

  if (!fresh.currentDeployCommandId) {
    await dispatchNextTurn(fresh);
    return;
  }

  await checkTurnCompletion(fresh);
}

async function dispatchNextTurn(swarm: AgentRoomSwarmRecord): Promise<void> {
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

  const nextSpeakerPersonaId = chooseNextSpeakerPersonaId({
    turnCount,
    leadPersonaId: swarm.leadPersonaId,
    units: swarm.units,
  });
  const speaker =
    units.find((unit) => unit.personaId === nextSpeakerPersonaId) ||
    units.find((unit) => unit.personaId === swarm.leadPersonaId) ||
    units[0];
  if (!speaker) return;

  const recentHistory = extractRecentTurnHistory(swarm.artifact, 8);
  const currentPhase = swarm.currentPhase as SwarmPhase;
  const prompt = buildSimpleTurnPrompt({
    swarmTitle: swarm.title,
    task: swarm.task,
    phase: currentPhase,
    speaker,
    leadPersonaId: swarm.leadPersonaId,
    recentHistory,
    units,
  });

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
    (swarm.phaseBuffer ?? []).filter((e) => e.type !== 'speaker'),
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

async function checkTurnCompletion(swarm: AgentRoomSwarmRecord): Promise<void> {
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

  // Build artifact with phase handling
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
  const nextPhase: SwarmPhase = shouldComplete
    ? (swarm.currentPhase as SwarmPhase)
    : phaseResult.nextPhase;

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

  const updatedSwarm = repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
    currentDeployCommandId: null,
    artifact: newArtifact,
    artifactHistory: newHistory,
    friction,
    consensusScore,
    currentPhase: nextPhase,
    holdFlag: false,
    status: shouldComplete ? 'completed' : 'running',
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

function resolveSwarmUnits(swarm: AgentRoomSwarmRecord): ResolvedSwarmUnit[] {
  const personaRepo = getPersonaRepository();
  const seen = new Set<string>();
  const units: ResolvedSwarmUnit[] = [];
  for (const unit of swarm.units) {
    const personaId = String(unit.personaId || '').trim();
    if (!personaId || seen.has(personaId)) continue;
    seen.add(personaId);
    const persona = personaRepo.getPersona(personaId);
    units.push({
      personaId,
      role: unit.role,
      name: persona?.name || personaId,
      emoji: persona?.emoji || '🤖',
    });
  }

  if (!seen.has(swarm.leadPersonaId)) {
    const lead = personaRepo.getPersona(swarm.leadPersonaId);
    units.unshift({
      personaId: swarm.leadPersonaId,
      role: 'Orchestrator',
      name: lead?.name || swarm.leadPersonaId,
      emoji: lead?.emoji || '🤖',
    });
  }

  return units;
}

function resolveSpeakerPersonaId(
  swarm: AgentRoomSwarmRecord,
  messageService: ReturnType<typeof getMessageService>,
): string {
  const fromBuffer = extractSpeakerFromPhaseBuffer(swarm.phaseBuffer ?? null);
  if (fromBuffer) return fromBuffer;

  const conversation = messageService.getConversation(swarm.conversationId, swarm.userId);
  if (conversation?.personaId) return conversation.personaId;
  return swarm.leadPersonaId;
}

function findCompletionEvent(
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

function extractCompletedText(event: AgentV2EventEnvelope): string {
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
