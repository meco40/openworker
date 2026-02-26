'use client';

/**
 * useSwarmActions — CRUD + control actions for swarms.
 */

import { useCallback, useState } from 'react';
import type { AgentV2GatewayClient } from '@/modules/gateway/ws-agent-v2-client';
import { getNextSwarmPhase } from '@/modules/agent-room/swarmPhases';
import type {
  CreateSwarmInput,
  SwarmRecord,
  SwarmStatus,
  SwarmUnit,
  UpdateSwarmInput,
} from '@/modules/agent-room/swarmTypes';
import { parseSwarmRecord } from '@/modules/agent-room/swarmTypes';
import {
  shouldFallbackToSessionSnapshot,
  isTransientGatewayConnectionError,
} from '@/modules/agent-room/utils';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';

type AgentRoomDeployState = 'idle' | 'deploying';

interface ListSwarmsResponse {
  swarms: unknown[];
}

interface SwarmResponse {
  swarm: unknown;
}

interface ReplayResponse {
  events: AgentV2EventEnvelope[];
  nextSeq: number;
}

function normalizeSwarmList(payload: unknown): SwarmRecord[] {
  const list = (payload as ListSwarmsResponse)?.swarms;
  if (!Array.isArray(list)) return [];
  return list.map(parseSwarmRecord).filter((item): item is SwarmRecord => Boolean(item));
}

function normalizeSingleSwarm(payload: unknown): SwarmRecord | null {
  return parseSwarmRecord((payload as SwarmResponse)?.swarm);
}

