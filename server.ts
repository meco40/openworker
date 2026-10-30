// ─── Custom Server: Next.js + WebSocket on same port ─────────
// Wraps Next.js with an HTTP server that handles WebSocket upgrades on /ws.

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import next from 'next';
import { websocketTokenRequest } from './src/server/auth/websocketTokenRequest.js';
import { WebSocketServer } from 'ws';
import { getToken } from 'next-auth/jwt';
import { handleConnection, getClientRegistry, broadcast } from './src/server/gateway/index.js';
import type { MethodNamespace } from './src/server/gateway/method-router.js';
import {
  TICK_INTERVAL_MS,
  MAX_PAYLOAD_BYTES,
  MAX_CONNECTIONS_PER_USER,
} from './src/server/gateway/constants.js';
import { runGatewayKeepaliveSweep } from './src/server/gateway/keepalive.js';
import { getPrincipalUserId } from './src/server/auth/principal.js';
import {
  applyLoopbackMarkerForTopology,
  isCrossSiteBrowserRequest,
  isLoopbackAddress,
  shouldAllowAnonymousLocalPrincipal,
  type BrowserRequestHeaders,
} from './src/server/auth/proxyPolicy.js';
import { assertProductionAuthConfig } from './src/server/auth/productionGuard.js';
import { assertProductionWorldModelConfig } from './src/server/world-model/productionGuard.js';
import {
  assertMemoryRuntimeConfiguration,
  ensureMemoryRuntimeReadyForStartup,
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
import { startTaskWorkspaceCleanupRuntime } from './src/server/tasks/workspaceCleanupRuntime.js';
import { resolveJobOwner } from './src/server/runtime/jobOwner.js';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

const dev = process.env.NODE_ENV !== 'production';
// Loopback by default; Docker/compose opt into 0.0.0.0 explicitly via HOSTNAME.
const hostname = process.env.HOSTNAME || '127.0.0.1';
const port = parseInt(process.env.PORT || '3000', 10);

// During the Rust migration the axum gateway owns the public listener and this
// process moves to the internal UI port. It then serves only the UI and the API
// routes that have not been migrated yet, and never terminates a WebSocket.
// See docs/RUST_MIGRATION.md.
const WS_DISABLED = String(process.env.BETACLAW_DISABLE_WS || '').toLowerCase() === 'true';

// Set only when this process sits behind the Rust gateway, which re-derives the
// marker from its own socket peer and forwards it. The UI process must keep that
// forwarded value untouched, because its own peer is always the gateway and would
// therefore report "loopback" for every single request. See
// `applyLoopbackMarkerForTopology` in src/server/auth/proxyPolicy.ts.
const TRUST_PROXY_LOOPBACK_MARKER =
  String(process.env.TRUST_PROXY_LOOPBACK_MARKER || '').toLowerCase() === 'true';

const REQUIRE_AUTH = String(process.env.REQUIRE_AUTH || 'false').toLowerCase() === 'true';

type NextDevBundler = 'webpack' | 'turbopack';

function resolveNextDevBundler(): NextDevBundler {
  const value = String(process.env.NEXT_DEV_BUNDLER || 'webpack')
    .trim()
    .toLowerCase();
  return value === 'turbopack' || value === 'turbo' ? 'turbopack' : 'webpack';
}

function resolveAuthSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  if (secret) return secret;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXTAUTH_SECRET (or AUTH_SECRET) must be set in production.');
  }

  console.warn(
    '[SECURITY WARNING] NEXTAUTH_SECRET is not configured. Falling back to a local development secret.',
  );
  return 'betaclaw-local-nextauth-secret';
}

const SECRET = resolveAuthSecret();
const nextDevBundler = dev ? resolveNextDevBundler() : null;

if (nextDevBundler) {
  console.info(`[gateway] Next dev bundler: ${nextDevBundler}`);
}

const app = next({
  dev,
  hostname,
  port,
  ...(nextDevBundler === 'webpack' ? { webpack: true } : {}),
  ...(nextDevBundler === 'turbopack' ? { turbopack: true } : {}),
});
const handle = app.getRequestHandler();

/**
 * Mounts the legacy Node WebSocket gateway on /ws.
 *
 * Only used while `BETACLAW_DISABLE_WS` is unset. Once the Rust gateway owns
 * /ws this path is unreachable and is removed together with the remaining
 * gateway methods, in slice S13. See docs/RUST_MIGRATION.md.
 */
