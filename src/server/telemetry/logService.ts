/**
 * Central logging service.
 *
 * Writes log entries to SQLite AND broadcasts them over SSE
 * so connected clients receive real-time updates.
 */

import { getLogRepository, type LogEntry, type LogLevel } from './logRepository';
import { getSSEManager } from '../channels/sse/manager';

// ── Source-to-level mapping for existing SystemLog types ─────────

const TYPE_LEVEL_MAP: Record<string, LogLevel> = {
  AUTH: 'info',
  CHAN: 'info',
  TOOL: 'info',
  SYS: 'info',
  MEM: 'info',
  TASK: 'info',
};

/**
 * Persist a log entry and broadcast it via SSE.
 */
export function log(
  level: LogLevel,
  source: string,
  message: string,
  metadata?: Record<string, unknown>,
): LogEntry {
  const repo = getLogRepository();
  const entry = repo.insertLog(level, source.toUpperCase(), message, metadata);

  // Broadcast to all connected SSE clients
  try {
    const sse = getSSEManager();
    sse.broadcast({ type: 'system_log', data: entry });
  } catch {
    // SSE broadcast failure should not break logging
  }

  return entry;
}

/**
 * Bridge for the existing `addEventLog(type, message)` pattern.
 * Maps SystemLog types to log levels automatically.
 */
export function logFromSystemEvent(type: string, message: string): LogEntry {
  const level = TYPE_LEVEL_MAP[type] ?? 'info';

  // Detect error-like messages and escalate level
  const effectiveLevel: LogLevel =
    message.toLowerCase().includes('failed') ||
    message.toLowerCase().includes('error') ||
    message.toLowerCase().includes('lost')
      ? 'error'
      : message.toLowerCase().includes('warning') ||
          message.toLowerCase().includes('spike') ||
          message.toLowerCase().includes('timeout')
        ? 'warn'
        : level;

  return log(effectiveLevel, type, message);
}

/**
 * Structured channel telemetry for omnichannel ingress/egress paths.
 */
export function logChannelEvent(
  direction: 'inbound' | 'outbound',
  channel: string,
  outcome: 'accepted' | 'rejected' | 'failed',
  metadata?: Record<string, unknown>,
): LogEntry {
  const level: LogLevel =
    outcome === 'failed' ? 'error' : outcome === 'rejected' ? 'warn' : 'info';
  return log(level, 'CHAN', `channel.${direction}.${outcome}:${channel}`, metadata);
}
