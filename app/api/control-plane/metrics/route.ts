import { getSSEManager } from '../../../../src/server/channels/sse/manager';
import type { WorkerTaskStatus } from '../../../../src/server/worker/workerTypes';
import { getWorkerRepository } from '../../../../src/server/worker/workerRepository';
import { getTokenUsageRepository } from '../../../../src/server/stats/tokenUsageRepository';
import { getMemoryService } from '../../../../src/server/memory/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPEN_STATUSES = new Set<WorkerTaskStatus>([
  'queued',
  'planning',
  'clarifying',
  'executing',
  'review',
  'waiting_approval',
]);

function resolveTodayRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: now.toISOString() };
}

export async function GET() {
  try {
    const uptimeSeconds = Math.floor(process.uptime());

    const workerRepository = getWorkerRepository();
    const pendingWorkerTasks = workerRepository
      .listTasks()
      .filter((task) => OPEN_STATUSES.has(task.status)).length;

    const activeSseSessions = getSSEManager().connectionCount;

    const { from, to } = resolveTodayRange();
    const tokensToday = getTokenUsageRepository().getTotalTokens(from, to).totalTokens;

    const vectorNodeCount = getMemoryService().snapshot().length;

    return Response.json({
      ok: true,
      metrics: {
        uptimeSeconds,
        pendingWorkerTasks,
        activeSseSessions,
        tokensToday,
        vectorNodeCount,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to collect control-plane metrics.';
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
