import { getWorkerRepository } from '../../../server/worker/workerRepository';
import { log } from '../../../logging/logService';
import type { HealthCheck } from '../../healthTypes';
import {
  failCheck,
  formatPercent,
  okCheck,
  resolveMemoryNodeDiagnostics,
  resolveNodeProcessDiagnostics,
  resolveRecentLogWindowStats,
  resolveSystemMemory,
  skippedCheck,
  type MemoryNodeDiagnostics,
  type NodeProcessDiagnostics,
} from '../checkHelpers';

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

export function runErrorBudgetCheck(): HealthCheck {
  const start = Date.now();
  try {
    const stats = resolveRecentLogWindowStats();
    if (stats.total < ERROR_BUDGET_MIN_SAMPLE) {
      return skippedCheck(
        'diagnostics.error_budget',
        'diagnostics',
        `Error budget skipped: insufficient sample size (${stats.total}/${ERROR_BUDGET_MIN_SAMPLE}).`,
        { ...stats },
      );
    }

    const ratio = stats.errors / stats.total;
    if (ratio >= ERROR_BUDGET_CRITICAL_RATIO) {
      return failCheck(
        'diagnostics.error_budget',
        'diagnostics',
        start,
        'critical',
        `Error budget exceeded: ${formatPercent(ratio)} in last ${stats.windowMinutes}m.`,
        { ...stats, ratio },
      );
    }
    if (ratio >= ERROR_BUDGET_WARNING_RATIO) {
      return failCheck(
        'diagnostics.error_budget',
        'diagnostics',
        start,
        'warning',
        `Error budget degraded: ${formatPercent(ratio)} in last ${stats.windowMinutes}m.`,
        { ...stats, ratio },
      );
    }
    return okCheck(
      'diagnostics.error_budget',
      'diagnostics',
      start,
      `Error budget healthy: ${formatPercent(ratio)} in last ${stats.windowMinutes}m.`,
      { ...stats, ratio },
    );
  } catch (error) {
    return failCheck(
      'diagnostics.error_budget',
      'diagnostics',
      start,
      'warning',
      `Error budget check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export function runTaskBacklogCheck(): HealthCheck {
  const start = Date.now();
  try {
    const tasks = getWorkerRepository().listTasks({ limit: 5000 });
    const openTaskCount = tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)).length;
    if (openTaskCount > TASK_BACKLOG_CRITICAL_THRESHOLD) {
      return failCheck(
        'diagnostics.task_backlog',
        'diagnostics',
        start,
        'critical',
        `Task backlog critical: ${openTaskCount} open tasks.`,
        { openTaskCount },
      );
    }
    if (openTaskCount > TASK_BACKLOG_WARNING_THRESHOLD) {
      return failCheck(
        'diagnostics.task_backlog',
        'diagnostics',
        start,
        'warning',
        `Task backlog warning: ${openTaskCount} open tasks.`,
        { openTaskCount },
      );
    }
    return okCheck(
      'diagnostics.task_backlog',
      'diagnostics',
      start,
      `Task backlog healthy: ${openTaskCount} open tasks.`,
      { openTaskCount },
    );
  } catch (error) {
    return failCheck(
      'diagnostics.task_backlog',
      'diagnostics',
      start,
      'warning',
      `Task backlog check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export async function runMemoryPressureCheck(
  detailedMemoryDiagnostics: boolean,
): Promise<HealthCheck> {
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
      const memoryNodes = await resolveMemoryNodeDiagnostics(10);
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

    const check =
      ratio >= MEMORY_PRESSURE_CRITICAL
        ? failCheck(
            'diagnostics.memory_pressure',
            'diagnostics',
            start,
            'critical',
            `Memory pressure critical: ${formatPercent(ratio)} heap usage.`,
            memoryDetails,
          )
        : ratio >= MEMORY_PRESSURE_WARNING
          ? failCheck(
              'diagnostics.memory_pressure',
              'diagnostics',
              start,
              'warning',
              `Memory pressure elevated: ${formatPercent(ratio)} heap usage.`,
              memoryDetails,
            )
          : okCheck(
              'diagnostics.memory_pressure',
              'diagnostics',
              start,
              `Memory pressure healthy: ${formatPercent(ratio)} heap usage.`,
              memoryDetails,
            );

    if (detailedMemoryDiagnostics) {
      try {
        const currentProcess = memoryDetails.currentProcess as Record<string, unknown> | undefined;
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

    return check;
  } catch (error) {
    return failCheck(
      'diagnostics.memory_pressure',
      'diagnostics',
      start,
      'warning',
      `Memory pressure check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

export function runAlertRoutingCheck(): HealthCheck {
  const alertWebhook = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!alertWebhook) {
    return skippedCheck(
      'diagnostics.alert_routing',
      'diagnostics',
      'Alert routing not configured (optional).',
    );
  }

  const start = Date.now();
  try {
    // Validate URL shape so broken config is visible without sending traffic.
    const normalized = new URL(alertWebhook).toString();
    return okCheck('diagnostics.alert_routing', 'diagnostics', start, 'Alert routing configured.', {
      alertWebhook: normalized,
    });
  } catch {
    return failCheck(
      'diagnostics.alert_routing',
      'diagnostics',
      start,
      'warning',
      'Alert routing URL is invalid.',
      { alertWebhook },
    );
  }
}
