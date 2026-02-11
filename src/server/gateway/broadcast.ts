// ─── Gateway Broadcast ───────────────────────────────────────
// Scoped broadcast for WebSocket events with slow-consumer handling.

import { getClientRegistry, type GatewayClient } from './client-registry';
import { makeEvent } from './protocol';
import { MAX_BUFFERED_BYTES } from './constants';

let globalSeq = 0;

// ─── Broadcast Functions ─────────────────────────────────────

/** Broadcast an event to all connected clients. */
export function broadcast(event: string, payload?: unknown): void {
  globalSeq++;
  const frame = makeEvent(event, payload, globalSeq);
  const raw = JSON.stringify(frame);

  const registry = getClientRegistry();
  for (const client of registry.getAll()) {
    sendToClient(client, raw);
  }
}

/** Broadcast an event to all connections of a specific user. */
export function broadcastToUser(userId: string, event: string, payload?: unknown): void {
  globalSeq++;
  const frame = makeEvent(event, payload, globalSeq);
  const raw = JSON.stringify(frame);

  const registry = getClientRegistry();
  for (const client of registry.getByUserId(userId)) {
    sendToClient(client, raw);
  }
}

/** Broadcast to clients subscribed to a specific event category. */
export function broadcastToSubscribed(
  subscriptionKey: string,
  event: string,
  payload?: unknown,
): void {
  globalSeq++;
  const frame = makeEvent(event, payload, globalSeq);
  const raw = JSON.stringify(frame);

  const registry = getClientRegistry();
  for (const client of registry.getAll()) {
    if (client.subscriptions.has(subscriptionKey)) {
      sendToClient(client, raw);
    }
  }
}

/** Send raw pre-serialized data to specific connection IDs. */
export function broadcastToConnIds(connIds: string[], event: string, payload?: unknown): void {
  globalSeq++;
  const frame = makeEvent(event, payload, globalSeq);
  const raw = JSON.stringify(frame);

  const registry = getClientRegistry();
  for (const connId of connIds) {
    const client = registry.get(connId);
    if (client) sendToClient(client, raw);
  }
}

// ─── Internal ────────────────────────────────────────────────

function sendToClient(client: GatewayClient, raw: string): void {
  const { socket } = client;

  if (socket.readyState !== socket.OPEN) return;

  // Slow consumer detection
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    console.warn(`[gateway] Closing slow consumer ${client.connId} (buffered: ${socket.bufferedAmount})`);
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

/** Get the current global sequence number (for testing/metrics). */
export function getSeq(): number {
  return globalSeq;
}
