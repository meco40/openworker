import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type {
  ExtensionManifestV1,
  LifecycleHookContext,
  LifecycleHookStage,
} from '@/server/agent-v2/types';

export interface ExtensionHookExecutionResult {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
}

interface PendingHook {
  resolve: (result: ExtensionHookExecutionResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class ExtensionWorkerHost {
  private worker: Worker | null = null;
  private readonly pending = new Map<string, PendingHook>();
  private crashedError: Error | null = null;

  constructor(private readonly manifest: ExtensionManifestV1) {}

  start(): void {
    if (this.worker) return;

    const moduleAbsolute = path.resolve(this.manifest.modulePath);
    const moduleUrl = pathToFileURL(moduleAbsolute).href;
    this.worker = new Worker(buildWorkerBootstrapScript(), {
      eval: true,
      workerData: { moduleUrl },
      resourceLimits: {
        maxOldGenerationSizeMb: resolveWorkerOldGenMb(),
      },
    });

    this.worker.on('message', (message: Record<string, unknown>) => {
      const id = String(message.id || '');
      if (!id) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      if (message.ok === true) {
        pending.resolve({
          ok: true,
          output: (message.output as Record<string, unknown> | undefined) ?? undefined,
        });
        return;
      }
      pending.resolve({
        ok: false,
        error: String(message.error || 'Extension hook failed.'),
      });
    });

    this.worker.on('error', (error) => {
      this.crashedError = error;
      this.failAllPending(error);
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        this.crashedError = new Error(`Extension worker exited with code ${code}.`);
      }
      this.failAllPending(this.crashedError ?? new Error('Extension worker exited.'));
      this.worker = null;
    });
  }

  async runHook(
    stage: LifecycleHookStage,
    context: LifecycleHookContext,
    timeoutMs: number,
  ): Promise<ExtensionHookExecutionResult> {
    if (this.crashedError) {
      return {
        ok: false,
        error: `Extension worker unavailable: ${this.crashedError.message}`,
      };
    }
    this.start();
    if (!this.worker) {
      return {
        ok: false,
        error: 'Extension worker could not be started.',
      };
    }

    const requestId = `hook-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return await new Promise<ExtensionHookExecutionResult>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.pending.delete(requestId);
          resolve({
            ok: false,
            error: `Extension hook timeout after ${timeoutMs}ms.`,
          });
        },
        Math.max(1, timeoutMs),
      );

      this.pending.set(requestId, { resolve, reject, timeout });
      this.worker?.postMessage({
        id: requestId,
        stage,
        context,
      });
    });
  }

  stop(): void {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.failAllPending(new Error('Extension worker terminated.'));
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function buildWorkerBootstrapScript(): string {
  return `
    const { parentPort, workerData } = require('node:worker_threads');
    let runHookFn = null;
    let initError = null;

    async function init() {
      try {
        const mod = await import(workerData.moduleUrl);
        runHookFn = mod.runHook || mod.default;
        if (typeof runHookFn !== 'function') {
          throw new Error('Extension module must export runHook(stage, context).');
        }
      } catch (error) {
        initError = error;
      }
    }

    const initPromise = init();

    parentPort.on('message', async (msg) => {
      await initPromise;
      const id = String(msg?.id || '');
      if (!id) return;

      if (initError) {
        parentPort.postMessage({ id, ok: false, error: String(initError?.message || initError) });
        return;
      }

      try {
        const output = await runHookFn(String(msg.stage || ''), msg.context || {});
        parentPort.postMessage({ id, ok: true, output: output && typeof output === 'object' ? output : { value: output } });
      } catch (error) {
        parentPort.postMessage({ id, ok: false, error: String(error?.message || error) });
      }
    });
  `;
}

function resolveWorkerOldGenMb(): number {
  const raw = Number.parseInt(String(process.env.AGENT_V2_HOOK_WORKER_OLDGEN_MB || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 96;
  }
  return Math.max(16, Math.min(raw, 1024));
}
