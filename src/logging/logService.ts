import { broadcastToSubscribed } from '../server/gateway/broadcast';
import { GatewayEvents } from '../server/gateway/events';
import { getLogRepository } from './logRepository';
import type { LogCategory, LogEntry, LogLevel } from './logTypes';

const TYPE_LEVEL_MAP: Record<string, LogLevel> = {
  AUTH: 'info',
  CHAN: 'info',
  TOOL: 'info',
  SYS: 'info',
  MEM: 'info',
  TASK: 'info',
};

const SOURCE_CATEGORY_MAP: Record<string, LogCategory> = {
  AUTH: 'security',
  CHAN: 'channel',
  TOOL: 'tooling',
  SYS: 'system',
  MEM: 'memory',
  TASK: 'worker',
  BRIDGE: 'integration',
  GATEWAY: 'system',
};

function resolveCategory(source: string, fallback: LogCategory = 'system'): LogCategory {
  return SOURCE_CATEGORY_MAP[source.toUpperCase()] ?? fallback;
}

export function log(
  level: LogLevel,
  source: string,
  message: string,
  metadata?: Record<string, unknown>,
  category?: LogCategory,
): LogEntry {
  const repo = getLogRepository();
  const normalizedSource = source.toUpperCase();
  const entry = repo.insertLog(
    level,
    normalizedSource,
    message,
    metadata,
    category ?? resolveCategory(normalizedSource),
  );
  broadcastToSubscribed('logs', GatewayEvents.LOG_ENTRY, entry);
  return entry;
}

export function logFromSystemEvent(type: string, message: string): LogEntry {
  const level = TYPE_LEVEL_MAP[type] ?? 'info';
  const lowerMessage = message.toLowerCase();

  const effectiveLevel: LogLevel =
    lowerMessage.includes('failed') ||
    lowerMessage.includes('error') ||
    lowerMessage.includes('lost')
      ? 'error'
      : lowerMessage.includes('warning') ||
          lowerMessage.includes('spike') ||
          lowerMessage.includes('timeout')
        ? 'warn'
        : level;

  return log(effectiveLevel, type, message);
}

export function logChannelEvent(
  direction: 'inbound' | 'outbound',
  channel: string,
  outcome: 'accepted' | 'rejected' | 'failed',
  metadata?: Record<string, unknown>,
): LogEntry {
  const level: LogLevel = outcome === 'failed' ? 'error' : outcome === 'rejected' ? 'warn' : 'info';
  return log(level, 'CHAN', `channel.${direction}.${outcome}:${channel}`, metadata, 'channel');
}
