'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentV2GatewayClient } from '@/modules/gateway/ws-agent-v2-client';
import { useSwarmCatalogState } from '@/modules/agent-room/hooks/useSwarmCatalogState';
import { getNextSwarmPhase } from '@/modules/agent-room/swarmPhases';
import type {
  CreateSwarmInput,
  SwarmRecord,
  SwarmStatus,
  SwarmUnit,
  UpdateSwarmInput,
} from '@/modules/agent-room/swarmTypes';
import { parseSwarmRecord } from '@/modules/agent-room/swarmTypes';
import { usePersona } from '@/modules/personas/PersonaContext';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';
import {
  clampArtifactForPersistence,
  trimArtifactHistoryForPayload,
  consumeReplayForCommand,
  shouldFallbackToSessionSnapshot,
  isRateLimitedGatewayError,
  isTransientGatewayConnectionError,
  buildPhaseIdempotencyKey,
  getPhaseCommandMethod,
} from '@/modules/agent-room/utils';

// Re-export utilities for backward compatibility
export {
  clampArtifactForPersistence,
  trimArtifactHistoryForPayload,
  consumeReplayForCommand,
  shouldFallbackToSessionSnapshot,
  isRateLimitedGatewayError,
  isTransientGatewayConnectionError,
  buildPhaseIdempotencyKey,
  getPhaseCommandMethod,
};

const isAgentRoomEnabled =
  String(process.env.NEXT_PUBLIC_AGENT_ROOM_ENABLED || 'true').toLowerCase() === 'true';

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

