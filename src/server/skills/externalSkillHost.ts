import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SkillDispatchContext } from '@/server/skills/types';

interface ExternalSkillHostRequest {
  type: 'execute';
  id: string;
  functionName: string;
  handlerPath: string;
  args: Record<string, unknown>;
  context?: SkillDispatchContext;
}

interface ExternalSkillHostResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface ExecuteExternalSkillParams {
  functionName: string;
  handlerPath: string;
  args: Record<string, unknown>;
  context?: SkillDispatchContext;
}

export interface ExternalSkillHostStatus {
  running: boolean;
  pid: number | null;
  connected: boolean;
  pendingRequests: number;
  timeoutMs: number;
  idleMs: number;
  startedAt: string | null;
  totalRequests: number;
}

function resolveHostTimeoutMs(): number {
  const raw = Number.parseInt(String(process.env.EXTERNAL_SKILL_HOST_TIMEOUT_MS || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 30_000;
  }
  return Math.max(1_000, Math.min(raw, 10 * 60 * 1000));
}

function resolveHostIdleMs(): number {
  const raw = Number.parseInt(String(process.env.EXTERNAL_SKILL_HOST_IDLE_MS || ''), 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return 60_000;
  }
  return Math.min(raw, 60 * 60 * 1000);
}

function buildStoppedStatus(): ExternalSkillHostStatus {
  return {
    running: false,
    pid: null,
    connected: false,
    pendingRequests: 0,
    timeoutMs: resolveHostTimeoutMs(),
    idleMs: resolveHostIdleMs(),
    startedAt: null,
    totalRequests: 0,
  };
}

class ExternalSkillHostClient {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private idleTimer: NodeJS.Timeout | null = null;
  private startedAtMs: number | null = null;
  private totalRequests = 0;

  async execute(params: ExecuteExternalSkillParams): Promise<unknown> {
    this.clearIdleTimer();
    const child = this.ensureStarted();
    const requestId = randomUUID();
    const timeoutMs = resolveHostTimeoutMs();
    this.totalRequests += 1;

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`External skill execution timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timeout });

      const request: ExternalSkillHostRequest = {
        type: 'execute',
        id: requestId,
        functionName: params.functionName,
        handlerPath: params.handlerPath,
        args: params.args,
        context: params.context,
      };

      try {
        child.send(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(
          new Error(
            `Failed to send request to external skill host: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    }).finally(() => {
      this.scheduleIdleStop();
    });
  }

  stop(): void {
    this.clearIdleTimer();
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      // best effort
    }
    this.child = null;
    this.startedAtMs = null;
    this.failAllPending(new Error('External skill host stopped.'));
  }

  getStatus(): ExternalSkillHostStatus {
    return {
      running: Boolean(this.child && this.child.exitCode === null),
      pid: this.child?.pid ?? null,
      connected: Boolean(this.child?.connected),
      pendingRequests: this.pending.size,
      timeoutMs: resolveHostTimeoutMs(),
      idleMs: resolveHostIdleMs(),
      startedAt: this.startedAtMs ? new Date(this.startedAtMs).toISOString() : null,
      totalRequests: this.totalRequests,
    };
  }

  private ensureStarted(): ChildProcess {
    if (this.child && this.child.connected) {
      return this.child;
    }

    const hostScriptPath = path.resolve(process.cwd(), 'scripts', 'external-skill-host.mjs');
    if (!fs.existsSync(hostScriptPath)) {
      throw new Error(`External skill host script not found: ${hostScriptPath}`);
    }

    const child = spawn(process.execPath, [hostScriptPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    child.stderr?.on('data', () => {
      // Keep stderr drained to avoid backpressure if host writes diagnostics.
    });

    child.on('message', (message: unknown) => {
      this.handleMessage(message as ExternalSkillHostResponse);
    });

    child.on('error', (error) => {
      this.failAllPending(error);
      this.child = null;
      this.startedAtMs = null;
    });

    child.on('exit', (code, signal) => {
      this.failAllPending(
        new Error(`External skill host exited (${code ?? 'null'}${signal ? `, ${signal}` : ''}).`),
      );
      this.child = null;
      this.startedAtMs = null;
    });

    this.child = child;
    this.startedAtMs = Date.now();
    return child;
  }

  private handleMessage(message: ExternalSkillHostResponse): void {
    const id = String(message.id || '');
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(id);

    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    pending.reject(new Error(message.error || 'External skill host execution failed.'));
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private scheduleIdleStop(): void {
    if (this.pending.size > 0) return;
    const idleMs = resolveHostIdleMs();
    if (idleMs <= 0) return;

    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0) return;
      this.stop();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

let externalSkillHostClient: ExternalSkillHostClient | null = null;
let shutdownHandlerInstalled = false;

function getExternalSkillHostClient(): ExternalSkillHostClient {
  if (!externalSkillHostClient) {
    externalSkillHostClient = new ExternalSkillHostClient();
  }
  if (!shutdownHandlerInstalled) {
    process.once('exit', () => {
      externalSkillHostClient?.stop();
    });
    shutdownHandlerInstalled = true;
  }
  return externalSkillHostClient;
}

export async function executeExternalSkillInHost(
  params: ExecuteExternalSkillParams,
): Promise<unknown> {
  return getExternalSkillHostClient().execute(params);
}

export function stopExternalSkillHost(): void {
  externalSkillHostClient?.stop();
  externalSkillHostClient = null;
}

export function getExternalSkillHostStatus(): ExternalSkillHostStatus {
  if (!externalSkillHostClient) {
    return buildStoppedStatus();
  }
  return externalSkillHostClient.getStatus();
}
