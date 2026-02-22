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

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as {
  loadEnvConfig: (dir: string, dev?: boolean) => unknown;
};
loadEnvConfig(process.cwd());

const instanceId = process.env.SCHEDULER_INSTANCE_ID || `scheduler-${process.pid}`;

function shutdown(): void {
  console.log('[automation-scheduler] shutting down...');
  stopKnowledgeRuntimeLoop();
  stopAutomationRuntime();
  process.exit(0);
}

console.log(`[automation-scheduler] starting with instance ${instanceId}`);

async function bootstrap(): Promise<void> {
  assertMemoryRuntimeConfiguration();
  await assertMemoryRuntimeReady();

  startAutomationRuntime(instanceId);
  startKnowledgeRuntimeLoop();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap().catch((error) => {
  console.error('[automation-scheduler] startup failed:', error);
  process.exit(1);
});
