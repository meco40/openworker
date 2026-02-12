// ─── Gateway Connection Handler ──────────────────────────────
// WebSocket lifecycle: registration, frame dispatch, cleanup.

import type { WebSocket } from 'ws';
import { getClientRegistry, type GatewayClient } from './client-registry';
import { broadcastToUser } from './broadcast';
import { parseFrame, makeError, makeEvent } from './protocol';
import { GatewayEvents, type HelloOkPayload } from './events';
import { GATEWAY_VERSION, MAX_REQUESTS_PER_MINUTE } from './constants';
import { dispatchMethod, getRegisteredMethods } from './method-router';

// ─── Connection Setup ────────────────────────────────────────

export function handleConnection(socket: WebSocket, userId: string): void {
  const connId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const client: GatewayClient = {
    socket,
    connId,
    userId,
    connectedAt: Date.now(),
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    seq: 0,
  };

  const registry = getClientRegistry();
  registry.register(client);

  // Send hello-ok event (must be EventFrame, not ResponseFrame — client listens for event type)
  const helloPayload: HelloOkPayload = {
    server: { version: GATEWAY_VERSION },
    events: Object.values(GatewayEvents),
    methods: getRegisteredMethods(),
  };
  send(socket, makeEvent(GatewayEvents.HELLO_OK, helloPayload));

  // Broadcast presence
  broadcastToUser(userId, GatewayEvents.PRESENCE_UPDATE, {
    userId,
    status: 'online',
    connectionCount: registry.getUserConnectionCount(userId),
  });

  // ─── Message Handler ─────────────────────────────────────
  socket.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf-8');
    const frame = parseFrame(raw);

    if (!frame) {
      send(socket, makeError('unknown', 'INVALID_REQUEST', 'Invalid frame format'));
      return;
    }

    if (frame.type === 'req') {
      // Rate limiting
      const now = Date.now();
      if (now - client.requestWindowStart > 60_000) {
        client.requestCount = 0;
        client.requestWindowStart = now;
      }
      client.requestCount++;

      if (client.requestCount > MAX_REQUESTS_PER_MINUTE) {
        send(socket, makeError(frame.id, 'RATE_LIMITED', 'Too many requests'));
        return;
      }

      const sendRaw = (data: unknown) => {
        if (socket.readyState === socket.OPEN) {
          send(socket, data);
        }
      };

      dispatchMethod(frame, client, sendRaw).catch((err) => {
        console.error(`[gateway] Method error ${frame.method}:`, err);
        send(socket, makeError(frame.id, 'UNAVAILABLE', 'Internal server error'));
      });
    }
    // Events from client (e.g., typing indicators) can be handled here
  });

  // ─── Close Handler ───────────────────────────────────────
  socket.on('close', (code, reason) => {
    registry.unregister(connId);

    const remaining = registry.getUserConnectionCount(userId);
    broadcastToUser(userId, GatewayEvents.PRESENCE_UPDATE, {
      userId,
      status: remaining > 0 ? 'online' : 'offline',
      connectionCount: remaining,
    });

    console.log(
      `[gateway] Client ${connId} disconnected (code: ${code}, reason: ${reason?.toString() || 'none'})`,
    );
  });

  // ─── Error Handler ───────────────────────────────────────
  socket.on('error', (err) => {
    console.error(`[gateway] Socket error for ${connId}:`, err.message);
  });

  console.log(`[gateway] Client ${connId} connected (user: ${userId})`);
}

// ─── Helpers ─────────────────────────────────────────────────

function send(socket: WebSocket, data: unknown): void {
  if (socket.readyState === socket.OPEN) {
    try {
      socket.send(JSON.stringify(data));
    } catch {
      // ignore send errors during close
    }
  }
}
