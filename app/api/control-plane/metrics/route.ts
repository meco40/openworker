import type { WorkerTaskStatus } from '../../../../src/server/worker/workerTypes';
import { getWorkerRepository } from '../../../../src/server/worker/workerRepository';
import { getTokenUsageRepository } from '../../../../src/server/stats/tokenUsageRepository';
import { getMemoryService } from '../../../../src/server/memory/runtime';
import { getClientRegistry } from '../../../../src/server/gateway/client-registry';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { LEGACY_LOCAL_USER_ID } from '../../../../src/server/auth/constants';
import { getMessageRepository } from '../../../../src/server/channels/messages/runtime';

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

function resolveVectorCountScopes(userId?: string): string[] {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return [];
  if (normalizedUserId !== LEGACY_LOCAL_USER_ID) return [normalizedUserId];

  const scopes = new Set<string>([normalizedUserId]);
  try {
    const conversations = getMessageRepository().listConversations(500, normalizedUserId);
    for (const conversation of conversations) {
      const channel = String(conversation.channelType || '')
        .trim()
        .toLowerCase();
      const externalChatId = String(conversation.externalChatId || '').trim();
      if (!channel || !externalChatId || channel === 'webchat') continue;
      scopes.add(`channel:${channel}:${externalChatId}`);
    }
  } catch (error) {
    console.warn('Vector scope discovery failed:', error);
  }

  return Array.from(scopes);
}

async function resolveVectorNodeCount(userId?: string): Promise<number> {
  const memoryService = getMemoryService();
  const scopes = resolveVectorCountScopes(userId);
  if (scopes.length === 0) {
    return (await memoryService.snapshot()).length;
  }
  if (scopes.length === 1) {
    return (await memoryService.snapshot(undefined, scopes[0])).length;
  }

  const nodes = (
    await Promise.all(scopes.map((scopeUserId) => memoryService.snapshot(undefined, scopeUserId)))
  ).flat();
  return new Set(nodes.map((node) => node.id)).size;
}

export async function GET() {
  try {
    const userContext = await resolveRequestUserContext();
    const uptimeSeconds = Math.floor(process.uptime());

    const workerRepository = getWorkerRepository();
    const pendingWorkerTasks = workerRepository
      .listTasks()
      .filter((task) => OPEN_STATUSES.has(task.status)).length;
    const orchestraMetrics = workerRepository.getOrchestraMetrics();

    const activeWsSessions = getClientRegistry().connectionCount;

    const { from, to } = resolveTodayRange();
    const tokensToday = getTokenUsageRepository().getTotalTokens(from, to).totalTokens;

    const vectorNodeCount = await resolveVectorNodeCount(userContext?.userId);

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

    const [automationImport, roomImport, knowledgeImport] = await Promise.allSettled([
      import('../../../../src/server/automation/runtime'),
      import('../../../../src/server/rooms/runtime'),
      import('../../../../src/server/knowledge/runtime').then((mod) => ({
        getKnowledgeRepository: mod.getKnowledgeRepository,
      })),
    ]);

    if (automationImport.status === 'fulfilled') {
      automationMetrics = automationImport.value.getAutomationService().getMetrics();
    }

    if (roomImport.status === 'fulfilled') {
      roomMetrics = roomImport.value.getRoomRepository().getMetrics();
    }

    let knowledgeMetrics: {
      episodeCount: number;
      ledgerCount: number;
      retrievalErrorCount: number;
      latestIngestionAt: string | null;
      ingestionLagMs: number;
    } | null = null;

    if (knowledgeImport.status === 'fulfilled') {
      try {
        const userId = userContext?.userId || LEGACY_LOCAL_USER_ID;
        knowledgeMetrics = knowledgeImport.value
          .getKnowledgeRepository()
          .getKnowledgeStats(userId, '');
      } catch {
        // Knowledge layer may not be initialized — skip metrics
      }
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
        knowledge: knowledgeMetrics,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to collect control-plane metrics.';
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
