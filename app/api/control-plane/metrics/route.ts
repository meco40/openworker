import type { WorkerTaskStatus } from '../../../../src/server/worker/workerTypes';
import { getWorkerRepository } from '../../../../src/server/worker/workerRepository';
import { getTokenUsageRepository } from '../../../../src/server/stats/tokenUsageRepository';
import { getMemoryService } from '../../../../src/server/memory/runtime';
import { getClientRegistry } from '../../../../src/server/gateway/client-registry';

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
    const orchestraMetrics = workerRepository.getOrchestraMetrics();

    const activeWsSessions = getClientRegistry().connectionCount;

    const { from, to } = resolveTodayRange();
    const tokensToday = getTokenUsageRepository().getTotalTokens(from, to).totalTokens;

    const vectorNodeCount = (await getMemoryService().snapshot()).length;

    let automationMetrics: {
      activeRules: number;
      queuedRuns: number;
      runningRuns: number;
      deadLetterRuns: number;
      leaseAgeSeconds: number | null;
    } | null = null;
    let roomMetrics: {
      totalRooms: number;
      runningRooms: number;
      totalMembers: number;
      totalMessages: number;
    } | null = null;

    const [automationImport, roomImport] = await Promise.allSettled([
      import('../../../../src/server/automation/runtime'),
      import('../../../../src/server/rooms/runtime'),
    ]);

    if (automationImport.status === 'fulfilled') {
      automationMetrics = automationImport.value.getAutomationService().getMetrics();
    }

    if (roomImport.status === 'fulfilled') {
      roomMetrics = roomImport.value.getRoomRepository().getMetrics();
    }

    return Response.json({
      ok: true,
      metrics: {
        uptimeSeconds,
        pendingWorkerTasks,
        activeWsSessions,
        tokensToday,
        vectorNodeCount,
        orchestra: orchestraMetrics,
        automation: automationMetrics,
        rooms: roomMetrics,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to collect control-plane metrics.';
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
