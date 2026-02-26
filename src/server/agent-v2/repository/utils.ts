import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { AGENT_V2_SCHEMA_VERSION } from '@/server/agent-v2/types';
import type {
  AgentCommand,
  AgentSessionSnapshot,
  AgentV2CommandStatus,
  AgentV2EventEnvelope,
  AgentV2EventType,
  AgentV2SessionStatus,
} from '@/server/agent-v2/types';
import { AgentV2Error } from '@/server/agent-v2/errors';
import type { CommandRow, EventRow, SessionRow } from './types';

export const REPLAY_RETENTION_HOURS = 24;

export function normalizeIdempotencyKey(value?: string): string | null {
  const normalized = String(value || '').trim();
  return normalized ? normalized : null;
}

export function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function replayCutoffIso(now = new Date()): string {
  return new Date(now.getTime() - REPLAY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
}

export function resolveSessionStatusAfterCommand(
  commandStatus: AgentV2CommandStatus,
  hasQueuedCommands: boolean,
): AgentV2SessionStatus {
  if (commandStatus === 'aborted') return 'aborted';
  if (commandStatus === 'failed_recoverable') return 'error_recoverable';
  if (commandStatus === 'failed') return 'error';
  if (hasQueuedCommands) return 'idle';
  return 'idle';
}

export function toAgentCommand(row: CommandRow): AgentCommand {
  return {
    id: row.id,
    sessionId: row.session_id,
    commandType: row.command_type,
    priority: row.priority,
    status: row.status,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json) ?? {},
    idempotencyKey: row.idempotency_key,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    result: safeJsonParse<Record<string, unknown>>(row.result_json),
  };
}

export function toEventEnvelope(row: EventRow): AgentV2EventEnvelope {
  return {
    schemaVersion: AGENT_V2_SCHEMA_VERSION,
    eventId: row.id,
    sessionId: row.session_id,
    commandId: row.command_id,
    seq: row.seq,
    emittedAt: row.emitted_at,
    type: row.type,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json) ?? {},
  };
}

// Internal helper functions that need db access
export function getSessionRow(
  db: BetterSqlite3.Database,
  sessionId: string,
  userId: string,
): SessionRow | null {
  const row = db
    .prepare(
      `
      SELECT *
      FROM agent_v2_sessions
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `,
    )
    .get(sessionId, userId) as SessionRow | undefined;
  return row ?? null;
}

export function getSessionRowOrThrow(
  db: BetterSqlite3.Database,
  sessionId: string,
  userId: string,
): SessionRow {
  const row = getSessionRow(db, sessionId, userId);
  if (!row) {
    throw new AgentV2Error('Session not found.', 'NOT_FOUND');
  }
  return row;
}

export function getCommandRowOrThrow(
  db: BetterSqlite3.Database,
  commandId: string,
  sessionId: string,
): CommandRow {
  const row = db
    .prepare(
      `
      SELECT *
      FROM agent_v2_commands
      WHERE id = ? AND session_id = ?
      LIMIT 1
    `,
    )
    .get(commandId, sessionId) as CommandRow | undefined;
  if (!row) {
    throw new AgentV2Error('Command not found.', 'NOT_FOUND');
  }
  return row;
}

export function getCommandOrThrow(db: BetterSqlite3.Database, commandId: string): AgentCommand {
  const row = db.prepare('SELECT * FROM agent_v2_commands WHERE id = ? LIMIT 1').get(commandId) as
    | CommandRow
    | undefined;
  if (!row) {
    throw new AgentV2Error('Command not found.', 'NOT_FOUND');
  }
  return toAgentCommand(row);
}

export function countQueuedCommandsUnsafe(db: BetterSqlite3.Database, sessionId: string): number {
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS cnt
      FROM agent_v2_commands
      WHERE session_id = ? AND status = 'queued'
    `,
    )
    .get(sessionId) as { cnt: number };
  return Number(row?.cnt || 0);
}

export function buildSessionSnapshot(
  db: BetterSqlite3.Database,
  sessionId: string,
  userId: string,
): AgentSessionSnapshot {
  const row = getSessionRowOrThrow(db, sessionId, userId);
  const queueDepth = countQueuedCommandsUnsafe(db, sessionId);
  const running = db
    .prepare(
      `
      SELECT id
      FROM agent_v2_commands
      WHERE session_id = ? AND status = 'running'
      ORDER BY started_at DESC
      LIMIT 1
    `,
    )
    .get(sessionId) as { id?: string } | undefined;
  return {
    id: row.id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    status: row.status,
    revision: row.revision,
    lastSeq: row.last_seq,
    queueDepth,
    runningCommandId: running?.id || null,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function insertEventsWithIncrementingSeq(
  db: BetterSqlite3.Database,
  session: SessionRow,
  commandId: string | null,
  events: Array<{ type: AgentV2EventType; payload: Record<string, unknown> }>,
  emittedAt: string,
): AgentV2EventEnvelope[] {
  let nextSeq = Number(session.last_seq || 0);
  const envelopes: AgentV2EventEnvelope[] = [];
  const insertStmt = db.prepare(
    `
    INSERT INTO agent_v2_events (
      id, session_id, command_id, seq, type, payload_json, emitted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  );

  for (const item of events) {
    nextSeq += 1;
    const eventId = `agent-event-${crypto.randomUUID()}`;
    insertStmt.run(
      eventId,
      session.id,
      commandId,
      nextSeq,
      item.type,
      JSON.stringify(item.payload || {}),
      emittedAt,
    );
    envelopes.push({
      schemaVersion: AGENT_V2_SCHEMA_VERSION,
      eventId,
      sessionId: session.id,
      commandId,
      seq: nextSeq,
      emittedAt,
      type: item.type,
      payload: item.payload || {},
    });
  }

  db.prepare(
    `
      UPDATE agent_v2_sessions
      SET last_seq = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(nextSeq, emittedAt, session.id);

  return envelopes;
}
