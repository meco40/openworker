'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentV2GatewayClient } from '@/modules/gateway/ws-agent-v2-client';
import { useSwarmCatalogState } from '@/modules/agent-room/hooks/useSwarmCatalogState';
import { getNextSwarmPhase, type SwarmPhase } from '@/modules/agent-room/swarmPhases';
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

const isAgentRoomEnabled =
  String(process.env.NEXT_PUBLIC_AGENT_ROOM_ENABLED || 'true').toLowerCase() === 'true';
const MAX_ARTIFACT_CHARS = 20_000;
const MAX_ARTIFACT_HISTORY_JSON_CHARS = 28_000;

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

interface ReplayCommandState {
  nextSeq: number;
  text: string;
  completed: boolean;
  failed: boolean;
  errorMessage: string | null;
}

export function clampArtifactForPersistence(value: string, maxChars = MAX_ARTIFACT_CHARS): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(normalized.length - maxChars);
}

export function trimArtifactHistoryForPayload(
  history: string[],
  maxJsonChars = MAX_ARTIFACT_HISTORY_JSON_CHARS,
): string[] {
  if (!Array.isArray(history) || history.length === 0) return [];
  const next = history.filter((entry) => String(entry || '').trim().length > 0);
  while (next.length > 0 && JSON.stringify(next).length > maxJsonChars) {
    next.shift();
  }
  return next;
}

export function consumeReplayForCommand(params: {
  events: AgentV2EventEnvelope[];
  commandId: string;
  fromSeq: number;
  text: string;
}): ReplayCommandState {
  const commandId = String(params.commandId || '').trim();
  let nextSeq = Math.max(0, Math.floor(params.fromSeq || 0));
  let text = String(params.text || '');
  let completed = false;
  let failed = false;
  let errorMessage: string | null = null;

  for (const event of params.events) {
    if (!event || typeof event.seq !== 'number') continue;
    if (event.seq > nextSeq) nextSeq = event.seq;
    if (event.commandId !== commandId) continue;

    if (event.type === 'agent.v2.model.delta') {
      const delta = String((event.payload as { delta?: unknown })?.delta || '');
      if (delta) text += delta;
      continue;
    }

    if (event.type === 'agent.v2.error') {
      failed = true;
      const message = String((event.payload as { message?: unknown })?.message || '').trim();
      errorMessage = message || 'Phase command failed.';
      continue;
    }

    if (event.type === 'agent.v2.command.completed') {
      const status = String((event.payload as { status?: unknown })?.status || '').trim();
      if (status === 'failed' || status === 'failed_recoverable' || status === 'aborted') {
        failed = true;
        errorMessage = `Phase command ended with status: ${status}`;
      } else {
        const resultMessage = String(
          ((event.payload as { result?: { message?: unknown } })?.result?.message as string) || '',
        ).trim();
        if (!text.trim() && resultMessage) {
          text = resultMessage;
        }
        completed = true;
      }
    }
  }

  return { nextSeq, text, completed, failed, errorMessage };
}

export function buildPhaseIdempotencyKey(swarmId: string, phase: SwarmPhase): string {
  return `${swarmId}:${phase}`;
}

export function getPhaseCommandMethod(
  phase: SwarmPhase,
): 'agent.v2.session.input' | 'agent.v2.session.follow_up' {
  return phase === 'analysis' ? 'agent.v2.session.input' : 'agent.v2.session.follow_up';
}

export function shouldFallbackToSessionSnapshot(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /REPLAY_WINDOW_EXPIRED|Replay window expired/i.test(message);
}

export function isRateLimitedGatewayError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '').trim()
      : '';
  if (code === 'RATE_LIMITED') return true;
  const message = error instanceof Error ? error.message : String(error || '');
  return /too many requests/i.test(message);
}

export function isTransientGatewayConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /websocket not connected|client disconnected|failed to connect/i.test(message);
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
  /** Maps commandId → { personaId, phase } — populated synchronously on swarm broadcast */
  const commandToInfoRef = useRef<Map<string, { personaId: string; phase: string }>>(new Map());
  const swarmsRef = useRef<SwarmRecord[]>([]);
  /** External subscriber for agent events (e.g. SwarmChatFeed delta streaming) */
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
        // Server-side orchestration: just signal the swarm as running.
        // SwarmOrchestratorRuntime picks it up on the next tick.
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
        // Send guidance as a follow_up (not steer) so it doesn't interrupt the
        // current AI command and does NOT corrupt the artifact.
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
      return JSON.stringify(swarm, null, 2);
    },
    [swarms],
  );

  /**
   * Synchronous ref-based swarm lookup by sessionId.
   * Never stale — uses refs, not React state — safe to call inside event handlers
   * that fire before React re-renders have flushed.
   */
  const lookupSwarmBySessionId = useCallback((sessionId: string): SwarmRecord | undefined => {
    const swarmId = sessionToSwarmRef.current.get(sessionId);
    if (!swarmId) return undefined;
    return swarmsRef.current.find((s) => s.id === swarmId);
  }, []);

  /**
   * Look up the persona ID and phase registered for a commandId.
   * Returns null if unknown (e.g. legacy swarms or dispatch broadcast not yet received).
   */
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
      // Forward to external subscriber (e.g. SwarmChatFeed for delta streaming)
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

    // Subscribe to server-push swarm state updates.
    // Fixes: (1) stale swarm status/phase/artifact in UI after orchestrator ticks,
    // (2) sessionToSwarmRef stays empty when session is created lazily — without
    // this, every agent.v2.model.delta/command.completed event gets dropped.
    const unsubscribeSwarm = client.onSwarmEvent((raw) => {
      const payload = raw as {
        swarmId?: string;
        sessionId?: string;
        commandId?: string;
        currentPhase?: string;
        leadPersonaId?: string;
        agentPersonaId?: string;
      };
      const swarmId = payload?.swarmId;
      if (!swarmId) return;

      // Synchronously register sessionId → swarmId BEFORE any async work.
      // This ensures agent.v2.command.started events are not dropped due to
      // the mapping being absent when the event arrives milliseconds later.
      if (payload.sessionId) {
        sessionToSwarmRef.current.set(payload.sessionId, swarmId);
        // Also patch the in-memory React state so ref-based lookups resolve correctly.
        updateSwarmLocal(swarmId, { sessionId: payload.sessionId });
      }

      // Synchronously register commandId → { personaId, phase } so that
      // agent.v2.command.started handlers can identify which persona is streaming.
      if (payload.commandId && payload.agentPersonaId) {
        commandToInfoRef.current.set(payload.commandId, {
          personaId: String(payload.agentPersonaId),
          phase: String(payload.currentPhase || ''),
        });
      }

      // Async: fetch full swarm record (artifact, phase, etc.) to update all state.
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
  }, [handleAgentEvent, loadCatalog, updateSwarmLocal, upsertSwarm]);

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
