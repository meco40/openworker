import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getClientRegistry } from '../server/gateway/client-registry';
import { getCredentialStore } from '../server/channels/credentials';
import { getMemoryRepository } from '../server/memory/runtime';
import type { MemoryStorageSnapshot } from '../server/memory/sqliteMemoryRepository';
import { buildSecurityStatusSnapshot } from '../server/security/status';
import { getTokenUsageRepository } from '../server/stats/tokenUsageRepository';
import { getWorkerRepository } from '../server/worker/workerRepository';
import { getLogRepository } from '../logging/logRepository';
import { log } from '../logging/logService';
import type { HealthCheck, HealthCheckStatus, HealthCommandOptions } from './healthTypes';

const DEFAULT_TIMEOUT_MS = 3000;
const PROCESS_DISCOVERY_TIMEOUT_MS = 1_200;
const ERROR_BUDGET_WINDOW_MS = 15 * 60 * 1000;
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
const execFileAsync = promisify(execFile);

interface NodeProcessMemoryUsage {
  pid: number;
  rssBytes: number;
  privateBytes: number | null;
  command: string;
  isCurrent: boolean;
}

interface NodeProcessDiagnostics {
  totalTracked: number;
  topByRss: NodeProcessMemoryUsage[];
  collectionError?: string;
}

interface MemoryNodeDiagnostics {
  summary: MemoryStorageSnapshot['summary'];
  byType: MemoryStorageSnapshot['byType'];
  largestNodes: MemoryStorageSnapshot['largestNodes'];
  collectionError?: string;
}

function elapsedMs(start: number): number {
  return Date.now() - start;
}

function okCheck(
  id: string,
  category: HealthCheck['category'],
  start: number,
  message: string,
  details?: Record<string, unknown>,
): HealthCheck {
  return { id, category, status: 'ok', message, details, latencyMs: elapsedMs(start) };
}

function failCheck(
  id: string,
  category: HealthCheck['category'],
  start: number,
  status: Exclude<HealthCheckStatus, 'ok' | 'skipped'>,
  message: string,
  details?: Record<string, unknown>,
): HealthCheck {
  return { id, category, status, message, details, latencyMs: elapsedMs(start) };
}

function skippedCheck(
  id: string,
  category: HealthCheck['category'],
  message: string,
  details?: Record<string, unknown>,
): HealthCheck {
  return { id, category, status: 'skipped', message, details, latencyMs: 0 };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function resolveRecentLogWindowStats(): { total: number; errors: number; windowMinutes: number } {
  const threshold = Date.now() - ERROR_BUDGET_WINDOW_MS;
  const logs = getLogRepository().listLogs({ limit: 4000 });
  let total = 0;
  let errors = 0;

  for (const entry of logs) {
    if (
      entry.category === 'diagnostics' &&
      entry.source === 'MEM' &&
      entry.message.startsWith('memory.diagnostics.sample')
    ) {
      continue;
    }
    const ts = Date.parse(entry.createdAt || entry.timestamp);
    if (!Number.isFinite(ts) || ts < threshold) {
      continue;
    }
    total += 1;
    if (entry.level === 'error') {
      errors += 1;
    }
  }

  return { total, errors, windowMinutes: ERROR_BUDGET_WINDOW_MS / 60_000 };
}

function normalizeCommand(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function emptyMemoryNodeDiagnostics(error?: string): MemoryNodeDiagnostics {
  return {
    summary: {
      totalNodes: 0,
      totalBytes: 0,
      contentBytes: 0,
      embeddingBytes: 0,
      metadataBytes: 0,
    },
    byType: [],
    largestNodes: [],
    collectionError: error,
  };
}

function resolveMemoryNodeDiagnostics(limit = 8): MemoryNodeDiagnostics {
  try {
    const snapshot = getMemoryRepository().getStorageSnapshot(limit);
    return {
      summary: snapshot.summary,
      byType: snapshot.byType,
      largestNodes: snapshot.largestNodes,
    };
  } catch (error) {
    return emptyMemoryNodeDiagnostics(
      error instanceof Error ? error.message : 'Unknown memory-node diagnostics error',
    );
  }
}

async function resolveNodeProcessDiagnostics(limit = 8): Promise<NodeProcessDiagnostics> {
  try {
    if (process.platform === 'win32') {
      const script = [
        "$items = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | ForEach-Object {",
        '  [PSCustomObject]@{',
        '    pid = $_.ProcessId;',
        '    rssBytes = [int64]$_.WorkingSetSize;',
        '    privateBytes = [int64]$_.PrivatePageCount;',
        '    command = $_.CommandLine',
        '  }',
        '};',
        '$items | ConvertTo-Json -Compress',
      ].join(' ');
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', script],
        { timeout: PROCESS_DISCOVERY_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      const raw = stdout?.trim();
      if (!raw) {
        return { totalTracked: 0, topByRss: [] };
      }
      const parsed = JSON.parse(raw) as
        | { pid?: number; rssBytes?: number; privateBytes?: number; command?: string }
        | Array<{ pid?: number; rssBytes?: number; privateBytes?: number; command?: string }>;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const normalized = rows
        .filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.rssBytes))
        .map((row) => ({
          pid: Number(row.pid),
          rssBytes: Number(row.rssBytes),
          privateBytes: Number.isFinite(row.privateBytes) ? Number(row.privateBytes) : null,
          command: normalizeCommand(String(row.command || 'node')),
          isCurrent: Number(row.pid) === process.pid,
        }))
        .sort((a, b) => b.rssBytes - a.rssBytes);

      return {
        totalTracked: normalized.length,
        topByRss: normalized.slice(0, Math.max(1, limit)),
      };
    }

    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,rss=,comm=,args='], {
      timeout: PROCESS_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const parsedRows: NodeProcessMemoryUsage[] = [];
    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const rssKb = Number(match[2]);
      const command = match[4] || match[3] || 'node';
      const lower = `${match[3]} ${command}`.toLowerCase();
      if (!lower.includes('node')) {
        continue;
      }
      parsedRows.push({
        pid,
        rssBytes: rssKb * 1024,
        privateBytes: null,
        command: normalizeCommand(command),
        isCurrent: pid === process.pid,
      });
    }

    parsedRows.sort((a, b) => b.rssBytes - a.rssBytes);
    return {
      totalTracked: parsedRows.length,
      topByRss: parsedRows.slice(0, Math.max(1, limit)),
    };
  } catch (error) {
    return {
      totalTracked: 0,
      topByRss: [],
      collectionError: error instanceof Error ? error.message : 'Node process discovery failed',
    };
  }
}

