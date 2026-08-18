import { createRequire } from 'node:module';

import { startAutomationRuntime, stopAutomationRuntime } from './src/server/automation/runtime';
import { assertProductionAuthConfig } from './src/server/auth/productionGuard';
import { assertProductionWorldModelConfig } from './src/server/world-model/productionGuard';
import {
  assertMemoryRuntimeConfiguration,
  ensureMemoryRuntimeReadyForStartup,
} from './src/server/memory/runtime';
import {
  startKnowledgeRuntimeLoop,
  stopKnowledgeRuntimeLoop,
} from './src/server/knowledge/runtime';
import {
  startSwarmOrchestratorRuntime,
  stopSwarmOrchestratorRuntime,
} from './src/server/agent-room/swarmRuntime';
import {
  startOutboxDispatcher,
  stopOutboxDispatcher,
} from './src/server/world-model/outboxDispatcher';
import { runProspectiveRuntimeOnce } from './src/server/world-model/runtime/prospectiveRuntime';
import { getWorldModelConfig } from './src/server/world-model/config';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

const instanceId = process.env.SCHEDULER_INSTANCE_ID || `scheduler-${process.pid}`;
const swarmRunner = process.env.SWARM_RUNNER || 'server';
let prospectiveTimer: ReturnType<typeof setInterval> | null = null;

function shutdown(): void {
  console.log('[automation-scheduler] shutting down...');
  if (prospectiveTimer) {
    clearInterval(prospectiveTimer);
    prospectiveTimer = null;
  }
  stopKnowledgeRuntimeLoop();
  stopAutomationRuntime();
  void stopOutboxDispatcher();
  if (swarmRunner === 'scheduler') {
    stopSwarmOrchestratorRuntime();
  }
  process.exit(0);
}

console.log(`[automation-scheduler] starting with instance ${instanceId}`);

async function bootstrap(): Promise<void> {
  assertProductionAuthConfig();
  assertProductionWorldModelConfig();
  assertMemoryRuntimeConfiguration();
  await ensureMemoryRuntimeReadyForStartup({ component: 'scheduler' });

  if (swarmRunner === 'scheduler') {
    const { bootstrapMessageRuntime } = await import('./src/server/channels/messages/runtime');
    await bootstrapMessageRuntime();
    startSwarmOrchestratorRuntime(`${instanceId}-swarm`);
    console.log('[automation-scheduler] swarm orchestrator started');
  }

  startAutomationRuntime(instanceId);
  startKnowledgeRuntimeLoop();
  await startOutboxDispatcher().catch((error) => {
    console.error('[automation-scheduler] world-model outbox dispatcher failed to start:', error);
  });
  const prospectiveTimerMs = getWorldModelConfig().prospectiveIntervalMs;
  prospectiveTimer = setInterval(() => {
    void runProspectiveRuntimeOnce().catch((error) => {
      console.error('[automation-scheduler] world-model prospective runtime tick failed:', error);
    });
  }, prospectiveTimerMs);
  prospectiveTimer.unref();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap().catch((error) => {
  console.error('[automation-scheduler] startup failed:', error);
  process.exit(1);
});
