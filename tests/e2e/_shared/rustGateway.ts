import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { waitForHealth } from './waitForHealth';

/**
 * Launcher for the Rust backend in the E2E lanes (smoke: `ManagedServer`, browser:
 * `scripts/e2e/start-e2e-server.ts`).
 *
 * Starts `betaclaw-gateway` in static UI mode (UI from `out/`, built by
 * `pnpm run build:export`) and `betaclaw-scheduler` with the same environment. All
 * stores live in a temp data dir, and the mem0 mock answers the memory provider.
 * The binaries come from `rust/target/debug`, built by `scripts/e2e/prepare-rust-gateway.mjs`.
 */

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const UI_EXPORT_DIR = path.join(REPO_ROOT, 'out');

const LOG_TAIL_LINES = 40;
const SCHEDULER_STARTUP_GRACE_MS = 3_000;

interface ChildEntry {
  name: string;
  proc: ChildProcessWithoutNullStreams;
}

export function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to resolve free port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

export async function startMem0MockServer(port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    if (url.startsWith('/v2/memories/search') && method === 'POST') {
      sendJson(res, 200, { memories: [] });
      return;
    }

    if (url.startsWith('/v2/memories') && method === 'POST') {
      sendJson(res, 200, { memories: [], total: 0, page: 1, page_size: 1 });
      return;
    }

    if (url.startsWith('/v1/search') && method === 'POST') {
      sendJson(res, 200, { memories: [] });
      return;
    }

    if (url.startsWith('/v1/memories') && method === 'GET') {
      sendJson(res, 200, { memories: [] });
      return;
    }

    if (url === '/v1/memories' && method === 'POST') {
      await readBody(req).catch(() => '');
      sendJson(res, 200, [{ id: `mem-${Date.now()}` }]);
      return;
    }

    if (url.startsWith('/v1/memories/') && method === 'GET' && url.endsWith('/history')) {
      sendJson(res, 200, { history: [] });
      return;
    }

    if (url.startsWith('/v1/memories/') && method === 'GET') {
      sendJson(res, 200, { id: 'mem-any', memory: 'fixture memory', metadata: {} });
      return;
    }

    if (url.startsWith('/v1/memories/') && (method === 'PUT' || method === 'DELETE')) {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url === '/v1/memories' && method === 'DELETE') {
      sendJson(res, 200, { deleted: 0 });
      return;
    }

    sendJson(res, 200, { ok: true });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return server;
}

export function rustBinaryPath(name: 'betaclaw-gateway' | 'betaclaw-scheduler'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return path.join(REPO_ROOT, 'rust', 'target', 'debug', exe);
}

export interface RustBackendOptions {
  port: number;
  mem0Port: number;
  /** Temp dir that holds every store of this run. The caller creates and removes it. */
  dataDir: string;
  /** Mirror child output to this process's stderr, for Playwright's web server log. */
  forwardLogs?: boolean;
}

/**
 * The environment of both Rust processes. The E2E contract from the former Node server
 * stays: anonymous loopback auth, exec approvals off, mem0 mock, world model off. The
 * background jobs run in Rust: the gateway runs swarm, the scheduler runs automation.
 */
export function buildRustBackendEnv(options: RustBackendOptions): NodeJS.ProcessEnv {
  const { port, mem0Port, dataDir } = options;
  const store = (file: string) => path.join(dataDir, file);
  return {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    REQUIRE_AUTH: 'false',
    E2E_ALLOW_ANONYMOUS_AUTH: 'true',
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET || 'e2e-local-nextauth-secret',
    NEXTAUTH_URL: `http://127.0.0.1:${port}`,
    BETACLAW_UI_MODE: 'static',
    UI_STATIC_DIR: UI_EXPORT_DIR,
    RUST_LOG: process.env.RUST_LOG || 'info',
    MEMORY_PROVIDER: 'mem0',
    WORLD_MODEL_MODE: 'off',
    WORLD_MODEL_ENABLED: 'false',
    WORLD_MODEL_INGESTION_BRIDGE: 'false',
    MEM0_BASE_URL: `http://127.0.0.1:${mem0Port}`,
    MEM0_API_KEY: process.env.MEM0_API_KEY || 'test-mem0-key',
    MEM0_API_PATH: '/v1',
    MODEL_HUB_TEST_MODE: '1',
    MODEL_HUB_ENCRYPTION_KEY:
      process.env.MODEL_HUB_ENCRYPTION_KEY || randomBytes(32).toString('hex'),
    BETACLAW_EXEC_APPROVALS_REQUIRED: 'false',
    BETACLAW_SWARM_RUNNER: 'rust',
    BETACLAW_WORKSPACE_CLEANUP: 'rust',
    BETACLAW_TELEGRAM_POLLER: 'off',
    MESSAGES_DB_PATH: store('messages.db'),
    PERSONAS_DB_PATH: store('personas.db'),
    PERSONAS_ROOT_PATH: store('personas'),
    MEMORY_DB_PATH: store('memory.db'),
    PROACTIVE_DB_PATH: store('proactive.db'),
    KNOWLEDGE_DB_PATH: store('knowledge.db'),
    AUTH_DB_PATH: store('auth.db'),
    // The gateway seeds the first admin from these, even with REQUIRE_AUTH=false.
    AUTH_DEFAULT_EMAIL: process.env.AUTH_DEFAULT_EMAIL || 'e2e-admin@example.invalid',
    AUTH_DEFAULT_PASSWORD: process.env.AUTH_DEFAULT_PASSWORD || randomBytes(32).toString('hex'),
    LOGS_DB_PATH: store('logs.db'),
    DATABASE_PATH: store('mission-control.db'),
    AUTOMATION_DB_PATH: store('automation.db'),
    STATS_DB_PATH: store('stats.db'),
    SKILLS_DB_PATH: store('skills.db'),
    CLAWHUB_DB_PATH: store('clawhub.db'),
    MASTER_DB_PATH: store('master.db'),
    MODEL_HUB_DB_PATH: store('model-hub.db'),
    GATEWAY_CONFIG_DB_PATH: store('gateway-config.db'),
  } as NodeJS.ProcessEnv;
}

