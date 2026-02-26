'use client';

/**
 * useSwarmConnection — manages WebSocket client lifecycle and event routing.
 * Refs are owned by the compositor (useAgentRoomRuntime) and passed in.
 */

import { useEffect } from 'react';
import { AgentV2GatewayClient } from '@/modules/gateway/ws-agent-v2-client';
import { parseSwarmRecord } from '@/modules/agent-room/swarmTypes';
import type { AgentV2EventEnvelope } from '@/server/agent-v2/types';
import type { SwarmCatalogActions } from '@/modules/agent-room/hooks/useSwarmCatalogState';

interface SwarmConnectionInput {
  enabled: boolean;
  clientRef: React.MutableRefObject<AgentV2GatewayClient | null>;
  sessionToSwarmRef: React.MutableRefObject<Map<string, string>>;
  commandToInfoRef: React.MutableRefObject<Map<string, { personaId: string; phase: string }>>;
  catalogActions: SwarmCatalogActions;
  loadCatalog: () => Promise<void>;
  handleAgentEvent: (event: AgentV2EventEnvelope) => void;
}

/**
 * Manages the WebSocket client lifecycle — connect, subscribe, disconnect.
 * The actual refs and handlers are owned externally.
 */
export function useSwarmConnection(input: SwarmConnectionInput): void {
  const {
    enabled,
    clientRef,
    sessionToSwarmRef,
    commandToInfoRef,
    catalogActions,
    loadCatalog,
    handleAgentEvent,
  } = input;

  useEffect(() => {
    if (!enabled) return;
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

      if (payload.status === 'deleted') {
        catalogActions.removeSwarm(swarmId);
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

      if (payload.swarm) {
        const parsed = parseSwarmRecord(payload.swarm);
        if (parsed) {
          catalogActions.upsertSwarm(parsed);
          if (parsed.sessionId) {
            sessionToSwarmRef.current.set(parsed.sessionId, parsed.id);
          }
          return;
        }
      }

      void (async () => {
        try {
          const res = await client.request('agent.v2.swarm.get', { id: swarmId });
          const fresh = parseSwarmRecord((res as { swarm?: unknown })?.swarm ?? res);
          if (fresh) {
            catalogActions.upsertSwarm(fresh);
            if (fresh.sessionId) {
              sessionToSwarmRef.current.set(fresh.sessionId, fresh.id);
            }
          }
        } catch {
          // Swarm may have been deleted
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
  }, [
    enabled,
    clientRef,
    sessionToSwarmRef,
    commandToInfoRef,
    catalogActions,
    handleAgentEvent,
    loadCatalog,
  ]);
}
