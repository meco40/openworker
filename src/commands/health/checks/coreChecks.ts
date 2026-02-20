import { getClientRegistry } from '../../../server/gateway/client-registry';
import { getMemoryProviderKind, getMemoryService } from '../../../server/memory/runtime';
import { getTokenUsageRepository } from '../../../server/stats/tokenUsageRepository';
import { getLogRepository } from '../../../logging/logRepository';
import { resolveKnowledgeConfig } from '../../../server/knowledge/config';
import { getKnowledgeRepository } from '../../../server/knowledge/runtime';
import { LEGACY_LOCAL_USER_ID } from '../../../server/auth/constants';
import type { HealthCheck } from '../../healthTypes';
import { failCheck, okCheck, skippedCheck } from '../checkHelpers';

export function runLoggingRepositoryCheck(): HealthCheck {
  const start = Date.now();
  try {
    const total = getLogRepository().getLogCount();
    return okCheck('core.logging_repository', 'core', start, 'Logging repository reachable.', {
      total,
    });
  } catch (error) {
    return failCheck(
      'core.logging_repository',
      'core',
      start,
      'critical',
      `Logging repository unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export function runStatsRepositoryCheck(): HealthCheck {
  const start = Date.now();
  try {
    const usageEntries = getTokenUsageRepository().getEntryCount();
    return okCheck('core.stats_repository', 'core', start, 'Stats repository reachable.', {
      usageEntries,
    });
  } catch (error) {
    return failCheck(
      'core.stats_repository',
      'core',
      start,
      'critical',
      `Stats repository unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export async function runMemoryRepositoryCheck(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const nodeCount = (await getMemoryService().snapshot()).length;
    const provider = getMemoryProviderKind();
    return okCheck('core.memory_repository', 'core', start, 'Memory repository reachable.', {
      nodeCount,
      provider,
    });
  } catch (error) {
    return failCheck(
      'core.memory_repository',
      'core',
      start,
      'critical',
      `Memory repository unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export function runGatewayRegistryCheck(): HealthCheck {
  const start = Date.now();
  try {
    const activeWsSessions = getClientRegistry().connectionCount;
    return okCheck('core.gateway_registry', 'core', start, 'Gateway registry readable.', {
      activeWsSessions,
    });
  } catch (error) {
    return failCheck(
      'core.gateway_registry',
      'core',
      start,
      'critical',
      `Gateway registry check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

const KNOWLEDGE_LAG_WARNING_MS = 900_000; // 15 minutes

export function runKnowledgeLayerCheck(): HealthCheck {
  const start = Date.now();
  const config = resolveKnowledgeConfig();

  if (!config.layerEnabled) {
    return skippedCheck('core.knowledge_layer', 'core', 'Knowledge layer disabled.');
  }

  try {
    const stats = getKnowledgeRepository().getKnowledgeStats(LEGACY_LOCAL_USER_ID, '');
    const details: Record<string, unknown> = {
      episodeCount: stats.episodeCount,
      ledgerCount: stats.ledgerCount,
      retrievalErrorCount: stats.retrievalErrorCount,
      latestIngestionAt: stats.latestIngestionAt,
      ingestionLagMs: stats.ingestionLagMs,
    };

    if (stats.ingestionLagMs > KNOWLEDGE_LAG_WARNING_MS) {
      return failCheck(
        'core.knowledge_layer',
        'core',
        start,
        'warning',
        `Knowledge ingestion lag exceeds threshold (${Math.round(stats.ingestionLagMs / 1000)}s).`,
        details,
      );
    }

    return okCheck('core.knowledge_layer', 'core', start, 'Knowledge layer healthy.', details);
  } catch (error) {
    return failCheck(
      'core.knowledge_layer',
      'core',
      start,
      'critical',
      `Knowledge layer unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
