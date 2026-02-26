import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { waitForHealth } from './waitForHealth';

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
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

async function startMem0MockServer(port: number): Promise<http.Server> {
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

export class ManagedServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly logs: string[] = [];
  private port = 0;
  private mem0Port = 0;
  private mem0Mock: http.Server | null = null;
  private tempDir: string | null = null;

  async start(): Promise<void> {
    this.port = await findFreePort();
    this.mem0Port = await findFreePort();
    this.mem0Mock = await startMem0MockServer(this.mem0Port);
    this.tempDir = await mkdtemp(path.join(os.tmpdir(), 'openworker-e2e-'));

    const env = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(this.port),
      HOSTNAME: '127.0.0.1',
      REQUIRE_AUTH: 'false',
      MEMORY_PROVIDER: 'mem0',
      MEM0_BASE_URL: `http://127.0.0.1:${this.mem0Port}`,
      MEM0_API_KEY: 'test-mem0-key',
      MEM0_API_PATH: '/v1',
      MODEL_HUB_TEST_MODE: '1',
      MODEL_HUB_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
      OPENCLAW_EXEC_APPROVALS_REQUIRED: 'false',
      MESSAGES_DB_PATH: path.join(this.tempDir, 'messages.db'),
      PERSONAS_DB_PATH: path.join(this.tempDir, 'personas.db'),
      MEMORY_DB_PATH: path.join(this.tempDir, 'memory.db'),
      PROACTIVE_DB_PATH: path.join(this.tempDir, 'proactive.db'),
      KNOWLEDGE_DB_PATH: path.join(this.tempDir, 'knowledge.db'),
    } as NodeJS.ProcessEnv;

    this.child = spawn('node', ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env,
      stdio: 'pipe',
    });

    const child = this.child;
    child.stdout.on('data', (chunk) => {
      this.logs.push(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk) => {
      this.logs.push(chunk.toString('utf8'));
    });

    try {
      const exitedBeforeReady = new Promise<never>((_resolve, reject) => {
        this.child?.once('exit', (code, signal) => {
          reject(new Error(`Server exited before readiness (code=${code}, signal=${signal})`));
        });
      });
      await Promise.race([
        waitForHealth(this.httpUrl('/api/health'), { timeoutMs: 120_000 }),
        exitedBeforeReady,
      ]);
    } catch (error) {
      await this.stop();
      const details = this.logs.slice(-40).join('');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ManagedServer failed to start: ${message}\n${details}`);
    }
  }

  async stop(): Promise<void> {
    if (this.child) {
      const child = this.child;
      this.child = null;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 10_000);

        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });

        try {
          child.kill('SIGTERM');
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }

    if (this.mem0Mock) {
      const server = this.mem0Mock;
      this.mem0Mock = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    if (this.tempDir) {
      const dir = this.tempDir;
      this.tempDir = null;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  httpUrl(path = ''): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }
}
