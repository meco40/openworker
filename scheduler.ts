import fs from 'node:fs';
import path from 'node:path';

import { startAutomationRuntime, stopAutomationRuntime } from './src/server/automation/runtime';

const instanceId = process.env.SCHEDULER_INSTANCE_ID || `scheduler-${process.pid}`;
const heartbeatFile = process.env.AUTOMATION_HEARTBEAT_FILE || path.join(process.cwd(), '.local', 'scheduler.heartbeat');
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
  stopAutomationRuntime();
  process.exit(0);
}

console.log(`[automation-scheduler] starting with instance ${instanceId}`);
startAutomationRuntime(instanceId);
startHeartbeat();

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