async function runBridgeHealthCheck(
  id: string,
  channel: 'whatsapp' | 'imessage',
  envName: 'WHATSAPP_BRIDGE_URL' | 'IMESSAGE_BRIDGE_URL',
  options: HealthCommandOptions,
): Promise<HealthCheck> {
  const bridgeUrl = process.env[envName]?.trim();
  if (!bridgeUrl) {
    return skippedCheck(id, 'integration', `${envName} not configured.`);
  }
  const pairingStatus = (() => {
    try {
      return getCredentialStore().getCredential(channel, 'pairing_status');
    } catch {
      return null;
    }
  })();
  if (pairingStatus !== 'connected') {
    return skippedCheck(
      id,
      'integration',
      `${channel} bridge check skipped (channel not paired).`,
      { envName, configured: true, paired: false },
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${bridgeUrl.replace(/\/$/, '')}/health`;
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return failCheck(id, 'integration', start, 'warning', `Bridge health failed with ${response.status}.`, {
        url,
        status: response.status,
      });
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return okCheck(id, 'integration', start, 'Bridge health check passed.', payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown bridge health error';
    const isTimeout =
      (error instanceof Error && error.name === 'AbortError') ||
      message.toLowerCase().includes('timeout') ||
      message.toLowerCase().includes('timed out');
    return failCheck(id, 'integration', start, isTimeout ? 'critical' : 'warning', `Bridge health check failed: ${message}`, {
      bridgeUrl,
      timeoutMs,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function runHealthChecks(options: HealthCommandOptions = {}): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const detailedMemoryDiagnostics = options.memoryDiagnosticsEnabled === true;

  {
    const start = Date.now();
    try {
      const total = getLogRepository().getLogCount();
      checks.push(okCheck('core.logging_repository', 'core', start, 'Logging repository reachable.', { total }));
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
      checks.push(okCheck('core.worker_repository', 'core', start, 'Worker repository reachable.', { taskCount }));
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
      checks.push(okCheck('core.stats_repository', 'core', start, 'Stats repository reachable.', { usageEntries }));
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
      checks.push(okCheck('core.memory_repository', 'core', start, 'Memory repository reachable.', { nodeCount }));
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
        snapshot.summary.critical > 0 ? 'critical' : snapshot.summary.warning > 0 ? 'warning' : 'ok';
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
      checks.push(okCheck('core.gateway_registry', 'core', start, 'Gateway registry readable.', { activeWsSessions }));
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
          systemMemory: {
            totalBytes: os.totalmem(),
            freeBytes: os.freemem(),
          },
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
          const currentProcess = memoryDetails.currentProcess as Record<string, unknown> | undefined;
          const nodeProcesses = memoryDetails.nodeProcesses as NodeProcessDiagnostics | undefined;
          const memoryNodes = memoryDetails.memoryNodes as MemoryNodeDiagnostics | undefined;
          const memoryLogLevel = ratio >= MEMORY_PRESSURE_CRITICAL
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
          okCheck(
            'diagnostics.alert_routing',
            'diagnostics',
            start,
            'Alert routing configured.',
            { alertWebhook: normalized },
          ),
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