function mergeSwarmPatch(base: SwarmRecord, patch: UpdateSwarmInput): SwarmRecord {
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

async function replaySessionTail(
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

interface SwarmActionsInput {
  clientRef: React.RefObject<AgentV2GatewayClient | null>;
  swarmsRef: React.RefObject<SwarmRecord[]>;
  sessionToSwarmRef: React.RefObject<Map<string, string>>;
  swarms: SwarmRecord[];
  personaIds: Set<string>;
  setSwarms: React.Dispatch<React.SetStateAction<SwarmRecord[]>>;
  setSelectedSwarmId: React.Dispatch<React.SetStateAction<string | null>>;
  upsertSwarm: (swarm: SwarmRecord) => void;
  removeSwarm: (swarmId: string) => void;
}

export function useSwarmActions(input: SwarmActionsInput) {
  const {
    clientRef,
    swarmsRef,
    sessionToSwarmRef,
    swarms,
    personaIds,
    setSwarms,
    setSelectedSwarmId,
    upsertSwarm,
    removeSwarm,
  } = input;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deployState, setDeployState] = useState<AgentRoomDeployState>('idle');

  const updateSwarmLocal = useCallback(
    (swarmId: string, patch: UpdateSwarmInput): SwarmRecord | null => {
      let updated: SwarmRecord | null = null;
      setSwarms((previous) =>
        previous.map((item) => {
          if (item.id !== swarmId) return item;
          updated = mergeSwarmPatch(item, patch);
          return updated;
        }),
      );
      return updated;
    },
    [setSwarms],
  );

  const syncSwarm = useCallback(
    async (swarmId: string, patch: UpdateSwarmInput): Promise<SwarmRecord | null> => {
      const client = clientRef.current;
      if (!client) return null;
      const payload = (await client.request('agent.v2.swarm.update', {
        id: swarmId,
        ...patch,
      })) as SwarmResponse;
      const updated = normalizeSingleSwarm(payload);
      if (updated) {
        upsertSwarm(updated);
        if (updated.sessionId) {
          sessionToSwarmRef.current.set(updated.sessionId, updated.id);
        }
      }
      return updated;
    },
    [clientRef, upsertSwarm, sessionToSwarmRef],
  );

  const loadCatalog = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const payload = await client.request('agent.v2.swarm.list', { limit: 100 });
      if (clientRef.current !== client) return;
      const nextSwarms = normalizeSwarmList(payload);
      setSwarms(nextSwarms);
      sessionToSwarmRef.current.clear();
      for (const swarm of nextSwarms) {
        if (swarm.sessionId) {
          sessionToSwarmRef.current.set(swarm.sessionId, swarm.id);
        }
      }
      if (nextSwarms.length > 0) {
        setSelectedSwarmId((previous) => previous || nextSwarms[0].id);
      }
    } catch (loadError) {
      if (clientRef.current !== client) return;
      if (isTransientGatewayConnectionError(loadError)) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : 'Swarm catalog load failed.');
    } finally {
      const stillActiveClient = clientRef.current === client;
      if (stillActiveClient) {
        setLoading(false);
      }
    }
  }, [clientRef, setSelectedSwarmId, setSwarms, sessionToSwarmRef]);

  const createSwarm = useCallback(
    async (swarmInput: CreateSwarmInput): Promise<SwarmRecord | null> => {
      const client = clientRef.current;
      if (!client) return null;
      setError(null);
      const leadPersonaId = String(swarmInput.leadPersonaId || '').trim();
      if (!leadPersonaId || !personaIds.has(leadPersonaId)) {
        setError('Lead persona is required.');
        return null;
      }
      const units = swarmInput.units.filter((unit) => personaIds.has(unit.personaId));
      if (units.length === 0) {
        setError('At least one swarm unit is required.');
        return null;
      }
      try {
        const payload = (await client.request('agent.v2.swarm.create', {
          title: swarmInput.title,
          task: swarmInput.task,
          leadPersonaId,
          units,
          conversationId: swarmInput.conversationId || undefined,
          searchEnabled: Boolean(swarmInput.searchEnabled),
          swarmTemplate: swarmInput.swarmTemplate ?? null,
          pauseBetweenPhases: Boolean(swarmInput.pauseBetweenPhases),
        })) as SwarmResponse;
        const created = normalizeSingleSwarm(payload);
        if (created) {
          upsertSwarm(created);
          setSelectedSwarmId(created.id);
          if (created.sessionId) {
            sessionToSwarmRef.current.set(created.sessionId, created.id);
          }
        }
        return created;
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : 'Failed to create swarm.');
        return null;
      }
    },
    [clientRef, personaIds, setSelectedSwarmId, upsertSwarm, sessionToSwarmRef],
  );

  const deploySwarm = useCallback(
    async (swarmId: string): Promise<void> => {
      const client = clientRef.current;
      if (!client) return;
      const target = swarmsRef.current.find((item) => item.id === swarmId);
      if (!target) return;
      setDeployState('deploying');
      setError(null);
      try {
        const result = (await client.request('agent.v2.swarm.deploy', {
          id: swarmId,
        })) as { swarm?: unknown };
        if (result?.swarm) {
          const parsed = parseSwarmRecord(result.swarm);
          if (parsed) {
            updateSwarmLocal(swarmId, { status: 'running' });
            if (parsed.sessionId) {
              sessionToSwarmRef.current.set(parsed.sessionId, swarmId);
            }
          }
        }
      } catch (deployError) {
        setError(deployError instanceof Error ? deployError.message : 'Deploy failed.');
      } finally {
        setDeployState('idle');
      }
    },
    [clientRef, swarmsRef, updateSwarmLocal, sessionToSwarmRef],
  );

  const steerSwarm = useCallback(
    async (swarmId: string, guidance: string, targetPersonaId?: string): Promise<void> => {
      const client = clientRef.current;
      if (!client) return;
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm?.sessionId) return;
      try {
        // C2: If a target persona is specified, set a speaker override
        // so the next turn uses that agent
        if (targetPersonaId && swarm.units.some((u) => u.personaId === targetPersonaId)) {
          await client.request('agent.v2.swarm.update', {
            id: swarmId,
            speakerOverride: targetPersonaId,
          });
        }

        await client.request('agent.v2.session.follow_up', {
          sessionId: swarm.sessionId,
          content: `[OPERATOR GUIDANCE]\n${guidance}`,
          idempotencyKey: `steer:${swarm.id}:${Date.now()}`,
        });
      } catch (steerError) {
        setError(steerError instanceof Error ? steerError.message : 'Failed to send guidance.');
      }
    },
    [clientRef, swarms],
  );

  const addSwarmUnit = useCallback(
    async (swarmId: string, unit: SwarmUnit): Promise<void> => {
      if (!personaIds.has(unit.personaId)) {
        setError('Unknown persona for swarm unit.');
        return;
      }
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm) return;
      const alreadyIncluded = swarm.units.some((existing) => existing.personaId === unit.personaId);
      if (alreadyIncluded) return;
      try {
        await syncSwarm(swarmId, { units: [...swarm.units, unit] });
      } catch (addUnitError) {
        setError(addUnitError instanceof Error ? addUnitError.message : 'Failed to add persona.');
      }
    },
    [personaIds, swarms, syncSwarm],
  );

  const abortSwarm = useCallback(
    async (swarmId: string): Promise<void> => {
      const client = clientRef.current;
      if (!client) return;
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm) return;
      try {
        if (swarm.sessionId) {
          await client.request('agent.v2.session.abort', {
            sessionId: swarm.sessionId,
            reason: 'Abort requested from Agent Room.',
            idempotencyKey: `abort:${swarm.id}`,
          });
        }
        await syncSwarm(swarmId, { status: 'aborted', holdFlag: true });
      } catch (abortError) {
        setError(abortError instanceof Error ? abortError.message : 'Failed to abort swarm.');
      }
    },
    [clientRef, swarms, syncSwarm],
  );

  const forceNextPhase = useCallback(
    async (swarmId: string): Promise<void> => {
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm) return;
      const nextPhase = getNextSwarmPhase(swarm.currentPhase);
      if (!nextPhase) return;
      try {
        await syncSwarm(swarmId, { currentPhase: nextPhase, status: 'running' });
      } catch (phaseError) {
        setError(phaseError instanceof Error ? phaseError.message : 'Failed to advance phase.');
      }
    },
    [swarms, syncSwarm],
  );

  const forceComplete = useCallback(
    async (swarmId: string): Promise<void> => {
      try {
        await syncSwarm(swarmId, {
          status: 'completed',
          currentPhase: 'result',
          consensusScore: 100,
          holdFlag: false,
        });
      } catch (completeError) {
        setError(
          completeError instanceof Error ? completeError.message : 'Failed to complete swarm.',
        );
      }
    },
    [syncSwarm],
  );

  const deleteSwarm = useCallback(
    async (swarmId: string): Promise<void> => {
      const client = clientRef.current;
      if (!client) return;
      try {
        await client.request('agent.v2.swarm.delete', { id: swarmId });
        removeSwarm(swarmId);
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete swarm.');
      }
    },
    [clientRef, removeSwarm],
  );

  const rehydrateSwarm = useCallback(
    async (swarm: SwarmRecord): Promise<void> => {
      const client = clientRef.current;
      if (!client || !swarm.sessionId) return;
      try {
        const nextSeq = await replaySessionTail(client, swarm);
        if (nextSeq > swarm.lastSeq) {
          await syncSwarm(swarm.id, { lastSeq: nextSeq });
        }
      } catch (rehydrateError) {
        setError(
          rehydrateError instanceof Error
            ? rehydrateError.message
            : 'Failed to recover swarm session state.',
        );
      }
    },
    [clientRef, syncSwarm],
  );

  /** Fork an existing swarm — creates a clone at the current phase with inherited artifact. */
  const forkSwarm = useCallback(
    async (swarmId: string, title?: string): Promise<SwarmRecord | null> => {
      const client = clientRef.current;
      if (!client) return null;
      try {
        const payload = (await client.request('agent.v2.swarm.fork', {
          id: swarmId,
          ...(title ? { title } : {}),
        })) as SwarmResponse | null;
        const forked = normalizeSingleSwarm(payload);
        if (forked) {
          upsertSwarm(forked);
          setSelectedSwarmId(forked.id);
        }
        return forked;
      } catch (forkError) {
        setError(forkError instanceof Error ? forkError.message : 'Failed to fork swarm.');
        return null;
      }
    },
    [clientRef, upsertSwarm, setSelectedSwarmId],
  );

  /** Chain a new swarm from a completed swarm's output — Swarm-of-Swarms pipeline. */
  const chainSwarm = useCallback(
    async (sourceSwarmId: string, task: string, title?: string): Promise<SwarmRecord | null> => {
      const client = clientRef.current;
      if (!client) return null;
      try {
        const payload = (await client.request('agent.v2.swarm.chain', {
          sourceSwarmId,
          task,
          ...(title ? { title } : {}),
        })) as SwarmResponse | null;
        const chained = normalizeSingleSwarm(payload);
        if (chained) {
          upsertSwarm(chained);
          setSelectedSwarmId(chained.id);
        }
        return chained;
      } catch (chainError) {
        setError(chainError instanceof Error ? chainError.message : 'Failed to chain swarm.');
        return null;
      }
    },
    [clientRef, upsertSwarm, setSelectedSwarmId],
  );

  const handleAgentEvent = useCallback(
    (event: AgentV2EventEnvelope) => {
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
      // delegated to the connection's onAgentEventRef
    },
    [sessionToSwarmRef, updateSwarmLocal],
  );

  return {
    loading,
    error,
    deployState,
    loadCatalog,
    createSwarm,
    deploySwarm,
    steerSwarm,
    addSwarmUnit,
    abortSwarm,
    forceNextPhase,
    forceComplete,
    deleteSwarm,
    forkSwarm,
    chainSwarm,
    rehydrateSwarm,
    updateSwarmLocal,
    handleAgentEvent,
  };
}
