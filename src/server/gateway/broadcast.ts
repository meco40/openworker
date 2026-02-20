// ─── Gateway Broadcast ───────────────────────────────────────
// Scoped broadcast for WebSocket events with slow-consumer handling.

import { getClientRegistry, type GatewayClient } from '@/server/gateway/client-registry';
import { makeEvent } from '@/server/gateway/protocol';
import { MAX_BUFFERED_BYTES } from '@/server/gateway/constants';

// ─── Broadcast Functions ─────────────────────────────────────

/** Broadcast an event to all connected clients. */
export function broadcast(event: string, payload?: unknown): void {
  const registry = getClientRegistry();
  for (const client of registry.getAll()) {
    sendEventToClient(client, event, payload);
  }
}

/** Broadcast an event to all connections of a specific user. */
export function broadcastToUser(userId: string, event: string, payload?: unknown): void {
  const registry = getClientRegistry();
  for (const client of registry.getByUserId(userId)) {
    sendEventToClient(client, event, payload);
  }
}

/** Broadcast to clients subscribed to a specific event category. */
export function broadcastToSubscribed(
  subscriptionKey: string,
  event: string,
  payload?: unknown,
): void {
  const registry = getClientRegistry();
  for (const client of registry.getAll()) {
    if (client.subscriptions.has(subscriptionKey)) {
      sendEventToClient(client, event, payload);
    }
  }
}

/** Send raw pre-serialized data to specific connection IDs. */
export function broadcastToConnIds(connIds: string[], event: string, payload?: unknown): void {
  const registry = getClientRegistry();
  for (const connId of connIds) {
    const client = registry.get(connId);
    if (client) sendEventToClient(client, event, payload);
  }
}

// ─── Internal ────────────────────────────────────────────────

/**
 * Build a per-client sequenced event frame and send it.
 * Each client gets a contiguous seq (1, 2, 3 …) so the browser-side
 * gap detector never fires false positives from scoped broadcasts.
 */
function sendEventToClient(client: GatewayClient, event: string, payload?: unknown): void {
  client.seq++;
  const frame = makeEvent(event, payload, client.seq);
  const raw = JSON.stringify(frame);
  sendRawToClient(client, raw);
}

function sendRawToClient(client: GatewayClient, raw: string): void {
  const { socket } = client;

  if (socket.readyState !== socket.OPEN) return;

  // Slow consumer detection
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    console.warn(
      `[gateway] Closing slow consumer ${client.connId} (buffered: ${socket.bufferedAmount})`,
    );
    try {
      socket.close(1008, 'slow consumer');
    } catch {
      // ignore
    }
    return;
  }

  try {
    socket.send(raw);
  } catch (err) {
    console.error(`[gateway] Send error to ${client.connId}:`, err);
    try {
      socket.close(1011, 'send error');
    } catch {
      // ignore
    }
  }
}