async function mountWebSocketServer(
  server: import('node:http').Server,
  nextApp: typeof app,
  nextDev: boolean,
  bindHost: string,
  bindPort: number,
  secret: string,
  requireAuth: boolean,
): Promise<void> {
  const handleNextUpgrade = nextApp.getUpgradeHandler();

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  server.on('upgrade', async (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://${bindHost}:${bindPort}`);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const { pathname } = url;

    // In dev mode Next.js uses its own websocket upgrade paths (HMR).
    // Delegate all non-gateway upgrades so the browser does not fall back to hard reload loops.
    if (nextDev && pathname !== '/ws') {
      handleNextUpgrade(req, socket, head);
      return;
    }

    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const browser: BrowserRequestHeaders = {
      host: req.headers.host,
      origin: req.headers.origin,
      referer: req.headers.referer,
      secFetchSite: req.headers['sec-fetch-site'],
    };
    // Cross-site WebSocket hijacking: a page on another origin must not open /ws with the user's cookies.
    if (isCrossSiteBrowserRequest(browser)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const protocolParam = url.searchParams.get('protocol');
    if (protocolParam !== 'v2') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const protocol: MethodNamespace = protocolParam;

    try {
      // Authenticate via NextAuth JWT cookie (same origin, same port)
      const token = await getToken({
        req: websocketTokenRequest(req),
        secret,
      });
      let userId: string;

      if (token && typeof token.id === 'string') {
        userId = token.id;
      } else if (
        shouldAllowAnonymousLocalPrincipal({
          requireAuth,
          mcApiTokenConfigured: Boolean(process.env.MC_API_TOKEN),
          socketLoopback: isLoopbackAddress(req.socket.remoteAddress),
          browser,
        })
      ) {
        // No login required and a loopback-only local client — fall back to the configured single principal.
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
      if (existing.length >= MAX_CONNECTIONS_PER_USER) {
        socket.write('HTTP/1.1 429 Too Many Connections\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
        handleConnection(ws, userId, protocol);
      });
    } catch (err) {
      console.error('[gateway] Upgrade auth error:', err);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });
}

Promise.resolve()
  .then(async () => {
    assertProductionAuthConfig();
    assertProductionWorldModelConfig();
    assertMemoryRuntimeConfiguration();
    await ensureMemoryRuntimeReadyForStartup({ component: 'gateway' });
    await bootstrapMessageRuntime();
    await app.prepare();
  })
  .then(async () => {
    const server = createServer((req, res) => {
      applyLoopbackMarkerForTopology(
        req.headers,
        req.socket.remoteAddress,
        TRUST_PROXY_LOOPBACK_MARKER,
      );
      if (req.url === '/__node/health' || req.url?.startsWith('/__node/health?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'ok' }));
        return;
      }
      handle(req, res);
    });

    if (WS_DISABLED) {
      // The Rust gateway terminates /ws. Dev HMR also upgrades, so hand those to
      // Next. Reject any other stray upgrade so a misrouted client fails loudly.
      const handleNextUpgrade = app.getUpgradeHandler();
      server.on('upgrade', (req, socket, head) => {
        if (dev && !req.url?.startsWith('/ws')) {
          handleNextUpgrade(req, socket, head);
          return;
        }
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      });
      console.log('[gateway] WebSocket disabled — the Rust gateway owns /ws');
    } else {
      await mountWebSocketServer(server, app, dev, hostname, port, SECRET, REQUIRE_AUTH);
    }

    // ─── Tick / Keepalive ──────────────────────────────────────
    // The Rust gateway owns the tick and the keepalive sweep while it owns /ws,
    // so this process must not run a second heartbeat.
    const tickInterval = WS_DISABLED
      ? null
      : setInterval(() => {
          broadcast('tick', { ts: Date.now() });
          runGatewayKeepaliveSweep();
        }, TICK_INTERVAL_MS);

    // ─── Persona Telegram Bot Polling ─────────────────────────
    const pollerOwner = resolveJobOwner('BETACLAW_TELEGRAM_POLLER');
    console.log(`[telegram-poller] owner=${pollerOwner}`);
    async function startPersonaBotPollers(): Promise<void> {
      if (pollerOwner !== 'node') {
        return;
      }
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
    const swarmOwner = resolveJobOwner('BETACLAW_SWARM_RUNNER');
    console.log(`[swarm-runtime] owner=${swarmOwner}`);
    const swarmRunner = (process.env.SWARM_RUNNER || 'server').trim().toLowerCase();
    if (swarmOwner === 'node' && swarmRunner !== 'scheduler') {
      startSwarmOrchestratorRuntime('server-main');
    }

    // ─── Workspace Cleanup ────────────────────────────────────
    const cleanupOwner = resolveJobOwner('BETACLAW_WORKSPACE_CLEANUP');
    console.log(`[task-workspaces] owner=${cleanupOwner}`);
    let taskWorkspaceCleanupRuntime: { stop(): void } | null = null;
    if (cleanupOwner === 'node') {
      taskWorkspaceCleanupRuntime = startTaskWorkspaceCleanupRuntime();
    }

    // ─── Graceful Shutdown ─────────────────────────────────────
    function shutdown() {
      console.log('[gateway] Shutting down...');
      if (tickInterval) clearInterval(tickInterval);
      stopAllPersonaBotPolling();
      stopSwarmOrchestratorRuntime();
      taskWorkspaceCleanupRuntime?.stop();

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

      if (!WS_DISABLED) {
        const registry = getClientRegistry();
        for (const client of registry.getAll()) {
          try {
            client.socket.close(1001, 'server shutting down');
          } catch {
            // ignore
          }
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
      const role = WS_DISABLED ? 'Next.js UI (proxied by the Rust gateway)' : 'gateway';
      console.log(`[server] ${role} ready on http://${hostname}:${port}`);
      if (WS_DISABLED) {
        console.log('[server] /ws is terminated by the Rust gateway, not by this process');
      } else {
        console.log(`[gateway] WebSocket endpoint: ws://${hostname}:${port}/ws?protocol=v2`);
      }
    });
  })
  .catch((error: unknown) => {
    console.error('[gateway] Failed to prepare Next.js app:', error);
    process.exit(1);
  });
