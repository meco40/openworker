import { getWorldModelConfig } from '@/server/world-model/config';
import { deliverDueOpenLoops } from '@/server/world-model/services/openLoopService';
import { scanHeartbeat } from '@/server/world-model/runtime/heartbeatRuntime';
import { listActiveProspectiveScopes } from '@/server/world-model/repositories/prospectiveRepository';

export interface ProspectiveRuntimeDeps {
  isActive?: () => boolean;
  listUserPersonaScopes?: () => Promise<
    Array<{ userId: string; personaId: string; workspaceId: string }>
  >;
}

/**
 * Runs on the scheduler tick. It reconciles due open loops for each active
 * user/persona scope, then performs a light heartbeat scan. Delivery happens
 * through the outbox; the runtime itself never sends messages directly.
 */
export async function runProspectiveRuntimeOnce(
  deps: ProspectiveRuntimeDeps = {},
): Promise<{ openLoopsDelivered: number; heartbeatReconcile: boolean; scopes: number }> {
  const config = getWorldModelConfig();
  const active = deps.isActive ? deps.isActive() : config.enabled;
  if (!active) {
    return { openLoopsDelivered: 0, heartbeatReconcile: false, scopes: 0 };
  }

  const scopes = deps.listUserPersonaScopes
    ? await deps.listUserPersonaScopes()
    : await listActiveProspectiveScopes();
  let totalDelivered = 0;
  for (const scope of scopes) {
    const result = await deliverDueOpenLoops(
      scope.userId,
      scope.personaId,
      scope.workspaceId,
    ).catch(() => ({
      totalDue: 0,
      delivered: 0,
      enqueued: 0,
      rejected: 0,
      failed: 0,
      reasons: {},
    }));
    totalDelivered += result.delivered + result.enqueued;
  }

  const heartbeat = await scanHeartbeat().catch(() => ({
    overdueOpenLoops: [],
    needsReconcile: false,
    scannedAt: new Date().toISOString(),
  }));

  return {
    openLoopsDelivered: totalDelivered,
    heartbeatReconcile: heartbeat.needsReconcile,
    scopes: scopes.length,
  };
}
