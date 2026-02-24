// ─── Gateway Connection Handler ──────────────────────────────
// WebSocket lifecycle: registration, frame dispatch, cleanup.

import type { WebSocket } from 'ws';
import { getClientRegistry, type GatewayClient } from '@/server/gateway/client-registry';
import { broadcastToUser } from '@/server/gateway/broadcast';
import { parseFrame, makeError, makeEvent } from '@/server/gateway/protocol';
import { GatewayEvents, type HelloOkPayload } from '@/server/gateway/events';
import { GATEWAY_VERSION, MAX_REQUESTS_PER_MINUTE } from '@/server/gateway/constants';
import { dispatchMethod, getRegisteredMethods } from '@/server/gateway/method-router';
import type { MethodNamespace } from '@/server/gateway/method-router';

// ─── Connection Setup ────────────────────────────────────────

export function handleConnection(
  socket: WebSocket,
  userId: string,
  options?: { protocol?: MethodNamespace },
): void {
  const protocol = options?.protocol ?? 'v1';
  const maxRequestsPerMinute = resolveMaxRequestsPerMinute(protocol);
  const connId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const client: GatewayClient = {
    socket,
    connId,
    userId,
    connectedAt: Date.now(),
    isAlive: true,
    subscriptions: new Set(),
    requestCount: 0,
    requestWindowStart: Date.now(),
    seq: 0,
    protocol,
  };

  const registry = getClientRegistry();
  registry.register(client);

  // Send hello-ok event (must be EventFrame, not ResponseFrame — client listens for event type)
  const helloPayload: HelloOkPayload = {
    server: { version: GATEWAY_VERSION },
    events: Object.values(GatewayEvents),
    methods: getRegisteredMethods(protocol),
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

      if (client.requestCount > maxRequestsPerMinute) {
        send(socket, makeError(frame.id, 'RATE_LIMITED', 'Too many requests'));
        return;
      }

      const sendRaw = (data: unknown) => {
        if (socket.readyState === socket.OPEN) {
          send(socket, data);
        }
      };

      dispatchMethod(frame, client, sendRaw, protocol).catch((err) => {
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

  // WS protocol pong frames keep transport liveness current.
  socket.on('pong', () => {
    client.isAlive = true;
  });

  console.log(`[gateway] Client ${connId} connected (user: ${userId}, protocol: ${protocol})`);
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

function resolveMaxRequestsPerMinute(protocol: MethodNamespace): number {
  if (protocol !== 'v2') return MAX_REQUESTS_PER_MINUTE;
  const raw = Number.parseInt(String(process.env.AGENT_V2_MAX_REQUESTS_PER_MINUTE || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) return MAX_REQUESTS_PER_MINUTE;
  return Math.max(10, Math.min(raw, 10_000));
}
