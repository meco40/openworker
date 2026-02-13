import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCredentialStore } from '../../server/channels/credentials';
import { getMemoryRepository } from '../../server/memory/runtime';
import type { MemoryStorageSnapshot } from '../../server/memory/sqliteMemoryRepository';
import { getLogRepository } from '../../logging/logRepository';
import type { HealthCheck, HealthCheckStatus, HealthCommandOptions } from '../healthTypes';

export const DEFAULT_TIMEOUT_MS = 3000;
export const ERROR_BUDGET_WINDOW_MS = 15 * 60 * 1000;
const PROCESS_DISCOVERY_TIMEOUT_MS = 1_200;
const execFileAsync = promisify(execFile);

export interface NodeProcessMemoryUsage {
  pid: number;
  rssBytes: number;
  privateBytes: number | null;
  command: string;
  isCurrent: boolean;
}

export interface NodeProcessDiagnostics {
  totalTracked: number;
  topByRss: NodeProcessMemoryUsage[];
  collectionError?: string;
}

export interface MemoryNodeDiagnostics {
  summary: MemoryStorageSnapshot['summary'];
  byType: MemoryStorageSnapshot['byType'];
  largestNodes: MemoryStorageSnapshot['largestNodes'];
  collectionError?: string;
}

export function elapsedMs(start: number): number {
  return Date.now() - start;
}

export function okCheck(
  id: string,
  category: HealthCheck['category'],
  start: number,
  message: string,
  details?: Record<string, unknown>,
): HealthCheck {
  return { id, category, status: 'ok', message, details, latencyMs: elapsedMs(start) };
}

export function failCheck(
  id: string,
  category: HealthCheck['category'],
  start: number,
  status: Exclude<HealthCheckStatus, 'ok' | 'skipped'>,
  message: string,
  details?: Record<string, unknown>,
): HealthCheck {
  return { id, category, status, message, details, latencyMs: elapsedMs(start) };
}

export function skippedCheck(
  id: string,
  category: HealthCheck['category'],
  message: string,
  details?: Record<string, unknown>,
): HealthCheck {
  return { id, category, status: 'skipped', message, details, latencyMs: 0 };
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function resolveRecentLogWindowStats(): { total: number; errors: number; windowMinutes: number } {
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

export function normalizeCommand(command: string): string {
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

export function resolveMemoryNodeDiagnostics(limit = 8): MemoryNodeDiagnostics {
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

export async function resolveNodeProcessDiagnostics(limit = 8): Promise<NodeProcessDiagnostics> {
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

export async function runBridgeHealthCheck(
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

export function resolveSystemMemory(): { totalBytes: number; freeBytes: number } {
  return { totalBytes: os.totalmem(), freeBytes: os.freemem() };
}
