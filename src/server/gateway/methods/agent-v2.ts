import crypto from 'node:crypto';
import { ChannelType } from '@/shared/domain/types';
import { AgentV2Error } from '@/server/agent-v2/errors';
import { getAgentV2SessionManager } from '@/server/agent-v2/runtime';
import { registerMethod, type RespondFn } from '@/server/gateway/method-router';
import type { GatewayClient } from '@/server/gateway/client-registry';
import type {
  AgentRoomSwarmFriction,
  AgentRoomSwarmUnit,
} from '@/server/channels/messages/repository';
import { getMessageRepository, getMessageService } from '@/server/channels/messages/runtime';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';

const MAX_TITLE_CHARS = 160;
const MAX_TASK_CHARS = 8_000;
const MAX_GUIDANCE_CHARS = 2_000;
const MAX_UNITS = 12;
const MAX_UNITS_JSON_CHARS = 16_000;

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = String(params[key] || '').trim();
  if (!value) throw new AgentV2Error(`${key} is required`, 'INVALID_REQUEST');
  return value;
}

function requiredBoundedString(
  params: Record<string, unknown>,
  key: string,
  maxChars: number,
): string {
  const value = requiredString(params, key);
  if (value.length > maxChars) {
    throw new AgentV2Error(`${key} exceeds max size (${maxChars}).`, 'INVALID_REQUEST');
  }
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = String(params[key] || '').trim();
  return value || undefined;
}

function optionalBoundedString(
  params: Record<string, unknown>,
  key: string,
  maxChars: number,
): string | undefined {
  const value = optionalString(params, key);
  if (!value) return undefined;
  if (value.length > maxChars) {
    throw new AgentV2Error(`${key} exceeds max size (${maxChars}).`, 'INVALID_REQUEST');
  }
  return value;
}

function requiredBoolean(params: Record<string, unknown>, key: string): boolean {
  if (!(key in params)) throw new AgentV2Error(`${key} is required`, 'INVALID_REQUEST');
  return Boolean(params[key]);
}

function parseUnits(params: Record<string, unknown>, key: string): AgentRoomSwarmUnit[] {
  const value = params[key];
  if (!Array.isArray(value)) {
    throw new AgentV2Error(`${key} must be an array`, 'INVALID_REQUEST');
  }
  const units = value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const personaId = String((item as { personaId?: unknown }).personaId || '').trim();
      const role = String((item as { role?: unknown }).role || '').trim();
      if (!personaId || !role) return null;
      return { personaId, role };
    })
    .filter((item): item is AgentRoomSwarmUnit => Boolean(item));

  if (units.length === 0) {
    throw new AgentV2Error(`${key} must contain at least one valid unit`, 'INVALID_REQUEST');
  }
  if (units.length > MAX_UNITS) {
    throw new AgentV2Error(`Too many swarm units (max ${MAX_UNITS}).`, 'INVALID_REQUEST');
  }
  const serialized = JSON.stringify(units);
  if (serialized.length > MAX_UNITS_JSON_CHARS) {
    throw new AgentV2Error(`Units payload too large.`, 'INVALID_REQUEST');
  }
  return units;
}

function distinctPersonaIds(units: AgentRoomSwarmUnit[]): string[] {
  return Array.from(
    new Set(units.map((unit) => String(unit.personaId || '').trim()).filter(Boolean)),
  );
}

function parseFriction(
  params: Record<string, unknown>,
  key: string,
): AgentRoomSwarmFriction | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object') {
    throw new AgentV2Error(`${key} must be an object`, 'INVALID_REQUEST');
  }
  const raw = value as Record<string, unknown>;
  const level = String(raw.level || '').trim();
  if (level !== 'low' && level !== 'medium' && level !== 'high') {
    throw new AgentV2Error(`${key}.level is invalid`, 'INVALID_REQUEST');
  }
  return {
    level,
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0,
    hold: Boolean(raw.hold),
    reasons: Array.isArray(raw.reasons)
      ? raw.reasons.map((reason) => String(reason || '').trim()).filter(Boolean)
      : [],
    updatedAt: String(raw.updatedAt || '').trim() || new Date().toISOString(),
  };
}

function ensurePersonaExists(personaId: string): void {
  const persona = getPersonaRepository().getPersona(personaId);
  if (!persona) {
    throw new AgentV2Error(`Persona not found: ${personaId}`, 'INVALID_REQUEST');
  }
}

function assertAgentRoomEnabled(): void {
  const enabled = String(process.env.AGENT_ROOM_ENABLED || 'true').toLowerCase() === 'true';
  if (!enabled) {
    throw new AgentV2Error('Agent Room is disabled by server configuration.', 'UNAVAILABLE');
  }
}

