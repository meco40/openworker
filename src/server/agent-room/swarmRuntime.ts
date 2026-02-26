/**
 * SwarmOrchestratorRuntime — periodic tick wrapper for the SwarmOrchestrator.
 *
 * Modeled after AutomationRuntime. Use SWARM_RUNNER=scheduler to move
 * execution to the scheduler process instead of server.ts.
 *
 * Usage:
 *   startSwarmOrchestratorRuntime('server-main')   // in server.ts
 *   stopSwarmOrchestratorRuntime()                  // in shutdown handler
 */

import { runOrchestratorOnce } from '@/server/agent-room/orchestrator';
import { getMessageRepository } from '@/server/channels/messages/runtime';

const DEFAULT_TICK_MS = 5_000;

declare global {
  var __swarmOrchestratorRuntime: SwarmOrchestratorRuntime | undefined;
}

class SwarmOrchestratorRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tickIntervalMs: number;
  readonly instanceId: string;

  constructor(instanceId: string, tickIntervalMs: number) {
    this.instanceId = instanceId;
    this.tickIntervalMs = tickIntervalMs;
  }

  start(): void {
    if (this.timer) return;

    // Recover any swarms that were running before server restart
    try {
      const repo = getMessageRepository();
      const recovered = repo.recoverRunningSwarms();
      if (recovered > 0) {
        console.log(`[swarm-runtime] recovered ${recovered} running swarm(s) → hold`);
      }
    } catch (err) {
      console.error('[swarm-runtime] recovery failed:', err);
    }

    // Run immediately on start
    void this.tick();

    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);

    // Don't block process exit
    this.timer.unref();

    console.log(
      `[swarm-runtime] started instanceId=${this.instanceId} tick=${this.tickIntervalMs}ms`,
    );
  }

  private async tick(): Promise<void> {
    try {
      await runOrchestratorOnce();
    } catch (err) {
      console.error('[swarm-runtime] tick error:', err);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log(`[swarm-runtime] stopped instanceId=${this.instanceId}`);
  }
}

export function startSwarmOrchestratorRuntime(instanceId = 'default'): void {
  if (globalThis.__swarmOrchestratorRuntime) {
    // Already running — no-op
    return;
  }
  const tickMs = Number(process.env.SWARM_ORCHESTRATOR_TICK_MS) || DEFAULT_TICK_MS;
  const runtime = new SwarmOrchestratorRuntime(instanceId, tickMs);
  globalThis.__swarmOrchestratorRuntime = runtime;
  runtime.start();
}

export function stopSwarmOrchestratorRuntime(): void {
  if (globalThis.__swarmOrchestratorRuntime) {
    globalThis.__swarmOrchestratorRuntime.stop();
    globalThis.__swarmOrchestratorRuntime = undefined;
  }
}
