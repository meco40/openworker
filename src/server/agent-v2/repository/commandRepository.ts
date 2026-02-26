import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  CommandRow,
  CompleteCommandInput,
  CompleteCommandResult,
  EnqueueAgentCommandInput,
  EnqueueAgentCommandResult,
  StartNextCommandResult,
} from './types';
import {
  buildSessionSnapshot,
  countQueuedCommandsUnsafe,
  getCommandOrThrow,
  getCommandRowOrThrow,
  getSessionRowOrThrow,
  insertEventsWithIncrementingSeq,
  normalizeIdempotencyKey,
  resolveSessionStatusAfterCommand,
  toAgentCommand,
} from './utils';

export function enqueueCommand(
  db: BetterSqlite3.Database,
  input: EnqueueAgentCommandInput,
): EnqueueAgentCommandResult {
  const tx = db.transaction(() => {
    const session = getSessionRowOrThrow(db, input.sessionId, input.userId);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

    if (idempotencyKey) {
      const existing = db
        .prepare(
          `
          SELECT *
          FROM agent_v2_commands
          WHERE session_id = ? AND command_type = ? AND idempotency_key = ?
          LIMIT 1
        `,
        )
        .get(input.sessionId, input.commandType, idempotencyKey) as CommandRow | undefined;
      if (existing) {
        return {
          command: toAgentCommand(existing),
          reused: true,
          session: buildSessionSnapshot(db, session.id, session.user_id),
          events: [],
        };
      }
    }

    const commandId = input.commandId || `agent-command-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    db.prepare(
      `
        UPDATE agent_v2_sessions
        SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND user_id = ?
      `,
    ).run(now, input.sessionId, input.userId);

    db.prepare(
      `
        INSERT INTO agent_v2_commands (
          id, session_id, command_type, priority, status, payload_json,
          idempotency_key, enqueued_at, started_at, finished_at, error_code, error_message, result_json
        )
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
      `,
    ).run(
      commandId,
      input.sessionId,
      input.commandType,
      input.priority,
      JSON.stringify(input.payload || {}),
      idempotencyKey,
      now,
    );

    const refreshed = getSessionRowOrThrow(db, input.sessionId, input.userId);
    const events = insertEventsWithIncrementingSeq(
      db,
      refreshed,
      commandId,
      [
        {
          type: 'agent.v2.command.queued',
          payload: {
            commandType: input.commandType,
            priority: input.priority,
            idempotencyKey,
          },
        },
        {
          type: 'agent.v2.session.updated',
          payload: {
            reason: 'command_queued',
            status: refreshed.status,
          },
        },
      ],
      now,
    );

    const command = getCommandOrThrow(db, commandId);
    const snapshot = buildSessionSnapshot(db, input.sessionId, input.userId);
    return { command, reused: false, session: snapshot, events };
  });

  return tx();
}

export function countQueuedCommands(
  db: BetterSqlite3.Database,
  sessionId: string,
  userId: string,
): number {
  getSessionRowOrThrow(db, sessionId, userId);
  return countQueuedCommandsUnsafe(db, sessionId);
}

export function hasQueuedAbort(db: BetterSqlite3.Database, sessionId: string): boolean {
  const row = db
    .prepare(
      `
      SELECT id
      FROM agent_v2_commands
      WHERE session_id = ? AND status = 'queued' AND command_type = 'abort'
      LIMIT 1
    `,
    )
    .get(sessionId) as { id?: string } | undefined;
  return Boolean(row?.id);
}

export function startNextQueuedCommand(
  db: BetterSqlite3.Database,
  sessionId: string,
  userId: string,
): StartNextCommandResult | null {
  const tx = db.transaction(() => {
    getSessionRowOrThrow(db, sessionId, userId);
    const next = db
      .prepare(
        `
        SELECT *
        FROM agent_v2_commands
        WHERE session_id = ? AND status = 'queued'
        ORDER BY priority DESC, enqueued_at ASC
        LIMIT 1
      `,
      )
      .get(sessionId) as CommandRow | undefined;
    if (!next) return null;

    const now = new Date().toISOString();
    db.prepare(
      `
        UPDATE agent_v2_commands
        SET status = 'running', started_at = ?
        WHERE id = ? AND session_id = ?
      `,
    ).run(now, next.id, sessionId);

    db.prepare(
      `
        UPDATE agent_v2_sessions
        SET status = 'running', revision = revision + 1, updated_at = ?
        WHERE id = ? AND user_id = ?
      `,
    ).run(now, sessionId, userId);

    const refreshed = getSessionRowOrThrow(db, sessionId, userId);
    const events = insertEventsWithIncrementingSeq(
      db,
      refreshed,
      next.id,
      [
        {
          type: 'agent.v2.command.started',
          payload: {
            commandType: next.command_type,
            startedAt: now,
          },
        },
        {
          type: 'agent.v2.session.updated',
          payload: {
            reason: 'command_started',
            status: 'running',
          },
        },
      ],
      now,
    );

    const command = getCommandOrThrow(db, next.id);
    const snapshot = buildSessionSnapshot(db, sessionId, userId);
    return { command, session: snapshot, events };
  });

  return tx();
}

export function completeCommand(
  db: BetterSqlite3.Database,
  input: CompleteCommandInput,
): CompleteCommandResult {
  const tx = db.transaction(() => {
    getSessionRowOrThrow(db, input.sessionId, input.userId);
    const command = getCommandRowOrThrow(db, input.commandId, input.sessionId);
    const now = new Date().toISOString();
    const resolvedStatus = input.status;

    const serializedResult =
      input.result === undefined ? null : JSON.stringify(input.result as Record<string, unknown>);
    db.prepare(
      `
        UPDATE agent_v2_commands
        SET status = ?, finished_at = ?, error_code = ?, error_message = ?, result_json = ?
        WHERE id = ? AND session_id = ?
      `,
    ).run(
      resolvedStatus,
      now,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      serializedResult,
      input.commandId,
      input.sessionId,
    );

    const hasQueued = countQueuedCommandsUnsafe(db, input.sessionId) > 0;
    const nextStatus = resolveSessionStatusAfterCommand(resolvedStatus, hasQueued);

    db.prepare(
      `
        UPDATE agent_v2_sessions
        SET
          status = ?,
          revision = revision + 1,
          last_error = ?,
          updated_at = ?,
          completed_at = ?
        WHERE id = ? AND user_id = ?
      `,
    ).run(
      nextStatus,
      input.errorMessage ?? null,
      now,
      nextStatus === 'completed' || nextStatus === 'aborted' ? now : null,
      input.sessionId,
      input.userId,
    );

    const refreshed = getSessionRowOrThrow(db, input.sessionId, input.userId);

    const eventItems: Array<{
      type: import('@/server/agent-v2/types').AgentV2EventType;
      payload: Record<string, unknown>;
    }> = [];
    if (resolvedStatus === 'failed' || resolvedStatus === 'failed_recoverable') {
      eventItems.push({
        type: 'agent.v2.error',
        payload: {
          commandType: command.command_type,
          errorCode: input.errorCode ?? 'COMMAND_FAILED',
          message: input.errorMessage ?? 'Command failed.',
        },
      });
    } else {
      eventItems.push({
        type: 'agent.v2.command.completed',
        payload: {
          commandType: command.command_type,
          status: resolvedStatus,
          result: input.result ?? null,
        },
      });
    }

    eventItems.push({
      type: 'agent.v2.session.updated',
      payload: {
        reason: 'command_completed',
        status: nextStatus,
      },
    });

    if (nextStatus === 'completed' || nextStatus === 'aborted') {
      eventItems.push({
        type: 'agent.v2.session.completed',
        payload: {
          status: nextStatus,
        },
      });
    }

    const events = insertEventsWithIncrementingSeq(db, refreshed, input.commandId, eventItems, now);
    return {
      command: getCommandOrThrow(db, input.commandId),
      session: buildSessionSnapshot(db, input.sessionId, input.userId),
      events,
    };
  });

  return tx();
}

// Re-export utility for other modules
export { countQueuedCommandsUnsafe } from './utils';
