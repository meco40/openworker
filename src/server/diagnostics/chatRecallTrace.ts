import { safeTracePayload } from './safeTracePayload';

export interface ChatRecallTraceOptions {
  force?: boolean;
  level?: 'info' | 'warn' | 'error';
}

const DEFAULT_CHAT_RECALL_SLOW_MS = 1500;
const DEFAULT_PREVIEW_LIMIT = 120;

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

export function isChatRecallTraceEnabled(): boolean {
  return isEnabled(process.env.CHAT_RECALL_LOGS);
}

export function getChatRecallSlowThresholdMs(): number {
  return parseThreshold(process.env.CHAT_RECALL_SLOW_MS, DEFAULT_CHAT_RECALL_SLOW_MS);
}

export function previewRecallText(value: string, maxLength = DEFAULT_PREVIEW_LIMIT): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function logChatRecallTrace(
  stage: string,
  payload: Record<string, unknown> = {},
  options: ChatRecallTraceOptions = {},
): void {
  const forceEnabled = isEnabled(process.env.CHAT_RECALL_FORCE_LOGS);
  if (!isChatRecallTraceEnabled() && !(options.force && forceEnabled)) return;

  const entry = JSON.stringify({
    scope: 'chat.recall',
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
