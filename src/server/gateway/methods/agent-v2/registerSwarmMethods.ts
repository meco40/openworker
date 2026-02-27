import crypto from 'node:crypto';
import { ChannelType } from '@/shared/domain/types';
import { AgentV2Error } from '@/server/agent-v2/errors';
import type { GatewayClient } from '@/server/gateway/client-registry';
import { registerMethod, type RespondFn } from '@/server/gateway/method-router';
import { getMessageService } from '@/server/channels/messages/runtime';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { GatewayEvents } from '@/server/gateway/events';
import {
  MAX_TASK_CHARS,
  MAX_TITLE_CHARS,
  assertAgentRoomEnabled,
  distinctPersonaIds,
  ensurePersonaExists,
  getSwarmRepository,
  optionalBoundedString,
  optionalString,
  parseUnits,
  requiredBoundedString,
  requiredString,
} from './helpers';

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
      if (!conversation) throw new AgentV2Error('Conversation not found.', 'NOT_FOUND');
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
      { swarmId: swarm.id, status: 'created', swarm, updatedAt: swarm.updatedAt },
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
    if (!swarm) throw new AgentV2Error('Swarm not found.', 'NOT_FOUND');
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

    const serverOnlyFields = ['artifact', 'artifactHistory', 'friction'] as const;
    for (const field of serverOnlyFields) {
      if (params[field] !== undefined) {
        throw new AgentV2Error(
          `'${field}' is managed by the orchestrator and cannot be set via swarm.update.`,
          'INVALID_REQUEST',
        );
      }
    }

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
      const allowedStatuses = ['idle', 'running', 'hold', 'completed', 'aborted', 'error'] as const;
      if (!allowedStatuses.includes(status as (typeof allowedStatuses)[number])) {
        throw new AgentV2Error('Invalid swarm status.', 'INVALID_REQUEST');
      }
      patch.status = status as (typeof allowedStatuses)[number];
    }
    const currentPhase = optionalString(params, 'currentPhase');
    if (currentPhase !== undefined) {
      const allowedPhases = [
        'analysis',
        'research',
        'ideation',
        'critique',
        'best_case',
        'result',
      ] as const;
      if (!allowedPhases.includes(currentPhase as (typeof allowedPhases)[number])) {
        throw new AgentV2Error('Invalid swarm phase.', 'INVALID_REQUEST');
      }
      patch.currentPhase = currentPhase as (typeof allowedPhases)[number];
    }
    if (params.consensusScore !== undefined) {
      const consensusScore = Number(params.consensusScore);
      if (!Number.isFinite(consensusScore) || consensusScore < 0 || consensusScore > 100) {
        throw new AgentV2Error('consensusScore must be between 0 and 100.', 'INVALID_REQUEST');
      }
      patch.consensusScore = consensusScore;
    }
    if (params.holdFlag !== undefined) patch.holdFlag = Boolean(params.holdFlag);
    if (params.searchEnabled !== undefined) patch.searchEnabled = Boolean(params.searchEnabled);
    if (params.swarmTemplate !== undefined)
      patch.swarmTemplate = optionalString(params, 'swarmTemplate') ?? null;
    if (params.pauseBetweenPhases !== undefined)
      patch.pauseBetweenPhases = Boolean(params.pauseBetweenPhases);

    const speakerOverride = optionalString(params, 'speakerOverride');
    if (speakerOverride) {
      ensurePersonaExists(speakerOverride);
      const existing = repo.getAgentRoomSwarm?.(id, client.userId);
      if (existing) {
        const currentBuffer = existing.phaseBuffer ?? [];
        patch.phaseBuffer = [
          ...currentBuffer.filter((e) => e.type !== 'speakerOverride'),
          { type: 'speakerOverride' as const, personaId: speakerOverride },
        ];
      }
    }
    if (params.lastSeq !== undefined) {
      const lastSeq = Number(params.lastSeq);
      if (!Number.isFinite(lastSeq) || lastSeq < 0) {
        throw new AgentV2Error('lastSeq must be a non-negative number.', 'INVALID_REQUEST');
      }
      patch.lastSeq = Math.floor(lastSeq);
    }

    const updated = repo.updateAgentRoomSwarm!(id, client.userId, patch);
    if (!updated) throw new AgentV2Error('Swarm not found.', 'NOT_FOUND');
    broadcastToUser(
      client.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      { swarmId: updated.id, status: 'updated', swarm: updated, updatedAt: updated.updatedAt },
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
    if (!deleted) throw new AgentV2Error('Swarm not found.', 'NOT_FOUND');
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

registerMethod(
  'agent.v2.swarm.fork',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    assertAgentRoomEnabled();
    const repo = getSwarmRepository();
    const messageService = getMessageService();

    const sourceId = requiredString(params, 'id');
    const source = repo.getAgentRoomSwarm!(sourceId, client.userId);
    if (!source) throw new AgentV2Error('Source swarm not found.', 'NOT_FOUND');

    const forkTitle =
      optionalBoundedString(params, 'title', MAX_TITLE_CHARS) ?? `${source.title} (Fork)`;
    const conversation = messageService.getOrCreateConversation(
      ChannelType.AGENT_ROOM,
      `agent-room-${crypto.randomUUID()}`,
      forkTitle,
      client.userId,
    );
    messageService.setPersonaId(conversation.id, source.leadPersonaId, client.userId);

    const forkedSwarm = repo.createAgentRoomSwarm!({
      conversationId: conversation.id,
      userId: client.userId,
      title: forkTitle,
      task: source.task,
      leadPersonaId: source.leadPersonaId,
      units: source.units.map((u) => ({ personaId: u.personaId, role: u.role })),
      currentPhase: source.currentPhase,
      status: 'idle',
      consensusScore: 0,
      holdFlag: false,
      artifact: source.artifact,
      artifactHistory: [...source.artifactHistory],
      friction: {
        level: 'low',
        confidence: 0,
        hold: false,
        reasons: [],
        updatedAt: new Date().toISOString(),
      },
      lastSeq: 0,
      searchEnabled: source.searchEnabled,
      swarmTemplate: source.swarmTemplate,
      pauseBetweenPhases: source.pauseBetweenPhases,
    });

    broadcastToUser(
      client.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      {
        swarmId: forkedSwarm.id,
        status: 'created',
        swarm: forkedSwarm,
        updatedAt: forkedSwarm.updatedAt,
      },
      { protocol: 'v2' },
    );
    respond({ swarm: forkedSwarm, forkedFrom: sourceId });
  },
  'v2',
);

