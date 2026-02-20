import { useCallback, useEffect, useState } from 'react';
import type { GatewayState, SystemLog } from '@/shared/domain/types';
import { getMemorySnapshot } from '@/core/memory';
import { usePersona } from '@/modules/personas/PersonaContext';

function createInitialGatewayState(): GatewayState {
  return {
    version: '1.2.5-proactive',
    uptime: 0,
    cpuUsage: 12,
    memoryUsage: 256,
    activeSessions: 1,
    onboarded: true,
    totalTokens: 0,
    eventHistory: [],
    trafficData: Array.from({ length: 12 }, (_, index) => ({ name: `${index * 2}:00`, tokens: 0 })),
    memoryEntries: [],
    scheduledTasks: [],
  };
}

export function useGatewayState() {
  const [gatewayState, setGatewayState] = useState<GatewayState>(() => createInitialGatewayState());
  const { activePersonaId } = usePersona();

  const addEventLog = useCallback((type: SystemLog['type'], message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setGatewayState((previous) => ({
      ...previous,
      eventHistory: [{ timestamp, type, message }, ...previous.eventHistory].slice(0, 50),
    }));

    // Persist server-side (fire-and-forget)
    fetch('/api/logs/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, message }),
    }).catch(() => {
      // Silent — log persistence failure should not affect UI
    });
  }, []);

  const updateMemoryDisplay = useCallback(async () => {
    const nodes = await getMemorySnapshot(activePersonaId);
    setGatewayState((previous) => ({
      ...previous,
      memoryEntries: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        content: node.content,
        timestamp: node.timestamp,
        importance: node.importance,
      })),
    }));
  }, [activePersonaId]);

  useEffect(() => {
    setGatewayState((previous) => ({
      ...previous,
      eventHistory: [
        {
          timestamp: new Date().toLocaleTimeString(),
          type: 'SYS',
          message: 'Gateway Core initialized.',
        },
      ],
    }));
  }, []);

  useEffect(() => {
    void updateMemoryDisplay();
  }, [updateMemoryDisplay]);

  return {
    gatewayState,
    addEventLog,
    updateMemoryDisplay,
  };
}
