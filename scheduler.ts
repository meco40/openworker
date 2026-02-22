import fs from 'node:fs';
import path from 'node:path';
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
const heartbeatFile =
  process.env.AUTOMATION_HEARTBEAT_FILE ||
  path.join(process.cwd(), '.local', 'scheduler.heartbeat');
const heartbeatIntervalMs = Number(process.env.AUTOMATION_HEARTBEAT_INTERVAL_MS || 10_000);

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function writeHeartbeat(): void {
  try {
    fs.mkdirSync(path.dirname(heartbeatFile), { recursive: true });
    fs.writeFileSync(heartbeatFile, new Date().toISOString(), 'utf8');
  } catch (error) {
    console.warn('[automation-scheduler] heartbeat write failed:', error);
  }
}

function startHeartbeat(): void {
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, heartbeatIntervalMs);
  heartbeatTimer.unref();
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function shutdown(): void {
  console.log('[automation-scheduler] shutting down...');
  stopHeartbeat();
  stopKnowledgeRuntimeLoop();
  stopAutomationRuntime();
  process.exit(0);
}

console.log(`[automation-scheduler] starting with instance ${instanceId}`);

async function bootstrap(): Promise<void> {
  assertMemoryRuntimeConfiguration();
  await assertMemoryRuntimeReady();

  startAutomationRuntime(instanceId);
  startHeartbeat();
  startKnowledgeRuntimeLoop();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap().catch((error) => {
  console.error('[automation-scheduler] startup failed:', error);
  process.exit(1);
});
