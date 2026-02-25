'use client';

import { useCallback, useMemo, useState } from 'react';
import type { SwarmRecord } from '@/modules/agent-room/swarmTypes';

export function useSwarmCatalogState(initialCatalog: SwarmRecord[] = []) {
  const [swarms, setSwarms] = useState<SwarmRecord[]>(initialCatalog);
  const [selectedSwarmId, setSelectedSwarmId] = useState<string | null>(null);

  const selectedSwarm = useMemo(
    () => swarms.find((swarm) => swarm.id === selectedSwarmId) || null,
    [swarms, selectedSwarmId],
  );

  const upsertSwarm = useCallback((nextSwarm: SwarmRecord) => {
    setSwarms((previous) => {
      const index = previous.findIndex((item) => item.id === nextSwarm.id);
      if (index < 0) {
        return [nextSwarm, ...previous];
      }
      const next = [...previous];
      next[index] = nextSwarm;
      return next;
    });
  }, []);

  const removeSwarm = useCallback((swarmId: string) => {
    setSwarms((previous) => previous.filter((item) => item.id !== swarmId));
    setSelectedSwarmId((previous) => (previous === swarmId ? null : previous));
  }, []);

  return {
    swarms,
    setSwarms,
    selectedSwarmId,
    setSelectedSwarmId,
    selectedSwarm,
    upsertSwarm,
    removeSwarm,
  };
}

