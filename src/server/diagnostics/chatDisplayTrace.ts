import { safeTracePayload } from './safeTracePayload';

export interface ChatDisplayTraceOptions {
  force?: boolean;
}

const DEFAULT_CHAT_DISPLAY_SLOW_MS = 1000;
const DEFAULT_INBOX_DB_SLOW_MS = 500;

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

export function isChatDisplayTraceEnabled(): boolean {
  return isEnabled(process.env.CHAT_DISPLAY_LOGS) || isEnabled(process.env.INBOX_V2_LOGS);
}

export function getChatDisplaySlowThresholdMs(): number {
  return parseThreshold(process.env.CHAT_DISPLAY_SLOW_MS, DEFAULT_CHAT_DISPLAY_SLOW_MS);
}

export function getInboxDbSlowThresholdMs(): number {
  return parseThreshold(process.env.INBOX_DB_SLOW_MS, DEFAULT_INBOX_DB_SLOW_MS);
}

export function isChatDisplayRequestPath(pathname: string): boolean {
  return (
    pathname === '/api/channels/inbox' ||
    pathname === '/api/channels/messages' ||
    pathname === '/api/channels/conversations' ||
    pathname === '/api/channels/state' ||
    pathname === '/api/skills' ||
    pathname === '/api/personas' ||
    pathname.startsWith('/api/personas/')
  );
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

export function logChatDisplayTrace(
  stage: string,
  payload: Record<string, unknown> = {},
  options: ChatDisplayTraceOptions = {},
): void {
  const forceEnabled =
    isEnabled(process.env.CHAT_DISPLAY_FORCE_LOGS) || isEnabled(process.env.INBOX_V2_FORCE_LOGS);
  if (!isChatDisplayTraceEnabled() && !(options.force && forceEnabled)) return;

  console.info(
    JSON.stringify({
      scope: 'chat.display',
      stage,
      ts: new Date().toISOString(),
      ...safeTracePayload(payload),
      memory: memorySnapshot(),
    }),
  );
}

export function logInboxDbQuery(stage: string, payload: Record<string, unknown>): void {
  const thresholdMs = getInboxDbSlowThresholdMs();
  const durationMs = Number(payload.durationMs || 0);
  const isSlow = durationMs >= thresholdMs;
  logChatDisplayTrace(
    `db.${stage}`,
    {
      ...payload,
      query: stage,
      slow: isSlow,
      slowThresholdMs: thresholdMs,
    },
    { force: isSlow },
  );
}
