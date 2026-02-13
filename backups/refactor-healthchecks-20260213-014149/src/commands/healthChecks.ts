import { getClientRegistry } from '../server/gateway/client-registry';
import { getMemoryRepository } from '../server/memory/runtime';
import { buildSecurityStatusSnapshot } from '../server/security/status';
import { getTokenUsageRepository } from '../server/stats/tokenUsageRepository';
import { getWorkerRepository } from '../server/worker/workerRepository';
import { getLogRepository } from '../logging/logRepository';
import { log } from '../logging/logService';
import type { HealthCheck, HealthCheckStatus, HealthCommandOptions } from './healthTypes';
import {
  elapsedMs,
  failCheck,
  formatPercent,
  okCheck,
  resolveMemoryNodeDiagnostics,
  resolveNodeProcessDiagnostics,
  resolveRecentLogWindowStats,
  resolveSystemMemory,
  runBridgeHealthCheck,
  skippedCheck,
  type MemoryNodeDiagnostics,
  type NodeProcessDiagnostics,
} from './health/checkHelpers';
const ERROR_BUDGET_MIN_SAMPLE = 20;
const ERROR_BUDGET_WARNING_RATIO = 0.05;
const ERROR_BUDGET_CRITICAL_RATIO = 0.1;
const TASK_BACKLOG_WARNING_THRESHOLD = 20;
const TASK_BACKLOG_CRITICAL_THRESHOLD = 50;
const MEMORY_PRESSURE_WARNING = 0.8;
const MEMORY_PRESSURE_CRITICAL = 0.9;
const OPEN_TASK_STATUSES = new Set([
  'queued',
  'planning',
  'clarifying',
  'executing',
  'review',
  'waiting_approval',
]);

