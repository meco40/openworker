import { useCallback, useEffect, useState } from 'react';
import type { GatewayState, SystemLog } from '@/shared/domain/types';
import { getMemoryPreview } from '@/core/memory';
import { usePersona } from '@/modules/personas/PersonaContext';

function createInitialGatewayState(): GatewayState {
  return {
    eventHistory: [],
    memoryEntries: [],
  };
}

const MEMORY_PREVIEW_LIMIT = 50;

interface UseGatewayStateOptions {
  loadMemory?: boolean;
}

export function useGatewayState({ loadMemory = true }: UseGatewayStateOptions = {}) {
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
    const nodes = await getMemoryPreview(activePersonaId, MEMORY_PREVIEW_LIMIT);
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
    if (!loadMemory) {
      return;
    }

    void updateMemoryDisplay();
  }, [loadMemory, updateMemoryDisplay]);

  return {
    gatewayState,
    addEventLog,
    updateMemoryDisplay,
  };
}