function getSwarmRepository() {
  const repo = getMessageRepository();
  if (!repo.createAgentRoomSwarm) {
    throw new AgentV2Error('Agent Room swarm persistence is unavailable.', 'UNAVAILABLE');
  }
  return repo;
}

registerMethod(
  'agent.v2.session.start',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const personaId = optionalString(params, 'personaId');
    if (personaId) {
      ensurePersonaExists(personaId);
    }

    const started = await manager.startSession({
      userId: client.userId,
      title: optionalBoundedString(params, 'title', MAX_TITLE_CHARS),
      personaId,
      conversationId: optionalString(params, 'conversationId'),
    });
    respond({
      session: started.session,
      events: started.events,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.input',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const result = await manager.enqueueInput({
      sessionId: requiredString(params, 'sessionId'),
      userId: client.userId,
      content: requiredBoundedString(params, 'content', MAX_TASK_CHARS),
      idempotencyKey: optionalString(params, 'idempotencyKey'),
    });
    respond({
      command: result.command,
      session: result.session,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.steer',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const result = await manager.enqueueSteer({
      sessionId: requiredString(params, 'sessionId'),
      userId: client.userId,
      instruction: requiredBoundedString(params, 'instruction', MAX_GUIDANCE_CHARS),
      idempotencyKey: optionalString(params, 'idempotencyKey'),
    });
    respond({
      command: result.command,
      session: result.session,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.follow_up',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const result = await manager.enqueueFollowUp({
      sessionId: requiredString(params, 'sessionId'),
      userId: client.userId,
      content: requiredBoundedString(params, 'content', MAX_TASK_CHARS),
      idempotencyKey: optionalString(params, 'idempotencyKey'),
    });
    respond({
      command: result.command,
      session: result.session,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.approval.respond',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const result = await manager.enqueueApprovalResponse({
      sessionId: requiredString(params, 'sessionId'),
      userId: client.userId,
      approvalToken: requiredString(params, 'approvalToken'),
      approved: requiredBoolean(params, 'approved'),
      approveAlways: Boolean(params.approveAlways),
      toolId: optionalString(params, 'toolId'),
      toolFunctionName: optionalString(params, 'toolFunctionName'),
      idempotencyKey: optionalString(params, 'idempotencyKey'),
    });
    respond({
      command: result.command,
      session: result.session,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.abort',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const result = await manager.enqueueAbort({
      sessionId: requiredString(params, 'sessionId'),
      userId: client.userId,
      reason: optionalBoundedString(params, 'reason', MAX_GUIDANCE_CHARS),
      idempotencyKey: optionalString(params, 'idempotencyKey'),
    });
    respond({
      command: result.command,
      session: result.session,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.get',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const session = manager.getSession(requiredString(params, 'sessionId'), client.userId);
    respond({ session });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.list',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const rawLimit = Number(params.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 50;
    const sessions = manager.listSessions(client.userId, limit);
    respond({ sessions });
  },
  'v2',
);

registerMethod(
  'agent.v2.session.replay',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    const manager = getAgentV2SessionManager();
    const sessionId = requiredString(params, 'sessionId');
    const fromSeq = Number(params.fromSeq);
    if (!Number.isFinite(fromSeq) || fromSeq < 0) {
      throw new AgentV2Error('fromSeq must be a non-negative number', 'INVALID_REQUEST');
    }
    const rawLimit = Number(params.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : undefined;
    const events = manager.replaySessionEvents({
      sessionId,
      userId: client.userId,
      fromSeq,
      limit,
    });
    respond({
      events,
      nextSeq: events.length > 0 ? events[events.length - 1].seq : fromSeq,
    });
  },
  'v2',
);

registerMethod(
  'agent.v2.swarm.create',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    assertAgentRoomEnabled();
    const repo = getSwarmRepository();
    const messageService = getMessageService();

    const title = requiredBoundedString(params, 'title', MAX_TITLE_CHARS);
    const task = requiredBoundedString(params, 'task', MAX_TASK_CHARS);
    const leadPersonaId = requiredString(params, 'leadPersonaId');
    const units = parseUnits(params, 'units');
    const participantIds = distinctPersonaIds(units);
    if (!participantIds.includes(leadPersonaId)) {
      throw new AgentV2Error('Lead persona must be included in units.', 'INVALID_REQUEST');
    }
    if (participantIds.length < 2) {
      throw new AgentV2Error(
        'Agent Room requires at least two distinct personas for swarm dialogue.',
        'INVALID_REQUEST',
      );
    }
    ensurePersonaExists(leadPersonaId);
    units.forEach((unit) => ensurePersonaExists(unit.personaId));

    const requestedConversationId = optionalString(params, 'conversationId');
    let conversationId: string;
    if (requestedConversationId) {
      const conversation = messageService.getConversation(requestedConversationId, client.userId);
      if (!conversation) {
        throw new AgentV2Error('Conversation not found.', 'NOT_FOUND');
      }
      const isAgentRoomConversation = messageService.isAgentRoomConversation(
        requestedConversationId,
        client.userId,
      );
      if (!isAgentRoomConversation) {
        throw new AgentV2Error(
          'Conversation must be dedicated to Agent Room sessions.',
          'INVALID_REQUEST',
        );
      }
      conversationId = conversation.id;
    } else {
      const createdConversation = messageService.getOrCreateConversation(
        ChannelType.AGENT_ROOM,
        `agent-room-${crypto.randomUUID()}`,
        title,
        client.userId,
      );
      conversationId = createdConversation.id;
    }
    messageService.setPersonaId(conversationId, leadPersonaId, client.userId);

    const swarm = repo.createAgentRoomSwarm!({
      conversationId,
      userId: client.userId,
      title,
      task,
      leadPersonaId,
      units,
      currentPhase: 'analysis',
      status: 'idle',
      consensusScore: 0,
      holdFlag: false,
      artifact: '',
      artifactHistory: [],
      friction: {
        level: 'low',
        confidence: 0,
        hold: false,
        reasons: [],
        updatedAt: new Date().toISOString(),
      },
      lastSeq: 0,
      searchEnabled: Boolean(params.searchEnabled),
      swarmTemplate: optionalString(params, 'swarmTemplate') ?? null,
      pauseBetweenPhases: Boolean(params.pauseBetweenPhases),
    });
    broadcastToUser(
      client.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      { swarmId: swarm.id, status: 'created', updatedAt: swarm.updatedAt },
      { protocol: 'v2' },
    );
    respond({ swarm });
  },
  'v2',
);

