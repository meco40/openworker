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

export const GET = withResolvedUserContext(async ({ request, userContext }) => {
  try {
    const uptimeSeconds = Math.floor(process.uptime());
    const ramUsageBytes = process.memoryUsage().rss;

    const activeWsSessions = getClientRegistry().connectionCount;

    const { from, to } = resolveTodayRange();
    const tokensToday = getTokenUsageRepository().getTotalTokens(from, to).totalTokens;
    const vectorNodeCountPromise = resolveVectorNodeCountSafe(userContext?.userId);

    if (new URL(request.url).searchParams.get('scope') === 'shell') {
      const vectorNodeCount = await vectorNodeCountPromise;
      return Response.json({
        ok: true,
        metrics: {
          uptimeSeconds,
          activeWsSessions,
          tokensToday,
          vectorNodeCount,
          ramUsageBytes,
          generatedAt: new Date().toISOString(),
        },
      });
    }

    const metricsUserId = userContext?.userId || LEGACY_LOCAL_USER_ID;
    const agentRoomMetrics =
      getMessageRepository().getAgentRoomSwarmMetrics?.(metricsUserId) || null;

    const optionalImportsPromise = Promise.allSettled([
      import('@/server/automation/runtime'),
      import('@/server/knowledge/runtime').then((mod) => ({
        getKnowledgeRepository: mod.getKnowledgeRepository,
      })),
    ]);
    const worldModelMetricsPromise = (async () => {
      try {
        const { getWorldModelMetrics, worldModelHealthStatus } =
          await import('@/server/world-model/metrics');
        const metrics = await getWorldModelMetrics();
        return {
          mode: metrics.mode,
          status: worldModelHealthStatus(metrics),
          pendingObservations: metrics.pendingObservations,
          outboxDeadLetters: metrics.outboxDeadLetters,
          outboxAgeMs: metrics.outboxAgeMs,
          dueOpenLoops: metrics.dueOpenLoops,
          projectionLagMs: metrics.projectionLagMs,
          embeddingsTotal: metrics.embeddingsTotal,
          graphitiReachable: metrics.graphitiReachable,
        };
      } catch {
        return null;
      }
    })();

    const [vectorNodeCount, [automationImport, knowledgeImport], worldModelMetrics] =
      await Promise.all([vectorNodeCountPromise, optionalImportsPromise, worldModelMetricsPromise]);

    let automationMetrics: {
      activeRules: number;
      queuedRuns: number;
      runningRuns: number;
      deadLetterRuns: number;
      leaseAgeSeconds: number | null;
    } | null = null;

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
