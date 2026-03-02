'use client';

/**
 * useSwarmActions — Facade that composes catalog, execution and coordination actions.
 */

import { useCallback, useMemo, useState } from 'react';
import type { AgentV2GatewayClient } from '@/modules/gateway/ws-agent-v2-client';
import type {
  CreateSwarmInput,
  SwarmRecord,
  UpdateSwarmInput,
} from '@/modules/agent-room/swarmTypes';
import {
  mergeSwarmPatch,
  normalizeSingleSwarm,
  type SwarmActionCommonInput,
  type SwarmResponse,
} from '@/modules/agent-room/hooks/swarm-actions/shared';
import { useSwarmCatalogActions } from '@/modules/agent-room/hooks/swarm-actions/useSwarmCatalogActions';
import { useSwarmExecutionActions } from '@/modules/agent-room/hooks/swarm-actions/useSwarmExecutionActions';
import { useSwarmCoordinationActions } from '@/modules/agent-room/hooks/swarm-actions/useSwarmCoordinationActions';

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

  const [error, setError] = useState<string | null>(null);

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
    [clientRef, sessionToSwarmRef, upsertSwarm],
  );

  const commonInput = useMemo<SwarmActionCommonInput>(
    () => ({
      clientRef,
      swarmsRef,
      sessionToSwarmRef,
      swarms,
      personaIds,
      setSwarms,
      setSelectedSwarmId,
      upsertSwarm,
      removeSwarm,
      setError,
      updateSwarmLocal,
      syncSwarm,
    }),
    [
      clientRef,
      personaIds,
      removeSwarm,
      sessionToSwarmRef,
      setSelectedSwarmId,
      setSwarms,
      swarms,
      swarmsRef,
      syncSwarm,
      updateSwarmLocal,
      upsertSwarm,
    ],
  );

  const { loading, loadCatalog, createSwarm } = useSwarmCatalogActions(commonInput);
  const {
    deployState,
    deploySwarm,
    pauseSwarm,
    abortSwarm,
    forceNextPhase,
    forceComplete,
    rehydrateSwarm,
    handleAgentEvent,
  } = useSwarmExecutionActions(commonInput);
  const { steerSwarm, addSwarmUnit, deleteSwarm, forkSwarm, chainSwarm } =
    useSwarmCoordinationActions(commonInput);

  const createSwarmWithInput = useCallback(
    async (swarmInput: CreateSwarmInput) => createSwarm(swarmInput),
    [createSwarm],
  );

  return {
    loading,
    error,
    deployState,
    loadCatalog,
    createSwarm: createSwarmWithInput,
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
    updateSwarmLocal,
    handleAgentEvent,
  };
}
