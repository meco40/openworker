import { listOverdueOpenLoops } from '@/server/world-model/repositories/prospectiveRepository';
import type { OpenLoopRecord } from '@/server/world-model/types';

export interface HeartbeatRuntimeOptions {
  maxOpenLoopAgeMs?: number;
  now?: () => string;
}

export interface HeartbeatScanResult {
  overdueOpenLoops: OpenLoopRecord[];
  needsReconcile: boolean;
  scannedAt: string;
}

/**
 * A reconciliation heartbeat. It scans for stale / overdue state and reports
 * whether a reconciliation pass is needed. It never immediately sends
 * messages — proactive delivery happens through the outbox + open-loop runtime.
 */
export async function scanHeartbeat(
  options: HeartbeatRuntimeOptions = {},
): Promise<HeartbeatScanResult> {
  const now = options.now?.() ?? new Date().toISOString();
  const maxAgeMs = options.maxOpenLoopAgeMs ?? 24 * 60 * 60 * 1000;
  const overdue = await listOverdueOpenLoops(maxAgeMs, now);
  return {
    overdueOpenLoops: overdue,
    needsReconcile: overdue.length > 0,
    scannedAt: now,
  };
}

/**
 * Returns true when there is something that needs immediate action. Useful for
 * integration tests and for deciding whether the heartbeat tick should schedule
 * a reconciliation job.
 */
export function heartbeatNeedsAction(result: HeartbeatScanResult): boolean {
  return result.needsReconcile;
}
