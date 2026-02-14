import { getClientRegistry } from '../../../server/gateway/client-registry';
import { getMemoryProviderKind, getMemoryService } from '../../../server/memory/runtime';
import { getTokenUsageRepository } from '../../../server/stats/tokenUsageRepository';
import { getWorkerRepository } from '../../../server/worker/workerRepository';
import { getLogRepository } from '../../../logging/logRepository';
import type { HealthCheck } from '../../healthTypes';
import { failCheck, okCheck } from '../checkHelpers';

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

export function runWorkerRepositoryCheck(): HealthCheck {
  const start = Date.now();
  try {
    const taskCount = getWorkerRepository().listTasks({ limit: 1_000 }).length;
    return okCheck('core.worker_repository', 'core', start, 'Worker repository reachable.', {
      taskCount,
    });
  } catch (error) {
    return failCheck(
      'core.worker_repository',
      'core',
      start,
      'critical',
      `Worker repository unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