/** Running gateway and scheduler. `stop()` ends both. */
export class RustBackend {
  private readonly children: ChildEntry[] = [];
  private readonly logs: string[] = [];

  private constructor(readonly port: number) {}

  /** Starts both binaries and resolves once the gateway answers `/api/health`. */
  static async start(options: RustBackendOptions): Promise<RustBackend> {
    for (const name of ['betaclaw-gateway', 'betaclaw-scheduler'] as const) {
      if (!fs.existsSync(rustBinaryPath(name))) {
        throw new Error(
          `Rust binary not found: ${rustBinaryPath(name)}. Run: node scripts/e2e/prepare-rust-gateway.mjs`,
        );
      }
    }

    const backend = new RustBackend(options.port);
    const env = buildRustBackendEnv(options);
    try {
      // The gateway migrates every store before it listens. The scheduler starts after
      // that, as in Compose (`migrate` first): two processes migrating one fresh SQLite
      // file at the same time fail with "duplicate column".
      const gateway = backend.spawnChild(
        'gateway',
        rustBinaryPath('betaclaw-gateway'),
        env,
        options.forwardLogs,
      );
      await Promise.race([
        waitForHealth(`http://127.0.0.1:${options.port}/api/health`, { timeoutMs: 120_000 }),
        backend.exitedBeforeReady(gateway),
      ]);
      const scheduler = backend.spawnChild(
        'scheduler',
        rustBinaryPath('betaclaw-scheduler'),
        env,
        options.forwardLogs,
      );
      // The scheduler has no health endpoint. A startup failure exits within a second or two.
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, SCHEDULER_STARTUP_GRACE_MS)),
        backend.exitedBeforeReady(scheduler),
      ]);
    } catch (error) {
      await backend.stop();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Rust backend failed to start: ${message}\n${backend.logs.slice(-LOG_TAIL_LINES).join('')}`,
      );
    }
    return backend;
  }

  /** Rejects when the child exits; used to fail fast during start-up. */
  private exitedBeforeReady(child: ChildEntry): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      child.proc.once('exit', (code, signal) => {
        reject(new Error(`${child.name} exited before readiness (code=${code}, signal=${signal})`));
      });
    });
  }

  private spawnChild(
    name: string,
    binary: string,
    env: NodeJS.ProcessEnv,
    forwardLogs: boolean | undefined,
  ): ChildEntry {
    const proc = spawn(binary, [], { cwd: REPO_ROOT, env, stdio: 'pipe' });
    const capture = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.logs.push(text);
      if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
      if (forwardLogs) process.stderr.write(`[${name}] ${text}`);
    };
    proc.stdout.on('data', capture);
    proc.stderr.on('data', capture);
    const entry = { name, proc };
    this.children.push(entry);
    return entry;
  }

  /** Synchronous SIGKILL, for process `exit` handlers. */
  killNow(): void {
    for (const { proc } of this.children.splice(0)) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  /** SIGTERM, then SIGKILL after 10 s. Idempotent. */
  async stop(): Promise<void> {
    await Promise.all(
      this.children.splice(0).map(
        ({ proc }) =>
          new Promise<void>((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
            const timer = setTimeout(() => {
              try {
                proc.kill('SIGKILL');
              } catch {
                // already gone
              }
              resolve();
            }, 10_000);
            proc.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            try {
              proc.kill('SIGTERM');
            } catch {
              clearTimeout(timer);
              resolve();
            }
          }),
      ),
    );
  }
}
