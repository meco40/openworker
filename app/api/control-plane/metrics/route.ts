import { getTokenUsageRepository } from '@/server/stats/tokenUsageRepository';
import { getClientRegistry } from '@/server/gateway/client-registry';
import { getMessageRepository } from '@/server/channels/messages/runtime';
import { getInboxObservabilitySnapshot } from '@/server/channels/inbox/observability';
import { LEGACY_LOCAL_USER_ID } from '@/server/auth/constants';
import { resolveVectorNodeCountSafe } from '@/server/control-plane/vectorNodeCount';
import { withResolvedUserContext } from '../../_shared/withUserContext';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function resolveTodayRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: now.toISOString() };
}

export const GET = withResolvedUserContext(async ({ userContext }) => {
  try {
    const uptimeSeconds = Math.floor(process.uptime());
    const ramUsageBytes = process.memoryUsage().rss;

    const activeWsSessions = getClientRegistry().connectionCount;

    const { from, to } = resolveTodayRange();
    const tokensToday = getTokenUsageRepository().getTotalTokens(from, to).totalTokens;

    const vectorNodeCount = await resolveVectorNodeCountSafe(userContext?.userId);
    const metricsUserId = userContext?.userId || LEGACY_LOCAL_USER_ID;
    const agentRoomMetrics =
      getMessageRepository().getAgentRoomSwarmMetrics?.(metricsUserId) || null;

    let automationMetrics: {
      activeRules: number;
      queuedRuns: number;
      runningRuns: number;
      deadLetterRuns: number;
      leaseAgeSeconds: number | null;
    } | null = null;

    const [automationImport, knowledgeImport] = await Promise.allSettled([
      import('@/server/automation/runtime'),
      import('@/server/knowledge/runtime').then((mod) => ({
        getKnowledgeRepository: mod.getKnowledgeRepository,
      })),
    ]);

    if (automationImport.status === 'fulfilled') {
      automationMetrics = automationImport.value.getAutomationService().getMetrics();
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

    // World Model metrics (Phase 15)
    let worldModelMetrics: {
      mode: string;
      status: string;
      pendingObservations: number;
      outboxDeadLetters: number;
      outboxAgeMs: number;
      dueOpenLoops: number;
      projectionLagMs: number;
      embeddingsTotal: number;
      graphitiReachable?: boolean;
    } | null = null;

    try {
      const { getWorldModelMetrics, worldModelHealthStatus } =
        await import('@/server/world-model/metrics');
      const wmMetrics = await getWorldModelMetrics();
      worldModelMetrics = {
        mode: wmMetrics.mode,
        status: worldModelHealthStatus(wmMetrics),
        pendingObservations: wmMetrics.pendingObservations,
        outboxDeadLetters: wmMetrics.outboxDeadLetters,
        outboxAgeMs: wmMetrics.outboxAgeMs,
        dueOpenLoops: wmMetrics.dueOpenLoops,
        projectionLagMs: wmMetrics.projectionLagMs,
        embeddingsTotal: wmMetrics.embeddingsTotal,
        graphitiReachable: wmMetrics.graphitiReachable,
      };
    } catch {
      // World Model may not be enabled or DB unavailable — skip
    }

    return Response.json({
      ok: true,
      metrics: {
        uptimeSeconds,
        activeWsSessions,
        tokensToday,
        vectorNodeCount,
        ramUsageBytes,
        agentRoom: agentRoomMetrics,
        automation: automationMetrics,
        inbox: getInboxObservabilitySnapshot(),
        rooms: null,
        knowledge: knowledgeMetrics,
        worldModel: worldModelMetrics,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to collect control-plane metrics.';
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
