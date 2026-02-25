// ─── Custom Server: Next.js + WebSocket on same port ─────────
// Wraps Next.js with an HTTP server that handles WebSocket upgrades on /ws.

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import next from 'next';
import { WebSocketServer } from 'ws';
import { getToken } from 'next-auth/jwt';
import { handleConnection, getClientRegistry, broadcast } from './src/server/gateway/index.js';
import { TICK_INTERVAL_MS, MAX_PAYLOAD_BYTES } from './src/server/gateway/constants.js';
import { runGatewayKeepaliveSweep } from './src/server/gateway/keepalive.js';
import { getPrincipalUserId } from './src/server/auth/principal.js';
import {
  assertMemoryRuntimeConfiguration,
  assertMemoryRuntimeReady,
} from './src/server/memory/runtime.js';
import { getPersonaTelegramBotRegistry } from './src/server/telegram/personaTelegramBotRegistry.js';
import {
  startPersonaBotPolling,
  stopAllPersonaBotPolling,
} from './src/server/telegram/personaTelegramPoller.js';
import { bootstrapMessageRuntime } from './src/server/channels/messages/runtime.js';
import {
  startSwarmOrchestratorRuntime,
  stopSwarmOrchestratorRuntime,
} from './src/server/agent-room/swarmRuntime.js';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const REQUIRE_AUTH = String(process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';

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

Promise.resolve()
  .then(async () => {
    assertMemoryRuntimeConfiguration();
    await assertMemoryRuntimeReady();
    await bootstrapMessageRuntime();
    await app.prepare();
  })
  .then(() => {
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

      if (pathname !== '/ws' && pathname !== '/ws-agent-v2') {
        // Let Next.js handle non-WS upgrades (e.g., HMR in dev)
        return;
      }
      const protocol = pathname === '/ws-agent-v2' ? 'v2' : 'v1';

      try {
        // Authenticate via NextAuth JWT cookie (same origin, same port)
        const token = await getToken({ req: req as never, secret: SECRET });
        let userId: string;

        if (token && typeof token.id === 'string') {
          userId = token.id;
        } else if (!REQUIRE_AUTH) {
          // No login required — fall back to configured single principal.
          userId = getPrincipalUserId();
        } else {
          console.warn(
            '[gateway] WS auth failed — no valid token (cookie present:',
            !!req.headers.cookie,
            ')',
          );
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
          handleConnection(ws, userId, { protocol });
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
      runGatewayKeepaliveSweep();
    }, TICK_INTERVAL_MS);

    // ─── Persona Telegram Bot Polling ─────────────────────────
    async function startPersonaBotPollers(): Promise<void> {
      try {
        const registry = getPersonaTelegramBotRegistry();
        const bots = registry.listActiveBots().filter((b) => b.transport === 'polling');
        if (bots.length > 0) {
          console.log(`[telegram] Starting polling for ${bots.length} persona bot(s)`);
          await Promise.all(bots.map((b) => startPersonaBotPolling(b.botId)));
        }
      } catch (error) {
        console.warn('[telegram] Failed to start persona bot pollers:', error);
      }
    }
    void startPersonaBotPollers();

    // ─── Swarm Orchestrator ────────────────────────────────────
    const swarmRunner = process.env.SWARM_RUNNER || 'server';
    if (swarmRunner !== 'scheduler') {
      startSwarmOrchestratorRuntime('server-main');
    }

    // ─── Graceful Shutdown ─────────────────────────────────────
    function shutdown() {
      console.log('[gateway] Shutting down...');
      clearInterval(tickInterval);
      stopAllPersonaBotPolling();
      stopSwarmOrchestratorRuntime();

      // Abort all in-flight AI generation requests so they don't hang.
      try {
        void (async () => {
          try {
            const { getMessageService } = await import('./src/server/channels/messages/runtime.js');
            getMessageService().abortAllActiveRequests();
          } catch {
            // runtime may not be initialised yet — safe to ignore
          }
        })();
      } catch {
        // runtime may not be initialised yet — safe to ignore
      }

      // Kill all managed background processes.
      try {
        void (async () => {
          try {
            const { killAllManagedProcesses } =
              await import('./src/server/skills/handlers/processManager.js');
            killAllManagedProcesses();
          } catch {
            // safe to ignore
          }
        })();
      } catch {
        // safe to ignore
      }

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
      console.log(`[gateway] WebSocket endpoint: ws://${hostname}:${port}/ws-agent-v2`);
    });
  })
  .catch((error: unknown) => {
    console.error('[gateway] Failed to prepare Next.js app:', error);
    process.exit(1);
  });
