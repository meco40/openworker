import { useCallback, useState } from 'react';
import type { CreateSwarmInput, SwarmRecord } from '@/modules/agent-room/swarmTypes';
import {
  isTransientGatewayConnectionError,
  normalizeSingleSwarm,
  normalizeSwarmList,
  type SwarmActionCommonInput,
} from './shared';

export function useSwarmCatalogActions(input: SwarmActionCommonInput) {
  const {
    clientRef,
    personaIds,
    setError,
    setSelectedSwarmId,
    setSwarms,
    sessionToSwarmRef,
    upsertSwarm,
  } = input;

  const [loading, setLoading] = useState(false);

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
      if (clientRef.current === client) {
        setLoading(false);
      }
    }
  }, [clientRef, setError, setSelectedSwarmId, setSwarms, sessionToSwarmRef]);

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
        const payload = await client.request('agent.v2.swarm.create', {
          title: swarmInput.title,
          task: swarmInput.task,
          leadPersonaId,
          units,
          conversationId: swarmInput.conversationId || undefined,
          searchEnabled: Boolean(swarmInput.searchEnabled),
          swarmTemplate: swarmInput.swarmTemplate ?? null,
          pauseBetweenPhases: Boolean(swarmInput.pauseBetweenPhases),
        });
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
    [clientRef, personaIds, sessionToSwarmRef, setError, setSelectedSwarmId, upsertSwarm],
  );

  return { loading, loadCatalog, createSwarm };
}
