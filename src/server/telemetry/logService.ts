/**
 * Central logging service.
 *
 * Writes log entries to SQLite AND broadcasts them over SSE
 * so connected clients receive real-time updates.
 */

import { getLogRepository, type LogEntry, type LogLevel } from './logRepository';
import { getSSEManager } from '../channels/sse/manager';
import type { broadcastToSubscribed as BroadcastToSubscribedFn } from '../gateway/broadcast';

// Cached gateway broadcast (loaded lazily for ESM compatibility)
let _wsBroadcastToSubscribed: typeof BroadcastToSubscribedFn | null = null;
let _wsImportAttempted = false;

async function loadGatewayBroadcast() {
  if (_wsImportAttempted) return;
  _wsImportAttempted = true;
  try {
    const mod = await import('../gateway/broadcast');
    _wsBroadcastToSubscribed = mod.broadcastToSubscribed;
  } catch { /* Gateway not available */ }
}
loadGatewayBroadcast();

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

  // Broadcast to all connected SSE clients (also bridges to WS)
  try {
    const sse = getSSEManager();
    sse.broadcast({ type: 'system_log', data: entry });
  } catch {
    // SSE broadcast failure should not break logging
  }

  // Native WS broadcast to subscribed log clients
  if (_wsBroadcastToSubscribed) {
    try {
      _wsBroadcastToSubscribed('logs', 'log.entry', entry);
    } catch { /* ignore */ }
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
