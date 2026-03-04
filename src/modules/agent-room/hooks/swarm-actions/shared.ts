import type React from 'react';
import { getNextSwarmPhase } from '@/shared/domain/swarmPhases';
import type { AgentV2GatewayClient } from '@/modules/gateway/ws-agent-v2-client';
import type {
  CreateSwarmInput,
  SwarmRecord,
  SwarmStatus,
  SwarmUnit,
  UpdateSwarmInput,
} from '@/modules/agent-room/swarmTypes';
import { parseSwarmRecord } from '@/modules/agent-room/swarmTypes';
import {
  isTransientGatewayConnectionError,
  shouldFallbackToSessionSnapshot,
} from '@/modules/agent-room/utils';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';

export type AgentRoomDeployState = 'idle' | 'deploying';

interface ListSwarmsResponse {
  swarms: unknown[];
}

export interface SwarmResponse {
  swarm: unknown;
}

interface ReplayResponse {
  events: AgentV2EventEnvelope[];
}

export interface SwarmActionCommonInput {
  clientRef: React.RefObject<AgentV2GatewayClient | null>;
  swarmsRef: React.RefObject<SwarmRecord[]>;
  sessionToSwarmRef: React.RefObject<Map<string, string>>;
  swarms: SwarmRecord[];
  personaIds: Set<string>;
  setSwarms: React.Dispatch<React.SetStateAction<SwarmRecord[]>>;
  setSelectedSwarmId: React.Dispatch<React.SetStateAction<string | null>>;
  upsertSwarm: (swarm: SwarmRecord) => void;
  removeSwarm: (swarmId: string) => void;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  updateSwarmLocal: (swarmId: string, patch: UpdateSwarmInput) => SwarmRecord | null;
  syncSwarm: (swarmId: string, patch: UpdateSwarmInput) => Promise<SwarmRecord | null>;
}

export function normalizeSwarmList(payload: unknown): SwarmRecord[] {
  const list = (payload as ListSwarmsResponse)?.swarms;
  if (!Array.isArray(list)) return [];
  return list.map(parseSwarmRecord).filter((item): item is SwarmRecord => Boolean(item));
}

export function normalizeSingleSwarm(payload: unknown): SwarmRecord | null {
  return parseSwarmRecord((payload as SwarmResponse)?.swarm);
}

export function mergeSwarmPatch(base: SwarmRecord, patch: UpdateSwarmInput): SwarmRecord {
  return {
    ...base,
    sessionId: patch.sessionId !== undefined ? (patch.sessionId ?? null) : base.sessionId,
    status: patch.status ?? base.status,
    currentPhase: patch.currentPhase ?? base.currentPhase,
    consensusScore: patch.consensusScore ?? base.consensusScore,
    holdFlag: patch.holdFlag ?? base.holdFlag,
    artifact: patch.artifact ?? base.artifact,
    artifactHistory: patch.artifactHistory ?? base.artifactHistory,
    friction: patch.friction ?? base.friction,
    units: patch.units ?? base.units,
    lastSeq: patch.lastSeq ?? base.lastSeq,
    updatedAt: new Date().toISOString(),
  };
}

export async function replaySessionTail(
  client: AgentV2GatewayClient,
  swarm: SwarmRecord,
): Promise<number> {
  if (!swarm.sessionId) return swarm.lastSeq;
  try {
    const replay = (await client.request('agent.v2.session.replay', {
      sessionId: swarm.sessionId,
      fromSeq: swarm.lastSeq || 0,
    })) as ReplayResponse;
    if (!Array.isArray(replay?.events) || replay.events.length === 0) {
      return swarm.lastSeq;
    }
    return replay.events[replay.events.length - 1].seq;
  } catch (error) {
    if (!shouldFallbackToSessionSnapshot(error)) {
      throw error;
    }
    await client.request('agent.v2.session.get', { sessionId: swarm.sessionId });
    return swarm.lastSeq;
  }
}

export function applySwarmTerminalEvent(
  event: AgentV2EventEnvelope,
  updateSwarmLocal: (swarmId: string, patch: UpdateSwarmInput) => SwarmRecord | null,
  sessionToSwarmRef: React.RefObject<Map<string, string>>,
): void {
  const swarmId = sessionToSwarmRef.current.get(event.sessionId);
  if (!swarmId) return;
  const patch: UpdateSwarmInput = { lastSeq: event.seq };
  if (event.type === 'agent.v2.error') {
    patch.status = 'error';
    patch.holdFlag = true;
  }
  if (event.type === 'agent.v2.session.completed') {
    const status = String((event.payload as { status?: unknown })?.status || 'completed');
    patch.status = (status === 'aborted' ? 'aborted' : 'completed') as SwarmStatus;
    patch.currentPhase = 'result';
  }
  updateSwarmLocal(swarmId, patch);
}

export function validateCreateInput(
  swarmInput: CreateSwarmInput,
  personaIds: Set<string>,
): { leadPersonaId: string; units: SwarmUnit[]; error?: string } {
  const leadPersonaId = String(swarmInput.leadPersonaId || '').trim();
  if (!leadPersonaId || !personaIds.has(leadPersonaId)) {
    return { leadPersonaId, units: [], error: 'Lead persona is required.' };
  }
  const units = swarmInput.units.filter((unit) => personaIds.has(unit.personaId));
  if (units.length === 0) {
    return { leadPersonaId, units, error: 'At least one swarm unit is required.' };
  }
  return { leadPersonaId, units };
}

export function getNextPhaseOrNull(swarm: SwarmRecord): ReturnType<typeof getNextSwarmPhase> {
  return getNextSwarmPhase(swarm.currentPhase);
}

export { isTransientGatewayConnectionError };
