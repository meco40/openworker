import { createRequire } from 'node:module';

import { startAutomationRuntime, stopAutomationRuntime } from './src/server/automation/runtime';
import {
  assertMemoryRuntimeConfiguration,
  assertMemoryRuntimeReady,
} from './src/server/memory/runtime';
import {
  startKnowledgeRuntimeLoop,
  stopKnowledgeRuntimeLoop,
} from './src/server/knowledge/runtime';
import {
  startSwarmOrchestratorRuntime,
  stopSwarmOrchestratorRuntime,
} from './src/server/agent-room/swarmRuntime';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

const instanceId = process.env.SCHEDULER_INSTANCE_ID || `scheduler-${process.pid}`;
const swarmRunner = process.env.SWARM_RUNNER || 'server';

function shutdown(): void {
  console.log('[automation-scheduler] shutting down...');
  stopKnowledgeRuntimeLoop();
  stopAutomationRuntime();
  if (swarmRunner === 'scheduler') {
    stopSwarmOrchestratorRuntime();
  }
  process.exit(0);
}

console.log(`[automation-scheduler] starting with instance ${instanceId}`);

async function bootstrap(): Promise<void> {
  assertMemoryRuntimeConfiguration();
  await assertMemoryRuntimeReady();

  if (swarmRunner === 'scheduler') {
    const { bootstrapMessageRuntime } = await import('./src/server/channels/messages/runtime');
    await bootstrapMessageRuntime();
    startSwarmOrchestratorRuntime(`${instanceId}-swarm`);
    console.log('[automation-scheduler] swarm orchestrator started');
  }

  startAutomationRuntime(instanceId);
  startKnowledgeRuntimeLoop();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap().catch((error) => {
  console.error('[automation-scheduler] startup failed:', error);
  process.exit(1);
});
