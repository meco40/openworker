import { getClientRegistry } from '../server/gateway/client-registry';
import { getCredentialStore } from '../server/channels/credentials';
import { getMemoryService } from '../server/memory/runtime';
import { buildSecurityStatusSnapshot } from '../server/security/status';
import { getTokenUsageRepository } from '../server/stats/tokenUsageRepository';
import { getWorkerRepository } from '../server/worker/workerRepository';
import { getLogRepository } from '../logging/logRepository';
import type { HealthCheck, HealthCheckStatus, HealthCommandOptions } from './healthTypes';

const DEFAULT_TIMEOUT_MS = 3000;

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
      const nodeCount = getMemoryService().snapshot().length;
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
