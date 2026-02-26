import type BetterSqlite3 from 'better-sqlite3';
import type { AgentV2EventEnvelope, AgentV2EventType } from '@/server/agent-v2/types';
import { AgentV2Error } from '@/server/agent-v2/errors';
import type { EventRow } from './types';
import {
  getSessionRowOrThrow,
  insertEventsWithIncrementingSeq,
  replayCutoffIso,
  toEventEnvelope,
} from './utils';

export const REPLAY_RETENTION_HOURS = 24;

export interface AppendEventInput {
  sessionId: string;
  userId: string;
  commandId?: string | null;
  type: AgentV2EventType;
  payload: Record<string, unknown>;
}

export function appendEvent(
  db: BetterSqlite3.Database,
  input: AppendEventInput,
): AgentV2EventEnvelope {
  const tx = db.transaction(() => {
    const session = getSessionRowOrThrow(db, input.sessionId, input.userId);
    const now = new Date().toISOString();
    const [event] = insertEventsWithIncrementingSeq(
      db,
      session,
      input.commandId ?? null,
      [{ type: input.type, payload: input.payload }],
      now,
    );
    return event;
  });
  return tx();
}

export interface ReplayEventsInput {
  sessionId: string;
  userId: string;
  fromSeq: number;
  limit?: number;
}

export function replayEvents(
  db: BetterSqlite3.Database,
  input: ReplayEventsInput,
): AgentV2EventEnvelope[] {
  const session = getSessionRowOrThrow(db, input.sessionId, input.userId);
  const fromSeq = Math.max(0, Math.floor(input.fromSeq || 0));
  const limit = Math.max(1, Math.min(Math.floor(input.limit || 500), 5000));
  const cutoffIso = replayCutoffIso();

  const oldestAvailable = db
    .prepare(
      `
      SELECT MIN(seq) AS min_seq
      FROM agent_v2_events
      WHERE session_id = ? AND emitted_at >= ?
    `,
    )
    .get(input.sessionId, cutoffIso) as { min_seq: number | null };

  const minSeq = Number(oldestAvailable?.min_seq ?? 0);
  if (session.last_seq > fromSeq && minSeq > 0 && fromSeq < minSeq - 1) {
    throw new AgentV2Error(
      'Replay window expired; use session.get snapshot and re-subscribe.',
      'REPLAY_WINDOW_EXPIRED',
    );
  }

  if (session.last_seq > fromSeq && minSeq === 0) {
    throw new AgentV2Error(
      'Replay window expired; use session.get snapshot and re-subscribe.',
      'REPLAY_WINDOW_EXPIRED',
    );
  }

  const rows = db
    .prepare(
      `
      SELECT *
      FROM agent_v2_events
      WHERE session_id = ? AND seq > ? AND emitted_at >= ?
      ORDER BY seq ASC
      LIMIT ?
    `,
    )
    .all(input.sessionId, fromSeq, cutoffIso, limit) as EventRow[];
  return rows.map(toEventEnvelope);
}

/**
 * Directly look up the terminal event (completed or error) for a specific command.
 * Bypasses the seq-based replay window, so it works even when lastSeq is stale.
 * Returns null if the command hasn't finished yet.
 */
export function getCommandResult(
  db: BetterSqlite3.Database,
  commandId: string,
  sessionId: string,
): AgentV2EventEnvelope | null {
  const row = db
    .prepare(
      `SELECT * FROM agent_v2_events
       WHERE command_id = ? AND session_id = ?
         AND type IN ('agent.v2.command.completed', 'agent.v2.error')
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(commandId, sessionId) as EventRow | undefined;
  return row ? toEventEnvelope(row) : null;
}

export function pruneExpiredEvents(db: BetterSqlite3.Database, now = new Date()): number {
  const cutoff = new Date(now.getTime() - REPLAY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  const result = db.prepare('DELETE FROM agent_v2_events WHERE emitted_at < ?').run(cutoff);
  return Number(result.changes || 0);
}
