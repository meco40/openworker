// ─── useGatewayConnection ────────────────────────────────────
// React hook wrapping the singleton GatewayClient.
// Provides connection lifecycle, event subscriptions, and RPC.

'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getGatewayClient, type ConnectionState, type GatewayClient } from './ws-client';
import type { GatewayEvent } from '../../server/gateway/events';

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

// ─── Event Subscription ─────────────────────────────────────

/**
 * Subscribe to a specific gateway event. The handler is stable across
 * re-renders thanks to useRef.
 */
export function useGatewayEvent<T = unknown>(
  event: GatewayEvent | string,
  handler: (payload: T, seq?: number) => void,
): void {
  const client = getGatewayClient();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const unsub = client.on(event, (payload, seq) => {
      handlerRef.current(payload as T, seq);
    });
    return unsub;
  }, [client, event]);
}

// ─── RPC Request Hook ────────────────────────────────────────

/**
 * Hook for making RPC requests that returns loading/error state.
 */
export function useGatewayRequest<TParams extends Record<string, unknown>, TResult = unknown>(
  method: string,
): {
  execute: (params?: TParams) => Promise<TResult>;
  loading: boolean;
  error: string | null;
} {
  const client = getGatewayClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(
    async (params?: TParams): Promise<TResult> => {
      setLoading(true);
      setError(null);
      try {
        const result = await client.request<TResult>(method, params);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [client, method],
  );

  return { execute, loading, error };
}
