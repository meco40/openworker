import { safeTracePayload } from './safeTracePayload';

export interface AutoSessionMemoryTraceOptions {
  force?: boolean;
  level?: 'info' | 'warn' | 'error';
}

const DEFAULT_AUTO_SESSION_MEMORY_SLOW_MS = 1000;

function isEnabled(value: string | undefined): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseThreshold(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function memorySnapshot(): Record<string, number> | undefined {
  if (typeof process.memoryUsage !== 'function') return undefined;
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(usage.heapTotal / 1024 / 1024),
    externalMb: Math.round(usage.external / 1024 / 1024),
  };
}

export function isAutoSessionMemoryTraceEnabled(): boolean {
  return isEnabled(process.env.AUTO_SESSION_MEMORY_LOGS);
}

export function getAutoSessionMemorySlowThresholdMs(): number {
  return parseThreshold(
    process.env.AUTO_SESSION_MEMORY_SLOW_MS,
    DEFAULT_AUTO_SESSION_MEMORY_SLOW_MS,
  );
}

export function logAutoSessionMemoryTrace(
  stage: string,
  payload: Record<string, unknown> = {},
  options: AutoSessionMemoryTraceOptions = {},
): void {
  const forceEnabled = isEnabled(process.env.AUTO_SESSION_MEMORY_FORCE_LOGS);
  if (!isAutoSessionMemoryTraceEnabled() && !(options.force && forceEnabled)) return;

  const entry = JSON.stringify({
    scope: 'chat.auto_session_memory',
    stage,
    ts: new Date().toISOString(),
    ...safeTracePayload(payload),
    memory: memorySnapshot(),
  });

  if (options.level === 'error') {
    console.error(entry);
    return;
  }
  if (options.level === 'warn') {
    console.warn(entry);
    return;
  }
  console.info(entry);
}
