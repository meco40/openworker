'use client';

/**
 * useAgentRoomRuntime — thin compositor hook.
 *
 * Delegates to focused sub-hooks:
 *   useSwarmCatalogState — swarm list + selection state
 *   useSwarmActions      — CRUD, control, agent event handling
 *   useSwarmConnection   — WebSocket lifecycle
 *   useSwarmExport       — JSON / Markdown export
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AgentV2GatewayClient } from '@/modules/gateway/ws-agent-v2-client';
import { useSwarmCatalogState } from '@/modules/agent-room/hooks/useSwarmCatalogState';
import { useSwarmActions } from '@/modules/agent-room/hooks/useSwarmActions';
import { useSwarmConnection } from '@/modules/agent-room/hooks/useSwarmConnection';
import { useSwarmExport } from '@/modules/agent-room/hooks/useSwarmExport';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';
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

export function useAgentRoomRuntime() {
  const { personas } = usePersona();

  // ── Shared refs (owned here, passed to sub-hooks) ──

  const clientRef = useRef<AgentV2GatewayClient | null>(null);
  const sessionToSwarmRef = useRef<Map<string, string>>(new Map());
  const commandToInfoRef = useRef<Map<string, { personaId: string; phase: string }>>(new Map());
  const swarmsRef = useRef<SwarmRecord[]>([]);
  const onAgentEventRef = useRef<((event: AgentV2EventEnvelope) => void) | null>(null);

  // ── Catalog state ──

  const {
    swarms,
    setSwarms,
    selectedSwarm,
    selectedSwarmId,
    setSelectedSwarmId,
    upsertSwarm,
    removeSwarm,
  } = useSwarmCatalogState();

  const personaIds = useMemo(() => new Set(personas.map((p) => p.id)), [personas]);

  useEffect(() => {
    swarmsRef.current = swarms;
  }, [swarms]);

  // ── Actions (CRUD + control) ──

  const actions = useSwarmActions({
    clientRef,
    swarmsRef,
    sessionToSwarmRef,
    swarms,
    personaIds,
    setSwarms,
    setSelectedSwarmId,
    upsertSwarm,
    removeSwarm,
  });
  const {
    loading,
    error,
    deployState,
    loadCatalog,
    createSwarm,
    deploySwarm,
    steerSwarm,
    addSwarmUnit,
    pauseSwarm,
    abortSwarm,
    forceNextPhase,
    forceComplete,
    deleteSwarm,
    forkSwarm,
    chainSwarm,
    rehydrateSwarm,
    handleAgentEvent: handleAgentEventAction,
  } = actions;

  // Wrap handleAgentEvent to also dispatch to onAgentEventRef
  const handleAgentEvent = useCallback(
    (event: AgentV2EventEnvelope) => {
      handleAgentEventAction(event);
      onAgentEventRef.current?.(event);
    },
    [handleAgentEventAction],
  );

  // ── WebSocket connection ──

  const catalogActions = useMemo(() => ({ upsertSwarm, removeSwarm }), [upsertSwarm, removeSwarm]);

  useSwarmConnection({
    enabled: isAgentRoomEnabled,
    clientRef,
    sessionToSwarmRef,
    commandToInfoRef,
    catalogActions,
    loadCatalog,
    handleAgentEvent,
  });

  // ── Rehydrate on swarm selection ──

  useEffect(() => {
    if (!selectedSwarmId) return;
    const swarm = swarmsRef.current.find((s) => s.id === selectedSwarmId);
    if (!swarm || !swarm.sessionId) return;
    void rehydrateSwarm(swarm);
  }, [rehydrateSwarm, selectedSwarmId]);

  // ── Export ──

  const { exportRunJson, exportRunMarkdown } = useSwarmExport(swarms, personas);

  // ── Lookup helpers ──

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
    pauseSwarm,
    abortSwarm,
    forceNextPhase,
    forceComplete,
    deleteSwarm,
    forkSwarm,
    chainSwarm,
    exportRunJson,
    exportRunMarkdown,
    lookupSwarmBySessionId,
    getCommandInfo,
    rehydrateSwarm,
    onAgentEventRef,
  };
}
