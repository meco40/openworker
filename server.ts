// ─── Custom Server: Next.js + WebSocket on same port ─────────
// Wraps Next.js with an HTTP server that handles WebSocket upgrades on /ws.

import { createServer } from 'node:http';
import next from 'next';
import { WebSocketServer } from 'ws';
import { getToken } from 'next-auth/jwt';
import { handleConnection, getClientRegistry, broadcast } from './src/server/gateway/index.js';
import { TICK_INTERVAL_MS, MAX_PAYLOAD_BYTES } from './src/server/gateway/constants.js';
import { getRoomOrchestrator } from './src/server/rooms/runtime.js';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const REQUIRE_AUTH = String(process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';
const LEGACY_LOCAL_USER_ID = 'legacy-local-user';

const SECRET =
  process.env.NEXTAUTH_SECRET?.trim() ||
  process.env.AUTH_SECRET?.trim() ||
  'openclaw-local-nextauth-secret';

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

function getRequestUrl(req: { url?: string; headers: { host?: string | undefined } }): URL {
  const host = req.headers.host || `${hostname}:${port}`;
  return new URL(req.url || '/', `http://${host}`);
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res);
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  // ─── WebSocket Upgrade ─────────────────────────────────────
  server.on('upgrade', async (req, socket, head) => {
    const { pathname } = getRequestUrl(req);

    if (pathname !== '/ws') {
      // Let Next.js handle non-WS upgrades (e.g., HMR in dev)
      return;
    }

    try {
      // Authenticate via NextAuth JWT cookie (same origin, same port)
      const token = await getToken({ req: req as never, secret: SECRET });
      let userId: string;

      if (token && typeof token.id === 'string') {
        userId = token.id;
      } else if (!REQUIRE_AUTH) {
        // No login required — fall back to legacy local user (mirrors resolveUserIdFromSession)
        userId = LEGACY_LOCAL_USER_ID;
      } else {
        console.warn('[gateway] WS auth failed — no valid token (cookie present:', !!req.headers.cookie, ')');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Check connection limit per user
      const registry = getClientRegistry();
      const existing = registry.getByUserId(userId);
      if (existing.length >= 5) {
        socket.write('HTTP/1.1 429 Too Many Connections\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
        handleConnection(ws, userId);
      });
    } catch (err) {
      console.error('[gateway] Upgrade auth error:', err);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  // ─── Tick / Keepalive ──────────────────────────────────────
  const tickInterval = setInterval(() => {
    broadcast('tick', { ts: Date.now() });
  }, TICK_INTERVAL_MS);

  // ─── Room Orchestrator (inline scheduler) ─────────────────
  const ROOM_INTERVAL_MS = Number(process.env.ROOM_ORCHESTRATOR_INTERVAL_MS || 30_000);
  let roomTimer: ReturnType<typeof setInterval> | null = null;

  async function runRoomCycle(): Promise<void> {
    try {
      const orchestrator = getRoomOrchestrator({ instanceId: `server-${process.pid}` });
      const result = await orchestrator.runOnce();
      if (result.processedRooms > 0) {
        console.log(`[rooms] processed ${result.processedRooms} rooms, ${result.createdMessages} messages`);
      }
    } catch (error) {
      console.warn('[rooms] cycle failed:', error);
    }
  }

  function startRoomScheduler(): void {
    console.log(`[rooms] scheduler started (interval=${ROOM_INTERVAL_MS}ms)`);
    void runRoomCycle();
    roomTimer = setInterval(() => void runRoomCycle(), ROOM_INTERVAL_MS);
    roomTimer.unref();
  }

  startRoomScheduler();

  // ─── Graceful Shutdown ─────────────────────────────────────
  function shutdown() {
    console.log('[gateway] Shutting down...');
    clearInterval(tickInterval);
    if (roomTimer) clearInterval(roomTimer);

    const registry = getClientRegistry();
    for (const client of registry.getAll()) {
      try {
        client.socket.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
    }

    server.close(() => {
      console.log('[gateway] Server closed.');
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // ─── Start ─────────────────────────────────────────────────
  server.listen(port, hostname, () => {
    console.log(`[gateway] Server ready on http://${hostname}:${port}`);
    console.log(`[gateway] WebSocket endpoint: ws://${hostname}:${port}/ws`);
  });
});