export async function runHealthChecks(options: HealthCommandOptions = {}): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const detailedMemoryDiagnostics = options.memoryDiagnosticsEnabled === true;

  {
    const start = Date.now();
    try {
      const total = getLogRepository().getLogCount();
      checks.push(
        okCheck('core.logging_repository', 'core', start, 'Logging repository reachable.', {
          total,
        }),
      );
    } catch (error) {
      checks.push(
        failCheck(
          'core.logging_repository',
          'core',
          start,
          'critical',
          `Logging repository unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ),
      );
    }
  }

  {
    const start = Date.now();
    try {
      const taskCount = getWorkerRepository().listTasks({ limit: 1_000 }).length;
      checks.push(
        okCheck('core.worker_repository', 'core', start, 'Worker repository reachable.', {
          taskCount,
        }),
      );
    } catch (error) {
      checks.push(
        failCheck(
          'core.worker_repository',
          'core',
          start,
          'critical',
          `Worker repository unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ),
      );
    }
  }

  {
    const start = Date.now();
    try {
      const usageEntries = getTokenUsageRepository().getEntryCount();
      checks.push(
        okCheck('core.stats_repository', 'core', start, 'Stats repository reachable.', {
          usageEntries,
        }),
      );
    } catch (error) {
      checks.push(
        failCheck(
          'core.stats_repository',
          'core',
          start,
          'critical',
          `Stats repository unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ),
      );
    }
  }

  {
    const start = Date.now();
    try {
      const nodeCount = getMemoryRepository().getStorageSnapshot(1).summary.totalNodes;
      checks.push(
        okCheck('core.memory_repository', 'core', start, 'Memory repository reachable.', {
          nodeCount,
        }),
      );
    } catch (error) {
      checks.push(
        failCheck(
          'core.memory_repository',
          'core',
          start,
          'critical',
          `Memory repository unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ),
      );
    }
  }

  {
    const start = Date.now();
    try {
      const snapshot = buildSecurityStatusSnapshot();
      const status: HealthCheckStatus =
        snapshot.summary.critical > 0
          ? 'critical'
          : snapshot.summary.warning > 0
            ? 'warning'
            : 'ok';
      checks.push({
        id: 'security.snapshot',
        category: 'security',
        status,
        message:
          status === 'ok'
            ? 'Security snapshot healthy.'
            : status === 'warning'
              ? 'Security snapshot contains warnings.'
              : 'Security snapshot contains critical findings.',
        latencyMs: elapsedMs(start),
        details: {
          summary: snapshot.summary,
          channels: snapshot.channels,
        },
      });
    } catch (error) {
      checks.push(
        failCheck(
          'security.snapshot',
          'security',
          start,
          'critical',
          `Security snapshot failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ),
      );
    }
  }

  {
    const start = Date.now();
    try {
      const activeWsSessions = getClientRegistry().connectionCount;
      checks.push(
        okCheck('core.gateway_registry', 'core', start, 'Gateway registry readable.', {
          activeWsSessions,
        }),
      );
    } catch (error) {
      checks.push(
        failCheck(
          'core.gateway_registry',
          'core',
          start,
          'critical',
          `Gateway registry check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ),
      );
    }
  }

  {
    const start = Date.now();
    try {
      const stats = resolveRecentLogWindowStats();
      if (stats.total < ERROR_BUDGET_MIN_SAMPLE) {
        checks.push(
          skippedCheck(
            'diagnostics.error_budget',
            'diagnostics',
            `Error budget skipped: insufficient sample size (${stats.total}/${ERROR_BUDGET_MIN_SAMPLE}).`,
            { ...stats },
          ),
        );
      } else {
        const ratio = stats.errors / stats.total;
        if (ratio >= ERROR_BUDGET_CRITICAL_RATIO) {
          checks.push(
            failCheck(
              'diagnostics.error_budget',
              'diagnostics',
              start,
              'critical',
              `Error budget exceeded: ${formatPercent(ratio)} in last ${stats.windowMinutes}m.`,
              { ...stats, ratio },
            ),
          );
        } else if (ratio >= ERROR_BUDGET_WARNING_RATIO) {
          checks.push(
            failCheck(
              'diagnostics.error_budget',
              'diagnostics',
              start,
              'warning',
              `Error budget degraded: ${formatPercent(ratio)} in last ${stats.windowMinutes}m.`,
              { ...stats, ratio },
            ),
          );
        } else {
          checks.push(
            okCheck(
              'diagnostics.error_budget',
              'diagnostics',
              start,
              `Error budget healthy: ${formatPercent(ratio)} in last ${stats.windowMinutes}m.`,
              { ...stats, ratio },
            ),
          );
        }
      }
    } catch (error) {
      checks.push(
        failCheck(
          'diagnostics.error_budget',
          'diagnostics',
          start,
          'warning',
          `Error budget check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ),
      );
    }
  }

  {
    const start = Date.now();
    try {
      const tasks = getWorkerRepository().listTasks({ limit: 5000 });
      const openTaskCount = tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)).length;
      if (openTaskCount > TASK_BACKLOG_CRITICAL_THRESHOLD) {
        checks.push(
          failCheck(
            'diagnostics.task_backlog',
            'diagnostics',
            start,
            'critical',
            `Task backlog critical: ${openTaskCount} open tasks.`,
            { openTaskCount },
          ),
        );
      } else if (openTaskCount > TASK_BACKLOG_WARNING_THRESHOLD) {
        checks.push(
          failCheck(
            'diagnostics.task_backlog',
            'diagnostics',
            start,
            'warning',
            `Task backlog warning: ${openTaskCount} open tasks.`,
            { openTaskCount },
          ),
        );
      } else {
        checks.push(
          okCheck(
            'diagnostics.task_backlog',
            'diagnostics',
            start,
            `Task backlog healthy: ${openTaskCount} open tasks.`,
            { openTaskCount },
          ),
        );
      }
    } catch (error) {
      checks.push(
        failCheck(
          'diagnostics.task_backlog',
          'diagnostics',
          start,
          'warning',
          `Task backlog check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ),
      );
    }
  }

  {
    const start = Date.now();
    try {
      const usage = process.memoryUsage();
      const ratio = usage.heapTotal > 0 ? usage.heapUsed / usage.heapTotal : 0;
      const memoryDetails: Record<string, unknown> = {
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        ratio,
      };
      if (detailedMemoryDiagnostics) {
        const nodeProcesses = await resolveNodeProcessDiagnostics(10);
        const memoryNodes = resolveMemoryNodeDiagnostics(10);
        Object.assign(memoryDetails, {
          rss: usage.rss,
          external: usage.external,
          arrayBuffers: usage.arrayBuffers,
          currentProcess: {
            pid: process.pid,
            uptimeSec: Math.round(process.uptime()),
            heapUsedBytes: usage.heapUsed,
            heapTotalBytes: usage.heapTotal,
            rssBytes: usage.rss,
            externalBytes: usage.external,
            arrayBuffersBytes: usage.arrayBuffers,
          },
          nodeProcesses,
          memoryNodes,
          systemMemory: resolveSystemMemory(),
        });
      }

      if (ratio >= MEMORY_PRESSURE_CRITICAL) {
        checks.push(
          failCheck(
            'diagnostics.memory_pressure',
            'diagnostics',
            start,
            'critical',
            `Memory pressure critical: ${formatPercent(ratio)} heap usage.`,
            memoryDetails,
          ),
        );
      } else if (ratio >= MEMORY_PRESSURE_WARNING) {
        checks.push(
          failCheck(
            'diagnostics.memory_pressure',
            'diagnostics',
            start,
            'warning',
            `Memory pressure elevated: ${formatPercent(ratio)} heap usage.`,
            memoryDetails,
          ),
        );
      } else {
        checks.push(
          okCheck(
            'diagnostics.memory_pressure',
            'diagnostics',
            start,
            `Memory pressure healthy: ${formatPercent(ratio)} heap usage.`,
            memoryDetails,
          ),
        );
      }

      if (detailedMemoryDiagnostics) {
        try {
          const currentProcess = memoryDetails.currentProcess as
            | Record<string, unknown>
            | undefined;
          const nodeProcesses = memoryDetails.nodeProcesses as NodeProcessDiagnostics | undefined;
          const memoryNodes = memoryDetails.memoryNodes as MemoryNodeDiagnostics | undefined;
          const memoryLogLevel =
            ratio >= MEMORY_PRESSURE_CRITICAL
              ? 'error'
              : ratio >= MEMORY_PRESSURE_WARNING
                ? 'warn'
                : 'info';
          log(
            memoryLogLevel,
            'MEM',
            `memory.diagnostics.sample:${formatPercent(ratio)} heap usage`,
            {
              ratio,
              currentProcess,
              nodeProcesses: nodeProcesses?.topByRss.slice(0, 5) ?? [],
              memoryNodes: {
                summary: memoryNodes?.summary,
                byType: memoryNodes?.byType.slice(0, 5) ?? [],
                largestNodes: memoryNodes?.largestNodes.slice(0, 5) ?? [],
              },
            },
            'diagnostics',
          );
        } catch {
          // Logging failures should not alter memory pressure status.
        }
      }
    } catch (error) {
      checks.push(
        failCheck(
          'diagnostics.memory_pressure',
          'diagnostics',
          start,
          'warning',
          `Memory pressure check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ),
      );
    }
  }

  {
    const alertWebhook = process.env.ALERT_WEBHOOK_URL?.trim();
    if (!alertWebhook) {
      checks.push(
        skippedCheck(
          'diagnostics.alert_routing',
          'diagnostics',
          'Alert routing not configured (optional).',
        ),
      );
    } else {
      const start = Date.now();
      try {
        // Validate URL shape so broken config is visible without sending traffic.
        const normalized = new URL(alertWebhook).toString();
        checks.push(
          okCheck('diagnostics.alert_routing', 'diagnostics', start, 'Alert routing configured.', {
            alertWebhook: normalized,
          }),
        );
      } catch {
        checks.push(
          failCheck(
            'diagnostics.alert_routing',
            'diagnostics',
            start,
            'warning',
            'Alert routing URL is invalid.',
            { alertWebhook },
          ),
        );
      }
    }
  }

  checks.push(
    await runBridgeHealthCheck(
      'integration.whatsapp_bridge',
      'whatsapp',
      'WHATSAPP_BRIDGE_URL',
      options,
    ),
  );
  checks.push(
    await runBridgeHealthCheck(
      'integration.imessage_bridge',
      'imessage',
      'IMESSAGE_BRIDGE_URL',
      options,
    ),
  );

  return checks;
}
