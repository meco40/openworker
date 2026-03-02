import { useCallback } from 'react';
import type { SwarmRecord, SwarmUnit } from '@/modules/agent-room/swarmTypes';
import { normalizeSingleSwarm, type SwarmActionCommonInput, type SwarmResponse } from './shared';

export function useSwarmCoordinationActions(input: SwarmActionCommonInput) {
  const {
    clientRef,
    personaIds,
    removeSwarm,
    setError,
    setSelectedSwarmId,
    swarms,
    syncSwarm,
    upsertSwarm,
  } = input;

  const steerSwarm = useCallback(
    async (swarmId: string, guidance: string, targetPersonaId?: string): Promise<void> => {
      const client = clientRef.current;
      if (!client) return;
      const swarm = swarms.find((item) => item.id === swarmId);
      if (!swarm?.sessionId) return;
      try {
        if (targetPersonaId && swarm.units.some((unit) => unit.personaId === targetPersonaId)) {
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
    [clientRef, setError, swarms],
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
    [personaIds, setError, swarms, syncSwarm],
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
    [clientRef, removeSwarm, setError],
  );

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
    [clientRef, setError, setSelectedSwarmId, upsertSwarm],
  );

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
    [clientRef, setError, setSelectedSwarmId, upsertSwarm],
  );

  return {
    steerSwarm,
    addSwarmUnit,
    deleteSwarm,
    forkSwarm,
    chainSwarm,
  };
}