registerMethod(
  'agent.v2.swarm.list',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    assertAgentRoomEnabled();
    const repo = getSwarmRepository();
    const rawLimit = Number(params.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 100;
    const swarms = repo.listAgentRoomSwarms!(client.userId, limit);
    respond({ swarms });
  },
  'v2',
);

registerMethod(
  'agent.v2.swarm.get',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    assertAgentRoomEnabled();
    const repo = getSwarmRepository();
    const swarm = repo.getAgentRoomSwarm!(requiredString(params, 'id'), client.userId);
    if (!swarm) {
      throw new AgentV2Error('Swarm not found.', 'NOT_FOUND');
    }
    respond({ swarm });
  },
  'v2',
);

registerMethod(
  'agent.v2.swarm.update',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    assertAgentRoomEnabled();
    const repo = getSwarmRepository();
    const id = requiredString(params, 'id');
    const patch: Parameters<NonNullable<typeof repo.updateAgentRoomSwarm>>[2] = {};

    const sessionId = optionalString(params, 'sessionId');
    if (sessionId !== undefined) patch.sessionId = sessionId;
    const title = optionalBoundedString(params, 'title', MAX_TITLE_CHARS);
    if (title !== undefined) patch.title = title;
    const task = optionalBoundedString(params, 'task', MAX_TASK_CHARS);
    if (task !== undefined) patch.task = task;
    const leadPersonaId = optionalString(params, 'leadPersonaId');
    if (leadPersonaId !== undefined) {
      ensurePersonaExists(leadPersonaId);
      patch.leadPersonaId = leadPersonaId;
    }
    if (params.units !== undefined) {
      const units = parseUnits(params, 'units');
      units.forEach((unit) => ensurePersonaExists(unit.personaId));
      patch.units = units;
    }
    const status = optionalString(params, 'status');
    if (status !== undefined) {
      if (
        status !== 'idle' &&
        status !== 'running' &&
        status !== 'hold' &&
        status !== 'completed' &&
        status !== 'aborted' &&
        status !== 'error'
      ) {
        throw new AgentV2Error('Invalid swarm status.', 'INVALID_REQUEST');
      }
      patch.status = status;
    }
    const currentPhase = optionalString(params, 'currentPhase');
    if (currentPhase !== undefined) {
      if (
        currentPhase !== 'analysis' &&
        currentPhase !== 'ideation' &&
        currentPhase !== 'critique' &&
        currentPhase !== 'best_case' &&
        currentPhase !== 'result'
      ) {
        throw new AgentV2Error('Invalid swarm phase.', 'INVALID_REQUEST');
      }
      patch.currentPhase = currentPhase;
    }
    if (params.consensusScore !== undefined) {
      const consensusScore = Number(params.consensusScore);
      if (!Number.isFinite(consensusScore) || consensusScore < 0 || consensusScore > 100) {
        throw new AgentV2Error('consensusScore must be between 0 and 100.', 'INVALID_REQUEST');
      }
      patch.consensusScore = consensusScore;
    }
    if (params.holdFlag !== undefined) {
      patch.holdFlag = Boolean(params.holdFlag);
    }
    if (params.artifact !== undefined) {
      patch.artifact = requiredBoundedString(params, 'artifact', MAX_TASK_CHARS);
    }
    if (params.artifactHistory !== undefined) {
      if (!Array.isArray(params.artifactHistory)) {
        throw new AgentV2Error('artifactHistory must be an array.', 'INVALID_REQUEST');
      }
      const history = params.artifactHistory.map((entry) => String(entry || ''));
      if (JSON.stringify(history).length > MAX_TASK_CHARS * 4) {
        throw new AgentV2Error('artifactHistory payload is too large.', 'INVALID_REQUEST');
      }
      patch.artifactHistory = history;
    }
    const friction = parseFriction(params, 'friction');
    if (friction !== undefined) {
      patch.friction = friction;
    }
    if (params.searchEnabled !== undefined) {
      patch.searchEnabled = Boolean(params.searchEnabled);
    }
    if (params.swarmTemplate !== undefined) {
      patch.swarmTemplate = optionalString(params, 'swarmTemplate') ?? null;
    }
    if (params.pauseBetweenPhases !== undefined) {
      patch.pauseBetweenPhases = Boolean(params.pauseBetweenPhases);
    }
    if (params.lastSeq !== undefined) {
      const lastSeq = Number(params.lastSeq);
      if (!Number.isFinite(lastSeq) || lastSeq < 0) {
        throw new AgentV2Error('lastSeq must be a non-negative number.', 'INVALID_REQUEST');
      }
      patch.lastSeq = Math.floor(lastSeq);
    }

    const updated = repo.updateAgentRoomSwarm!(id, client.userId, patch);
    if (!updated) {
      throw new AgentV2Error('Swarm not found.', 'NOT_FOUND');
    }
    broadcastToUser(
      client.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      { swarmId: updated.id, status: 'updated', updatedAt: updated.updatedAt },
      { protocol: 'v2' },
    );
    respond({ swarm: updated });
  },
  'v2',
);

