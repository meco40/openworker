import { getMessageRepository, getMessageService } from '@/server/channels/messages/runtime';
import { getAgentV2SessionManager } from '@/server/agent-v2/runtime';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import type { ResolvedSwarmUnit, SwarmPhase } from '@/modules/agent-room/swarmPhases';
import {
  buildSimpleTurnPrompt,
  chooseNextSpeakerPersonaId,
  countStructuredTurns,
  extractRecentTurnHistory,
  getSimpleSwarmMaxTurns,
  parseTurnDirectives,
  shouldCompleteSwarmAfterTurnWithTurnCount,
  stripLeadingSpeakerPrefix,
  stripTrailingOtherSpeakerTurns,
} from '@/server/agent-room/simpleLoop';
import type { AgentRoomSwarmRecord } from '@/server/channels/messages/repository/types';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';

const ARTIFACT_MAX_CHARS = 20_000;
const ARTIFACT_HISTORY_LIMIT = 24;
const REPLAY_LIMIT = 2000;

interface SwarmFriction {
  level: 'low' | 'medium' | 'high';
  confidence: number;
  hold: boolean;
  reasons: string[];
  updatedAt: string;
}

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
      console.error(`[swarm-orchestrator] tick failed for swarm ${swarm.id}:`, err);
      try {
        const r = getMessageRepository();
        r.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
          status: 'error',
          holdFlag: true,
        });
        broadcastToUser(
          swarm.userId,
          GatewayEvents.AGENT_ROOM_SWARM,
          { swarmId: swarm.id, status: 'updated', updatedAt: new Date().toISOString() },
          { protocol: 'v2' },
        );
      } catch {
        // best effort
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
    if ((fresh.currentPhase as SwarmPhase) === 'result') {
      repo.updateAgentRoomSwarm?.(fresh.id, fresh.userId, {
        status: 'completed',
        holdFlag: false,
        currentDeployCommandId: null,
      });
      broadcastToUser(
        fresh.userId,
        GatewayEvents.AGENT_ROOM_SWARM,
        { swarmId: fresh.id, status: 'updated', updatedAt: new Date().toISOString() },
        { protocol: 'v2' },
      );
      return;
    }
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
    repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
      status: 'completed',
      currentPhase: 'result',
      holdFlag: false,
      currentDeployCommandId: null,
    });
    broadcastToUser(
      swarm.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      { swarmId: swarm.id, status: 'updated', updatedAt: new Date().toISOString() },
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
  const prompt = buildSimpleTurnPrompt({
    swarmTitle: swarm.title,
    task: swarm.task,
    phase: swarm.currentPhase as SwarmPhase,
    speaker,
    leadPersonaId: swarm.leadPersonaId,
    recentHistory,
    units,
  });

  let sessionId = swarm.sessionId;
  let priorLastSeq = swarm.lastSeq;
  let isNewSession = false;

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
    repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, { sessionId });
  } else {
    try {
      priorLastSeq = manager.getSession(sessionId, swarm.userId).lastSeq;
    } catch {
      priorLastSeq = swarm.lastSeq;
    }
  }

  messageService.setPersonaId(swarm.conversationId, speaker.personaId, swarm.userId);

  const result = isNewSession
    ? await manager.enqueueInput({
        sessionId,
        userId: swarm.userId,
        content: prompt,
        idempotencyKey: `swarm-${swarm.id}:turn-${turnCount}`,
      })
    : await manager.enqueueFollowUp({
        sessionId,
        userId: swarm.userId,
        content: prompt,
        idempotencyKey: `swarm-${swarm.id}:turn-${turnCount}`,
      });

  const commandId = result.command.id;

  repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
    currentDeployCommandId: commandId,
    lastSeq: priorLastSeq,
    sessionId,
    phaseBuffer: [`speaker:${speaker.personaId}`],
  });

  broadcastToUser(
    swarm.userId,
    GatewayEvents.AGENT_ROOM_SWARM,
    {
      swarmId: swarm.id,
      status: 'updated',
      sessionId,
      commandId,
      currentPhase: swarm.currentPhase,
      leadPersonaId: swarm.leadPersonaId,
      agentPersonaId: speaker.personaId,
      updatedAt: new Date().toISOString(),
    },
    { protocol: 'v2' },
  );

  console.log(
    `[swarm-orchestrator] dispatched turn=${turnCount} speaker=${speaker.personaId} commandId=${commandId} swarm=${swarm.id}`,
  );
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
      `[swarm-orchestrator] replay failed for swarm=${swarm.id}, falling back to direct lookup:`,
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
    repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
      currentDeployCommandId: null,
      status: 'error',
      holdFlag: true,
      lastSeq: newSeq,
      phaseBuffer: [],
    });
    broadcastToUser(
      swarm.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      { swarmId: swarm.id, status: 'updated', updatedAt: new Date().toISOString() },
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
  const normalizedBody = stripLeadingSpeakerPrefix(parsed.cleanText || rawText, speaker?.name || '');
  const speakerBoundBody = stripTrailingOtherSpeakerTurns(
    normalizedBody || rawText,
    speaker?.name || '',
    units.map((unit) => unit.name),
  );
  const finalText = speakerBoundBody || normalizedBody || '(no content)';
  const turnLine = `**[${speaker?.name || 'Agent'}]:** ${finalText}`;

  const clampedArtifact = clampArtifact(
    swarm.artifact ? `${swarm.artifact}\n\n${turnLine}` : turnLine,
  );
  const newHistory = pushArtifactSnapshot(swarm.artifactHistory ?? [], clampedArtifact);
  const friction = deriveConflictRadar(clampedArtifact);
  const consensusScore = clampConsensusScore(swarm.consensusScore + parsed.consensusDelta);
  const nextTurnCount = countStructuredTurns(clampedArtifact);
  const shouldComplete = shouldCompleteSwarmAfterTurnWithTurnCount(
    parsed.nextPhase as SwarmPhase,
    nextTurnCount,
  );
  const nextPhase = shouldComplete ? 'result' : parsed.nextPhase;

  repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
    currentDeployCommandId: null,
    artifact: clampedArtifact,
    artifactHistory: newHistory,
    friction,
    consensusScore,
    currentPhase: nextPhase,
    holdFlag: false,
    status: shouldComplete ? 'completed' : 'running',
    lastSeq: newSeq,
    phaseBuffer: [],
  });

  broadcastToUser(
    swarm.userId,
    GatewayEvents.AGENT_ROOM_SWARM,
    { swarmId: swarm.id, status: 'updated', updatedAt: new Date().toISOString() },
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
  const marker = Array.isArray(swarm.phaseBuffer)
    ? swarm.phaseBuffer.find((item) => String(item || '').startsWith('speaker:'))
    : null;
  if (marker) {
    const parsed = marker.slice('speaker:'.length).trim();
    if (parsed) return parsed;
  }
  const conversation = messageService.getConversation(swarm.conversationId, swarm.userId);
  if (conversation?.personaId) return conversation.personaId;
  return swarm.leadPersonaId;
}

function clampConsensusScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampArtifact(text: string): string {
  const value = String(text || '');
  if (value.length <= ARTIFACT_MAX_CHARS) return value;
  return value.slice(value.length - ARTIFACT_MAX_CHARS);
}

function pushArtifactSnapshot(history: string[], artifact: string): string[] {
  const normalized = String(artifact || '').trim();
  if (!normalized) return history;
  if (history[history.length - 1] === normalized) return history;
  const next = [...history, normalized];
  if (next.length <= ARTIFACT_HISTORY_LIMIT) return next;
  return next.slice(next.length - ARTIFACT_HISTORY_LIMIT);
}

function deriveConflictRadar(artifact: string): SwarmFriction {
  const now = new Date().toISOString();
  const text = String(artifact || '').toLowerCase();
  if (!text.trim()) {
    return { level: 'low', confidence: 0, hold: false, reasons: [], updatedAt: now };
  }
  const riskPatterns = [
    /\b(fehl|risiko|konflikt|blocker|unsicher)\b/i,
    /\b(doubt|risk|conflict|blocker|unclear)\b/i,
    /\b(contradict|inconsistent|problem)\b/i,
  ];
  const severePatterns = [
    /\b(fatal error|critical failure|impossible to|impossible without)\b/i,
    /\b(system abort|halt execution)\b/i,
  ];
  const riskHits = riskPatterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
  const severeHits = severePatterns.reduce(
    (sum, pattern) => sum + (pattern.test(text) ? 1 : 0),
    0,
  );
  const score = Math.min(100, riskHits * 25 + severeHits * 35);
  const level: SwarmFriction['level'] = score >= 65 ? 'high' : score >= 30 ? 'medium' : 'low';
  return {
    level,
    confidence: score,
    hold: false,
    reasons: [
      riskHits > 0 ? `risk-signals:${riskHits}` : '',
      severeHits > 0 ? `severe-signals:${severeHits}` : '',
    ].filter(Boolean),
    updatedAt: now,
  };
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
