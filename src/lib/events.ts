/**
 * Server-Sent Events (SSE) broadcaster for real-time updates
 * Manages client connections and broadcasts events to all listeners
 */

import type { SSEEvent } from './types';

/**
 * OpenClaw runs single-node for local usage.
 * This broadcaster intentionally uses in-memory state and is not multi-process safe.
 */
const SSE_MODE = 'single-node-in-memory';
const MAX_SSE_CLIENTS = Number.parseInt(process.env.SSE_MAX_CLIENTS || '20', 10);

export type SseEventFilter = (event: SSEEvent) => boolean;

// Store active SSE client connections.
const clients = new Map<ReadableStreamDefaultController, SseEventFilter | undefined>();
let totalConnections = 0;
let droppedConnections = 0;
let broadcastsTotal = 0;
let lastBroadcastAt: string | null = null;
let lastEventType: string | null = null;

function pruneOldestClient() {
  const iterator = clients.keys();
  const oldest = iterator.next().value as ReadableStreamDefaultController | undefined;
  if (!oldest) return;
  clients.delete(oldest);
  droppedConnections += 1;
  try {
    oldest.close();
  } catch {
    // Ignore close errors for stale sockets.
  }
}

/**
 * Register a new SSE client connection
 */
export function registerClient(
  controller: ReadableStreamDefaultController,
  filter?: SseEventFilter,
): void {
  totalConnections += 1;
  if (clients.size >= Math.max(1, MAX_SSE_CLIENTS)) {
    pruneOldestClient();
  }
  clients.set(controller, filter);
}

/**
 * Unregister an SSE client connection
 */
export function unregisterClient(controller: ReadableStreamDefaultController): void {
  clients.delete(controller);
}

/**
 * Broadcast an event to all connected SSE clients
 */
export function broadcast(event: SSEEvent): void {
  const encoder = new TextEncoder();
  const data = `data: ${JSON.stringify(event)}\n\n`;
  const encoded = encoder.encode(data);
  broadcastsTotal += 1;
  lastBroadcastAt = new Date().toISOString();
  lastEventType = event.type;

  // Send to all connected clients
  const clientsArray = Array.from(clients.entries());
  for (const [client, filter] of clientsArray) {
    if (filter && !filter(event)) {
      continue;
    }
    try {
      client.enqueue(encoded);
    } catch (error) {
      // Client disconnected, remove it
      console.error('Failed to send SSE event to client:', error);
      clients.delete(client);
    }
  }

  console.log(`[SSE] Broadcast ${event.type} to ${clients.size} client(s)`);
}

export function getSseDiagnostics() {
  return {
    mode: SSE_MODE,
    maxClients: Math.max(1, MAX_SSE_CLIENTS),
    connectedClients: clients.size,
    totalConnections,
    droppedConnections,
    broadcastsTotal,
    lastBroadcastAt,
    lastEventType,
  };
}
