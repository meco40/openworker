// ─── useGatewayConnection ────────────────────────────────────
// React hook wrapping the singleton GatewayClient.
// Provides connection lifecycle, event subscriptions, and RPC.

'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  getGatewayClient,
  type ConnectionState,
  type GatewayClient,
} from '@/modules/gateway/ws-client';

// ─── Connection State ────────────────────────────────────────

/**
 * Returns the current WebSocket connection state and auto-connects
 * when the component mounts.
 */
export function useGatewayConnection(): {
  state: ConnectionState;
  client: GatewayClient;
} {
  const client = getGatewayClient();

  const state = useSyncExternalStore(
    (onChange) => {
      return client.onStateChange(onChange);
    },
    () => client.state,
    () => 'disconnected' as ConnectionState,
  );

  useEffect(() => {
    client.connect();
    // Don't disconnect on unmount — singleton stays alive
  }, [client]);

  return { state, client };
}
