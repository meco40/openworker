import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { RustBackend, findFreePort, startMem0MockServer } from './rustGateway';

/**
 * One Rust gateway (static UI mode) and scheduler per test file, on a free port, with
 * a temp data dir and the mem0 mock. See `rustGateway.ts` for the environment.
 */
export class ManagedServer {
  private backend: RustBackend | null = null;
  private port = 0;
  private mem0Mock: http.Server | null = null;
  private tempDir: string | null = null;

  async start(): Promise<void> {
    this.port = await findFreePort();
    const mem0Port = await findFreePort();
    this.mem0Mock = await startMem0MockServer(mem0Port);
    this.tempDir = await mkdtemp(path.join(os.tmpdir(), 'openworker-e2e-'));
    try {
      this.backend = await RustBackend.start({
        port: this.port,
        mem0Port,
        dataDir: this.tempDir,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.backend) {
      const backend = this.backend;
      this.backend = null;
      await backend.stop();
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

  wsBaseUrl(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  wsUrl(): string {
    return `${this.wsBaseUrl()}?protocol=v2`;
  }
}
