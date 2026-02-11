// ─── SSE Connection Manager ──────────────────────────────────
// Manages Server-Sent Events connections for real-time message push.
// Also bridges events to the WebSocket gateway for dual delivery.

import type { broadcast as BroadcastFn, broadcastToUser as BroadcastToUserFn } from '../../gateway/broadcast';

interface SSEEvent {
  type: string;
  data: unknown;
}

interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
  userId: string;
  closed: boolean;
}

// Cached gateway broadcast functions (loaded lazily)
let _wsBroadcast: typeof BroadcastFn | null = null;
let _wsBroadcastToUser: typeof BroadcastToUserFn | null = null;
let _wsImportAttempted = false;

async function loadGatewayBroadcast() {
  if (_wsImportAttempted) return;
  _wsImportAttempted = true;
  try {
    const mod = await import('../../gateway/broadcast');
    _wsBroadcast = mod.broadcast;
    _wsBroadcastToUser = mod.broadcastToUser;
  } catch {
    // Gateway not available — SSE-only mode
  }
}

// Eagerly attempt to load (non-blocking)
loadGatewayBroadcast();

class SSEManager {
  private clients: SSEClient[] = [];
  private encoder = new TextEncoder();

  addClient(controller: ReadableStreamDefaultController, userId: string): string {
    const id = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.clients.push({ id, controller, userId, closed: false });
    return id;
  }

  removeClient(id: string): void {
    this.clients = this.clients.filter((c) => c.id !== id);
  }

  broadcast(event: SSEEvent, targetUserId?: string): void {
    // ── SSE delivery ──
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    const bytes = this.encoder.encode(payload);

    const toRemove: string[] = [];
    for (const client of this.clients) {
      if (client.closed) {
        toRemove.push(client.id);
        continue;
      }
      if (targetUserId && client.userId !== targetUserId) {
        continue;
      }
      try {
        client.controller.enqueue(bytes);
      } catch {
        client.closed = true;
        toRemove.push(client.id);
      }
    }
    for (const id of toRemove) {
      this.removeClient(id);
    }

    // ── WS gateway bridge ──
    try {
      if (targetUserId && _wsBroadcastToUser) {
        _wsBroadcastToUser(targetUserId, event.type, event.data);
      } else if (_wsBroadcast) {
        _wsBroadcast(event.type, event.data);
      }
    } catch {
      // Gateway error — SSE still delivered
    }
  }

  get connectionCount(): number {
    return this.clients.filter((c) => !c.closed).length;
  }
}

// ─── Singleton ───────────────────────────────────────────────

declare global {
  var __sseManager: SSEManager | undefined;
}

export function getSSEManager(): SSEManager {
  if (!globalThis.__sseManager) {
    globalThis.__sseManager = new SSEManager();
  }
  return globalThis.__sseManager;
}