registerMethod(
  'agent.v2.swarm.chain',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    assertAgentRoomEnabled();
    const repo = getSwarmRepository();
    const messageService = getMessageService();
    const sourceId = requiredString(params, 'sourceSwarmId');
    const source = repo.getAgentRoomSwarm!(sourceId, client.userId);
    if (!source) throw new AgentV2Error('Source swarm not found.', 'NOT_FOUND');

    const newTask = requiredBoundedString(params, 'task', MAX_TASK_CHARS);
    const chainTitle =
      optionalBoundedString(params, 'title', MAX_TITLE_CHARS) ?? `${source.title} → Chain`;
    const contextBlock = source.artifact
      ? `\n\n--- Context from previous swarm "${source.title}" ---\n${source.artifact.slice(0, 8000)}\n--- End context ---\n`
      : '';
    const fullTask = `${newTask}${contextBlock}`;

    let units: Array<{ personaId: string; role: string }>;
    let leadPersonaId: string;
    if (params.units !== undefined) {
      units = parseUnits(params, 'units');
      leadPersonaId = requiredString(params, 'leadPersonaId');
      units.forEach((u) => ensurePersonaExists(u.personaId));
    } else {
      units = source.units.map((u) => ({ personaId: u.personaId, role: u.role }));
      leadPersonaId = source.leadPersonaId;
    }
    ensurePersonaExists(leadPersonaId);

    const conversation = messageService.getOrCreateConversation(
      ChannelType.AGENT_ROOM,
      `agent-room-${crypto.randomUUID()}`,
      chainTitle,
      client.userId,
    );
    messageService.setPersonaId(conversation.id, leadPersonaId, client.userId);

    const chainedSwarm = repo.createAgentRoomSwarm!({
      conversationId: conversation.id,
      userId: client.userId,
      title: chainTitle,
      task: fullTask,
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
      searchEnabled: source.searchEnabled,
      swarmTemplate: source.swarmTemplate,
      pauseBetweenPhases: source.pauseBetweenPhases,
    });

    broadcastToUser(
      client.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      {
        swarmId: chainedSwarm.id,
        status: 'created',
        swarm: chainedSwarm,
        updatedAt: chainedSwarm.updatedAt,
      },
      { protocol: 'v2' },
    );
    respond({ swarm: chainedSwarm, chainedFrom: sourceId });
  },
  'v2',
);

registerMethod(
  'agent.v2.swarm.deploy',
  async (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn) => {
    assertAgentRoomEnabled();
    const repo = getSwarmRepository();
    const id = requiredString(params, 'id');

    const swarm = repo.getAgentRoomSwarm!(id, client.userId);
    if (!swarm) throw new AgentV2Error('Swarm not found.', 'NOT_FOUND');
    const resumable = ['idle', 'error', 'aborted', 'hold'];
    if (!resumable.includes(swarm.status)) {
      throw new AgentV2Error(
        `Cannot deploy swarm in status '${swarm.status}'. Must be one of: ${resumable.join(', ')}.`,
        'INVALID_REQUEST',
      );
    }

    const patch: Parameters<NonNullable<typeof repo.updateAgentRoomSwarm>>[2] = {
      status: 'running',
      holdFlag: false,
      currentDeployCommandId: null,
    };
    if (swarm.status !== 'hold') {
      patch.currentPhase = 'analysis';
      patch.lastSeq = 0;
    }

    const updated = repo.updateAgentRoomSwarm!(id, client.userId, patch);
    if (!updated) throw new AgentV2Error('Swarm not found.', 'NOT_FOUND');
    broadcastToUser(
      client.userId,
      GatewayEvents.AGENT_ROOM_SWARM,
      { swarmId: id, status: 'updated', swarm: updated, updatedAt: new Date().toISOString() },
      { protocol: 'v2' },
    );
    respond({ swarm: updated });
  },
  'v2',
);
