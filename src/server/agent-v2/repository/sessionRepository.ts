import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { AgentSessionSnapshot, AgentV2SessionStatus } from '@/server/agent-v2/types';
import type { SessionRow } from './types';
import {
  buildSessionSnapshot,
  getSessionRow,
  getSessionRowOrThrow,
  insertEventsWithIncrementingSeq,
} from './utils';

export interface CreateSessionInput {
  userId: string;
  conversationId: string;
  status?: AgentV2SessionStatus;
}

export interface CreateSessionResult {
  session: AgentSessionSnapshot;
  events: import('@/server/agent-v2/types').AgentV2EventEnvelope[];
}

export function createSession(
  db: BetterSqlite3.Database,
  input: CreateSessionInput,
): CreateSessionResult {
  const id = `agent-session-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const sessionStatus: AgentV2SessionStatus = input.status ?? 'idle';

  const tx = db.transaction(() => {
    db.prepare(
      `
        INSERT INTO agent_v2_sessions (
          id, user_id, conversation_id, status, revision, last_seq, last_error, created_at, updated_at, completed_at
        )
        VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?, NULL)
      `,
    ).run(id, input.userId, input.conversationId, sessionStatus, now, now);

    const row = getSessionRowOrThrow(db, id, input.userId);
    const events = insertEventsWithIncrementingSeq(
      db,
      row,
      null,
      [
        {
          type: 'agent.v2.session.updated',
          payload: {
            reason: 'session_started',
            status: sessionStatus,
          },
        },
      ],
      now,
    );

    const session = buildSessionSnapshot(db, row.id, row.user_id);
    return { session, events };
  });

  return tx();
}

export function getSession(
  db: BetterSqlite3.Database,
  sessionId: string,
  userId: string,
): AgentSessionSnapshot | null {
  const row = getSessionRow(db, sessionId, userId);
  if (!row) return null;
  return buildSessionSnapshot(db, row.id, row.user_id);
}

export function listSessions(
  db: BetterSqlite3.Database,
  userId: string,
  limit = 50,
): AgentSessionSnapshot[] {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit || 50), 200));
  const rows = db
    .prepare(
      `
      SELECT *
      FROM agent_v2_sessions
      WHERE user_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `,
    )
    .all(userId, safeLimit) as SessionRow[];
  return rows.map((row) => buildSessionSnapshot(db, row.id, row.user_id));
}

// Re-export helper functions for other modules
export { getSessionRow, getSessionRowOrThrow, buildSessionSnapshot } from './utils';
