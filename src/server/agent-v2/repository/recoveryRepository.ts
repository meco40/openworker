import type BetterSqlite3 from 'better-sqlite3';
import { getSessionRowOrThrow, insertEventsWithIncrementingSeq } from './utils';

export interface RecoveryResult {
  recoveredCommands: number;
  touchedSessions: number;
}

export function recoverRunningCommandsOnStartup(db: BetterSqlite3.Database): RecoveryResult {
  const tx = db.transaction(() => {
    const running = db
      .prepare(
        `
        SELECT c.id AS command_id, c.session_id, s.user_id
        FROM agent_v2_commands c
        INNER JOIN agent_v2_sessions s ON s.id = c.session_id
        WHERE c.status = 'running'
      `,
      )
      .all() as Array<{ command_id: string; session_id: string; user_id: string }>;

    if (running.length === 0) {
      return { recoveredCommands: 0, touchedSessions: 0 };
    }

    const now = new Date().toISOString();
    const touchedSessions = new Set<string>();
    for (const row of running) {
      touchedSessions.add(row.session_id);
      db.prepare(
        `
          UPDATE agent_v2_commands
          SET status = 'failed_recoverable',
              finished_at = ?,
              error_code = 'RECOVERED_ON_BOOT',
              error_message = 'Command marked recoverable after process restart.'
          WHERE id = ?
        `,
      ).run(now, row.command_id);

      getSessionRowOrThrow(db, row.session_id, row.user_id);
      db.prepare(
        `
          UPDATE agent_v2_sessions
          SET status = 'error_recoverable', revision = revision + 1, last_error = ?, updated_at = ?
          WHERE id = ? AND user_id = ?
        `,
      ).run('Recovered running command on startup.', now, row.session_id, row.user_id);

      const refreshed = getSessionRowOrThrow(db, row.session_id, row.user_id);
      insertEventsWithIncrementingSeq(
        db,
        refreshed,
        row.command_id,
        [
          {
            type: 'agent.v2.error',
            payload: {
              errorCode: 'RECOVERED_ON_BOOT',
              message: 'Running command was marked failed_recoverable during startup recovery.',
            },
          },
          {
            type: 'agent.v2.session.updated',
            payload: {
              reason: 'startup_recovery',
              status: 'error_recoverable',
            },
          },
        ],
        now,
      );
    }

    return { recoveredCommands: running.length, touchedSessions: touchedSessions.size };
  });
  return tx();
}