export function useAgentRoomRuntime() {
  const { personas } = usePersona();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deployState, setDeployState] = useState<AgentRoomDeployState>('idle');
  const clientRef = useRef<AgentV2GatewayClient | null>(null);
  const sessionToSwarmRef = useRef<Map<string, string>>(new Map());
  const commandToInfoRef = useRef<Map<string, { personaId: string; phase: string }>>(new Map());
  const swarmsRef = useRef<SwarmRecord[]>([]);
  const onAgentEventRef = useRef<((event: AgentV2EventEnvelope) => void) | null>(null);
  const {
    swarms,
    setSwarms,
    selectedSwarm,
    selectedSwarmId,
    setSelectedSwarmId,
    upsertSwarm,
    removeSwarm,
  } = useSwarmCatalogState();

  const personaIds = useMemo(() => new Set(personas.map((persona) => persona.id)), [personas]);

  useEffect(() => {
    swarmsRef.current = swarms;
  }, [swarms]);

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
    [upsertSwarm],
  );

  const loadCatalog = useCallback(async () => {
    if (!isAgentRoomEnabled) return;
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
  }, [setSelectedSwarmId, setSwarms]);

  const createSwarm = useCallback(
    async (input: CreateSwarmInput): Promise<SwarmRecord | null> => {
      if (!isAgentRoomEnabled) return null;
      const client = clientRef.current;
      if (!client) return null;
      setError(null);

      const leadPersonaId = String(input.leadPersonaId || '').trim();
      if (!leadPersonaId || !personaIds.has(leadPersonaId)) {
        setError('Lead persona is required.');
        return null;
      }
      const units = input.units.filter((unit) => personaIds.has(unit.personaId));
      if (units.length === 0) {
        setError('At least one swarm unit is required.');
        return null;
      }
      try {
        const payload = (await client.request('agent.v2.swarm.create', {
          title: input.title,
          task: input.task,
          leadPersonaId,
          units,
          conversationId: input.conversationId || undefined,
          searchEnabled: Boolean(input.searchEnabled),
          swarmTemplate: input.swarmTemplate ?? null,
          pauseBetweenPhases: Boolean(input.pauseBetweenPhases),
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
    [personaIds, setSelectedSwarmId, upsertSwarm],
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
    [updateSwarmLocal],
  );

  const steerSwarm = useCallback(
    async (swarmId: string, guidance: string): Promise<void> => {
      const client = clientRef.current;
      if (!client) return;
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm?.sessionId) return;
      try {
        await client.request('agent.v2.session.follow_up', {
          sessionId: swarm.sessionId,
          content: `[OPERATOR GUIDANCE]\n${guidance}`,
          idempotencyKey: `steer:${swarm.id}:${Date.now()}`,
        });
      } catch (steerError) {
        setError(steerError instanceof Error ? steerError.message : 'Failed to send guidance.');
      }
    },
    [swarms],
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
        await syncSwarm(swarmId, {
          units: [...swarm.units, unit],
        });
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
    [swarms, syncSwarm],
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
    [removeSwarm],
  );

  const exportRunJson = useCallback(
    (swarmId: string): string | null => {
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm) return null;

      const participants = swarm.units.map((unit) => {
        const persona = personas.find((p) => p.id === unit.personaId);
        return {
          personaId: unit.personaId,
          name: persona?.name ?? 'Unknown',
          role: unit.role,
        };
      });

      const turnPattern = /\*\*\[([^\]]+)\]:\*\*\s*([\s\S]*?)(?=\*\*\[[^\]]+\]:\*\*|$)/g;
      const turns: Array<{ speaker: string; content: string }> = [];
      let tm: RegExpExecArray | null;
      const artifactText = swarm.artifact || '';
      while ((tm = turnPattern.exec(artifactText))) {
        turns.push({ speaker: tm[1].trim(), content: tm[2].trim() });
      }

      const leadPersona = personas.find((p) => p.id === swarm.leadPersonaId);
      const exportData = {
        id: swarm.id,
        title: swarm.title,
        task: swarm.task,
        status: swarm.status,
        currentPhase: swarm.currentPhase,
        consensusScore: swarm.consensusScore,
        leadPersona: leadPersona
          ? { id: leadPersona.id, name: leadPersona.name }
          : { id: swarm.leadPersonaId, name: 'Unknown' },
        participants,
        artifact: swarm.artifact,
        turns,
        friction: swarm.friction,
        createdAt: swarm.createdAt,
        updatedAt: swarm.updatedAt,
      };
      return JSON.stringify(exportData, null, 2);
    },
    [swarms, personas],
  );

  const lookupSwarmBySessionId = useCallback((sessionId: string): SwarmRecord | undefined => {
    const swarmId = sessionToSwarmRef.current.get(sessionId);
    if (!swarmId) return undefined;
    return swarmsRef.current.find((s) => s.id === swarmId);
  }, []);

  const getCommandInfo = useCallback(
    (commandId: string): { personaId: string; phase: string } | null =>
      commandToInfoRef.current.get(commandId) ?? null,
    [],
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
    [syncSwarm],
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
      onAgentEventRef.current?.(event);
    },
    [updateSwarmLocal],
  );

  useEffect(() => {
    if (!isAgentRoomEnabled) return;
    const client = new AgentV2GatewayClient();
    const sessionToSwarmMap = sessionToSwarmRef.current;
    clientRef.current = client;
    client.connect();
    const unsubscribe = client.onEvent(handleAgentEvent);

    const unsubscribeSwarm = client.onSwarmEvent((raw) => {
      const payload = raw as {
        swarmId?: string;
        status?: string;
        swarm?: unknown;
        sessionId?: string;
        commandId?: string;
        currentPhase?: string;
        leadPersonaId?: string;
        agentPersonaId?: string;
      };
      const swarmId = payload?.swarmId;
      if (!swarmId) return;

      // Handle deletion events
      if (payload.status === 'deleted') {
        removeSwarm(swarmId);
        return;
      }

      if (payload.sessionId) {
        sessionToSwarmRef.current.set(payload.sessionId, swarmId);
      }

      if (payload.commandId && payload.agentPersonaId) {
        commandToInfoRef.current.set(payload.commandId, {
          personaId: String(payload.agentPersonaId),
          phase: String(payload.currentPhase || ''),
        });
      }

      // If the broadcast includes the full swarm record, use it directly
      // instead of making a round-trip swarm.get request
      if (payload.swarm) {
        const parsed = parseSwarmRecord(payload.swarm);
        if (parsed) {
          upsertSwarm(parsed);
          if (parsed.sessionId) {
            sessionToSwarmRef.current.set(parsed.sessionId, parsed.id);
          }
          return;
        }
      }

      // Fallback: fetch from server (backward compat with older server versions)
      void (async () => {
        try {
          const res = await client.request('agent.v2.swarm.get', { id: swarmId });
          const fresh = parseSwarmRecord((res as { swarm?: unknown })?.swarm ?? res);
          if (fresh) {
            upsertSwarm(fresh);
            if (fresh.sessionId) {
              sessionToSwarmRef.current.set(fresh.sessionId, fresh.id);
            }
          }
        } catch {
          // Swarm may have been deleted — ignore
        }
      })();
    });

    void loadCatalog();
    return () => {
      unsubscribe();
      unsubscribeSwarm();
      client.disconnect();
      clientRef.current = null;
      sessionToSwarmMap.clear();
    };
  }, [handleAgentEvent, loadCatalog, removeSwarm, updateSwarmLocal, upsertSwarm]);

  useEffect(() => {
    if (!selectedSwarm || !selectedSwarm.sessionId) return;
    void rehydrateSwarm(selectedSwarm);
  }, [rehydrateSwarm, selectedSwarm]);

  return {
    enabled: isAgentRoomEnabled,
    swarms,
    selectedSwarmId,
    selectedSwarm,
    loading,
    error,
    deployState,
    setSelectedSwarmId,
    loadCatalog,
    createSwarm,
    deploySwarm,
    steerSwarm,
    addSwarmUnit,
    abortSwarm,
    forceNextPhase,
    forceComplete,
    deleteSwarm,
    exportRunJson,
    lookupSwarmBySessionId,
    getCommandInfo,
    rehydrateSwarm,
    onAgentEventRef,
  };
}
