import fs from 'node:fs';
import path from 'node:path';

import { startAutomationRuntime, stopAutomationRuntime } from './src/server/automation/runtime';
import { getRoomOrchestrator } from './src/server/rooms/runtime';
import { shouldRunRooms } from './src/server/rooms/runtimeRole';

const instanceId = process.env.SCHEDULER_INSTANCE_ID || `scheduler-${process.pid}`;
const heartbeatFile =
  process.env.AUTOMATION_HEARTBEAT_FILE ||
  path.join(process.cwd(), '.local', 'scheduler.heartbeat');
const heartbeatIntervalMs = Number(process.env.AUTOMATION_HEARTBEAT_INTERVAL_MS || 10_000);

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let roomTimer: ReturnType<typeof setInterval> | null = null;

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

const roomIntervalMs = Number(process.env.ROOM_ORCHESTRATOR_INTERVAL_MS || 30_000);

async function runRoomCycle(): Promise<void> {
  try {
    const orchestrator = getRoomOrchestrator({ instanceId });
    await orchestrator.runOnce();
  } catch (error) {
    console.warn('[rooms-scheduler] room cycle failed:', error);
  }
}

function startRoomScheduler(): void {
  void runRoomCycle();
  roomTimer = setInterval(() => {
    void runRoomCycle();
  }, roomIntervalMs);
  roomTimer.unref();
}

function stopRoomScheduler(): void {
  if (roomTimer) {
    clearInterval(roomTimer);
    roomTimer = null;
  }
}

function shutdown(): void {
  console.log('[automation-scheduler] shutting down...');
  stopHeartbeat();
  stopRoomScheduler();
  stopAutomationRuntime();
  process.exit(0);
}

console.log(`[automation-scheduler] starting with instance ${instanceId}`);
startAutomationRuntime(instanceId);
startHeartbeat();
if (shouldRunRooms('scheduler')) {
  startRoomScheduler();
} else {
  console.log('[rooms-scheduler] room cycle disabled in scheduler process by ROOMS_RUNNER');
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
