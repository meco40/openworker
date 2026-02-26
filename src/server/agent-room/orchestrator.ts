import crypto from 'node:crypto';
import { getMessageRepository, getMessageService } from '@/server/channels/messages/runtime';
import { getAgentV2SessionManager } from '@/server/agent-v2/runtime';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import type { ResolvedSwarmUnit, SwarmPhase } from '@/modules/agent-room/swarmPhases';
import { getSwarmPhaseLabel } from '@/modules/agent-room/swarmPhases';
import {
  buildSimpleTurnPrompt,
  chooseNextSpeakerPersonaId,
  computeNextPhaseAfterTurn,
  countStructuredTurns,
  countTurnsInCurrentPhase,
  extractRecentTurnHistory,
  getPhaseRounds,
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

// ─── Per-agent session storage (serialised in phaseBuffer) ────────────

interface AgentSession {
  personaId: string;
  sessionId: string;
  lastSeq: number;
}

const AGENT_SESSION_PREFIX = 'agentsession:';

function parseAgentSessions(phaseBuffer: string[]): AgentSession[] {
  const sessions: AgentSession[] = [];
  for (const entry of phaseBuffer) {
    if (!entry.startsWith(AGENT_SESSION_PREFIX)) continue;
    const parts = entry.slice(AGENT_SESSION_PREFIX.length).split(':');
    if (parts.length >= 3) {
      sessions.push({
        personaId: parts[0],
        sessionId: parts[1],
        lastSeq: Number(parts[2]) || 0,
      });
    }
  }
  return sessions;
}

function getAgentSessionEntry(phaseBuffer: string[], personaId: string): AgentSession | null {
  const sessions = parseAgentSessions(phaseBuffer);
  return sessions.find((s) => s.personaId === personaId) ?? null;
}

function serializeAgentSession(session: AgentSession): string {
  return `${AGENT_SESSION_PREFIX}${session.personaId}:${session.sessionId}:${session.lastSeq}`;
}

function updatePhaseBufferSessions(phaseBuffer: string[], updated: AgentSession): string[] {
  const result: string[] = [];
  let found = false;
  for (const entry of phaseBuffer) {
    if (entry.startsWith(AGENT_SESSION_PREFIX)) {
      const parts = entry.slice(AGENT_SESSION_PREFIX.length).split(':');
      if (parts[0] === updated.personaId) {
        result.push(serializeAgentSession(updated));
        found = true;
        continue;
      }
    }
    result.push(entry);
  }
  if (!found) {
    result.push(serializeAgentSession(updated));
  }
  return result;
}

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
      const errMsg = err instanceof Error ? err.message : String(err || '');
      const isRateLimit = /429|too many requests|rate.limit|resource.exhausted/i.test(errMsg);

      if (isRateLimit) {
        // Transient rate limit — log but keep swarm running for next tick retry.
        console.warn(
          `[swarm-orchestrator] rate limited for swarm ${swarm.id}, will retry next tick`,
        );
      } else {
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
  const currentPhase = swarm.currentPhase as SwarmPhase;
  const turnsInPhase = countTurnsInCurrentPhase(swarm.artifact);
  const phaseRoundsTotal = getPhaseRounds(currentPhase);
  const phaseRound = Math.min(
    phaseRoundsTotal,
    Math.floor(turnsInPhase / Math.max(1, units.length)) + 1,
  );
  const prompt = buildSimpleTurnPrompt({
    swarmTitle: swarm.title,
    task: swarm.task,
    phase: currentPhase,
    speaker,
    leadPersonaId: swarm.leadPersonaId,
    recentHistory,
    units,
    phaseRound,
    phaseRoundsTotal,
  });

  let sessionId: string | null = null;
  let priorLastSeq = 0;
  let isNewSession = false;

  // Each agent gets its own session so it maintains its own AI context.
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

  // Pre-generate commandId so we can broadcast the persona mapping to the
  // frontend BEFORE enqueueInput fires agent.v2.command.started synchronously.
  // Without this, the frontend receives command.started before it knows which
  // persona the command belongs to and falls back to the lead persona.
  const commandId = `agent-command-${crypto.randomUUID()}`;

  // Save per-agent session and speaker marker into phaseBuffer
  const updatedBuffer = updatePhaseBufferSessions(
    (swarm.phaseBuffer ?? []).filter((e) => !e.startsWith('speaker:')),
    { personaId: speaker.personaId, sessionId, lastSeq: priorLastSeq },
  );
  updatedBuffer.push(`speaker:${speaker.personaId}`);

  repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
    currentDeployCommandId: commandId,
    lastSeq: priorLastSeq,
    sessionId,
    phaseBuffer: updatedBuffer,
  });

  // Broadcast BEFORE enqueue so the client registers commandId → personaId
  // before the synchronous command.started event arrives via WebSocket.
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

  // Now enqueue — this synchronously fires agent.v2.command.started, but the
  // client already has the commandId → personaId mapping from our broadcast above.
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
    // Preserve agent session entries on error so sessions survive retry
    const errorBuffer = (swarm.phaseBuffer ?? []).filter((e) => e.startsWith(AGENT_SESSION_PREFIX));
    repo.updateAgentRoomSwarm?.(swarm.id, swarm.userId, {
      currentDeployCommandId: null,
      status: 'error',
      holdFlag: true,
      lastSeq: newSeq,
      phaseBuffer: errorBuffer,
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

  // --- Build artifact: always append the turn under the current phase ---
  let newArtifactContent: string;
  if (!swarm.artifact || !swarm.artifact.trim()) {
    // First turn — include initial phase marker
    const phaseLabel = getSwarmPhaseLabel(swarm.currentPhase as SwarmPhase);
    newArtifactContent = `--- ${phaseLabel} ---\n\n${turnLine}`;
  } else {
    // Append turn to current phase (no new marker yet)
    newArtifactContent = `${swarm.artifact}\n\n${turnLine}`;
  }

  // --- Server-driven phase advancement ---
  // Count turns in the current phase to decide if we should auto-advance.
  const phaseResult = computeNextPhaseAfterTurn({
    currentPhase: swarm.currentPhase as SwarmPhase,
    artifactAfterTurn: newArtifactContent,
    numAgents: units.length,
  });

  // Safety-net: also check total turn cap
  const totalTurns = countStructuredTurns(newArtifactContent);
  const hardCapReached = shouldCompleteSwarmAfterTurnWithTurnCount(
    swarm.currentPhase as SwarmPhase,
    totalTurns,
  );

  const shouldComplete = phaseResult.swarmComplete || hardCapReached;

  const nextPhase: SwarmPhase = shouldComplete
    ? (swarm.currentPhase as SwarmPhase)
    : phaseResult.nextPhase;

  // If the phase just completed (but swarm isn't done), insert the NEXT phase marker
  if (phaseResult.phaseComplete && !shouldComplete) {
    const nextPhaseLabel = getSwarmPhaseLabel(nextPhase);
    newArtifactContent = `${newArtifactContent}\n\n--- ${nextPhaseLabel} ---`;
  }

  const clampedArtifact = clampArtifact(newArtifactContent);
  const newHistory = pushArtifactSnapshot(swarm.artifactHistory ?? [], clampedArtifact);
  const friction = deriveConflictRadar(clampedArtifact);

  // Update per-agent session seq so next turn for this agent resumes correctly
  const speakerEntry = getAgentSessionEntry(swarm.phaseBuffer ?? [], speaker?.personaId || '');
  const completionBuffer = speakerEntry
    ? updatePhaseBufferSessions(
        (swarm.phaseBuffer ?? []).filter((e) => !e.startsWith('speaker:')),
        { ...speakerEntry, lastSeq: newSeq },
      )
    : (swarm.phaseBuffer ?? []).filter((e) => e.startsWith(AGENT_SESSION_PREFIX));

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
    phaseBuffer: completionBuffer,
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
  const fullText = String(artifact || '');
  if (!fullText.trim()) {
    return { level: 'low', confidence: 0, hold: false, reasons: [], updatedAt: now };
  }

  // Only analyze the current phase section (after last marker)
  const markerRegex = /^---\s+.+?\s+---$/gm;
  let lastMarkerEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = markerRegex.exec(fullText))) {
    lastMarkerEnd = m.index + m[0].length;
  }
  const text = fullText.slice(lastMarkerEnd);
  if (!text.trim()) {
    return { level: 'low', confidence: 0, hold: false, reasons: [], updatedAt: now };
  }

  const signalDefs: Array<{ pattern: RegExp; label: string; severity: 'risk' | 'severe' }> = [
    {
      pattern: /\b(fehl|risiko|konflikt|blocker|unsicher)\b/i,
      label: 'Risk keywords (DE)',
      severity: 'risk',
    },
    {
      pattern: /\b(doubt|risk|conflict|blocker|unclear)\b/i,
      label: 'Risk keywords (EN)',
      severity: 'risk',
    },
    {
      pattern: /\b(contradict|inconsistent|disagree)\b/i,
      label: 'Disagreement signal',
      severity: 'risk',
    },
    {
      pattern: /\b(fatal|critical failure|impossible)\b/i,
      label: 'Critical blocker',
      severity: 'severe',
    },
    { pattern: /\[VOTE:DOWN\]/i, label: 'Agent voted DOWN', severity: 'severe' },
  ];

  let riskHits = 0;
  let severeHits = 0;
  const reasons: string[] = [];

  for (const def of signalDefs) {
    if (def.pattern.test(text)) {
      if (def.severity === 'severe') severeHits++;
      else riskHits++;
      // Extract a short excerpt for context
      const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 10);
      const excerpt = sentences.find((s) => def.pattern.test(s));
      if (excerpt) {
        const trimmed = excerpt.trim().slice(0, 120);
        reasons.push(
          `${def.label}: "${trimmed.length < excerpt.trim().length ? `${trimmed}…` : trimmed}"`,
        );
      } else {
        reasons.push(def.label);
      }
    }
  }

  const score = Math.min(100, riskHits * 25 + severeHits * 35);
  const level: SwarmFriction['level'] = score >= 65 ? 'high' : score >= 30 ? 'medium' : 'low';
  return {
    level,
    confidence: score,
    hold: false,
    reasons,
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