registerMethod(
  'agent.v2.swarm.delete',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    assertAgentRoomEnabled();
    const repo = getSwarmRepository();
    const id = requiredString(params, 'id');
    const deleted = repo.deleteAgentRoomSwarm!(id, client.userId);
    if (!deleted) {
      throw new AgentV2Error('Swarm not found.', 'NOT_FOUND');
    }
    broadcastToUser(
      client.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      { swarmId: id, status: 'deleted', updatedAt: new Date().toISOString() },
      { protocol: 'v2' },
    );
    respond({ deleted: true });
  },
  'v2',
);

/**
 * agent.v2.swarm.deploy
 *
 * Starts or resumes server-side orchestration for a swarm.
 * The SwarmOrchestratorRuntime (swarmRuntime.ts) picks it up on the next tick.
 *
 * Allowed source statuses: idle | error | aborted | hold
 * If resume=true and status was 'hold', keeps currentPhase (partial resume).
 */
registerMethod(
  'agent.v2.swarm.deploy',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    assertAgentRoomEnabled();
    const repo = getSwarmRepository();
    const id = requiredString(params, 'id');

    const swarm = repo.getAgentRoomSwarm!(id, client.userId);
    if (!swarm) {
      throw new AgentV2Error('Swarm not found.', 'NOT_FOUND');
    }

    const resumable = ['idle', 'error', 'aborted', 'hold'];
    if (!resumable.includes(swarm.status)) {
      throw new AgentV2Error(
        `Cannot deploy swarm in status '${swarm.status}'. Must be one of: ${resumable.join(', ')}.`,
        'INVALID_REQUEST',
      );
    }

    const isResume = swarm.status === 'hold';

    const patch: Parameters<NonNullable<typeof repo.updateAgentRoomSwarm>>[2] = {
      status: 'running',
      holdFlag: false,
      currentDeployCommandId: null,
    };

    // Fresh deploy: reset phase to analysis and clear artifact progress
    if (!isResume) {
      patch.currentPhase = 'analysis';
      patch.lastSeq = 0;
    }

    const updated = repo.updateAgentRoomSwarm!(id, client.userId, patch);
    if (!updated) {
      throw new AgentV2Error('Swarm not found.', 'NOT_FOUND');
    }

    broadcastToUser(
      client.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      { swarmId: id, status: 'updated', updatedAt: new Date().toISOString() },
      { protocol: 'v2' },
    );

    respond({ swarm: updated });
  },
  'v2',
);
