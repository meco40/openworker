import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { openSqliteDatabase } from '@/server/db/sqlite';
import type {
  AgentCommand,
  AgentCommandResult,
  AgentSessionSnapshot,
  AgentV2CommandStatus,
  AgentV2CommandType,
  AgentV2EventEnvelope,
  AgentV2EventType,
  AgentV2SessionStatus,
  AgentV2SigningKeyRecord,
  ExtensionManifestV1,
} from '@/server/agent-v2/types';
import { AGENT_V2_SCHEMA_VERSION } from '@/server/agent-v2/types';
import { AgentV2Error } from '@/server/agent-v2/errors';

const REPLAY_RETENTION_HOURS = 24;

interface SessionRow {
  id: string;
  user_id: string;
  conversation_id: string;
  status: AgentV2SessionStatus;
  revision: number;
  last_seq: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface CommandRow {
  id: string;
  session_id: string;
  command_type: AgentV2CommandType;
  priority: number;
  status: AgentV2CommandStatus;
  payload_json: string;
  idempotency_key: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  result_json: string | null;
}

interface EventRow {
  id: string;
  session_id: string;
  command_id: string | null;
  seq: number;
  type: AgentV2EventType;
  payload_json: string;
  emitted_at: string;
}

interface ExtensionRow {
  id: string;
  version: string;
  digest: string;
  manifest_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface EnqueueAgentCommandInput {
  sessionId: string;
  userId: string;
  commandType: AgentV2CommandType;
  priority: number;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface EnqueueAgentCommandResult {
  command: AgentCommand;
  reused: boolean;
  session: AgentSessionSnapshot;
  events: AgentV2EventEnvelope[];
}

export interface StartNextCommandResult {
  command: AgentCommand;
  session: AgentSessionSnapshot;
  events: AgentV2EventEnvelope[];
}

export interface CompleteCommandInput {
  sessionId: string;
  userId: string;
  commandId: string;
  status: AgentV2CommandStatus;
  result?: AgentCommandResult | Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface CompleteCommandResult {
  command: AgentCommand;
  session: AgentSessionSnapshot;
  events: AgentV2EventEnvelope[];
}

export class AgentV2Repository {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath = process.env.MESSAGES_DB_PATH || '.local/messages.db') {
    this.db = openSqliteDatabase({ dbPath });
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_v2_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        last_seq INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_v2_sessions_user_updated
      ON agent_v2_sessions (user_id, updated_at DESC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_v2_commands (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_v2_sessions(id) ON DELETE CASCADE,
        command_type TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT,
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT,
        result_json TEXT
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_v2_commands_session_status_priority
      ON agent_v2_commands (session_id, status, priority DESC, enqueued_at ASC);
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_v2_commands_idempotency
      ON agent_v2_commands (session_id, command_type, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_v2_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_v2_sessions(id) ON DELETE CASCADE,
        command_id TEXT,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        emitted_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_v2_events_session_seq
      ON agent_v2_events (session_id, seq);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_v2_events_session_emitted
      ON agent_v2_events (session_id, emitted_at ASC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_v2_extensions (
        id TEXT NOT NULL,
        version TEXT NOT NULL,
        digest TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id, version, digest)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_v2_signing_keys (
        key_id TEXT PRIMARY KEY,
        algorithm TEXT NOT NULL,
        public_key_pem TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        rotated_at TEXT,
        revoked_at TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_v2_revoked_signatures (
        signature_digest TEXT PRIMARY KEY,
        reason TEXT,
        revoked_at TEXT NOT NULL
      );
    `);
  }

  createSession(input: {
    userId: string;
    conversationId: string;
    status?: AgentV2SessionStatus;
  }): { session: AgentSessionSnapshot; events: AgentV2EventEnvelope[] } {
    const id = `agent-session-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const sessionStatus: AgentV2SessionStatus = input.status ?? 'idle';

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO agent_v2_sessions (
            id, user_id, conversation_id, status, revision, last_seq, last_error, created_at, updated_at, completed_at
          )
          VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?, NULL)
        `,
        )
        .run(id, input.userId, input.conversationId, sessionStatus, now, now);

      const row = this.getSessionRowOrThrow(id, input.userId);
      const events = this.insertEventsWithIncrementingSeq(
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

      const session = this.buildSessionSnapshot(row.id, row.user_id);
      return { session, events };
    });

    return tx();
  }

  getSession(sessionId: string, userId: string): AgentSessionSnapshot | null {
    const row = this.getSessionRow(sessionId, userId);
    if (!row) return null;
    return this.buildSessionSnapshot(row.id, row.user_id);
  }

  listSessions(userId: string, limit = 50): AgentSessionSnapshot[] {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit || 50), 200));
    const rows = this.db
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
    return rows.map((row) => this.buildSessionSnapshot(row.id, row.user_id));
  }

  countQueuedCommands(sessionId: string, userId: string): number {
    this.getSessionRowOrThrow(sessionId, userId);
    const row = this.db
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

  hasQueuedAbort(sessionId: string): boolean {
    const row = this.db
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

  enqueueCommand(input: EnqueueAgentCommandInput): EnqueueAgentCommandResult {
    const tx = this.db.transaction(() => {
      const session = this.getSessionRowOrThrow(input.sessionId, input.userId);
      const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

      if (idempotencyKey) {
        const existing = this.db
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
            session: this.buildSessionSnapshot(session.id, session.user_id),
            events: [],
          };
        }
      }

      const commandId = `agent-command-${crypto.randomUUID()}`;
      const now = new Date().toISOString();

      this.db
        .prepare(
          `
          UPDATE agent_v2_sessions
          SET revision = revision + 1, updated_at = ?
          WHERE id = ? AND user_id = ?
        `,
        )
        .run(now, input.sessionId, input.userId);

      this.db
        .prepare(
          `
          INSERT INTO agent_v2_commands (
            id, session_id, command_type, priority, status, payload_json,
            idempotency_key, enqueued_at, started_at, finished_at, error_code, error_message, result_json
          )
          VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
        `,
        )
        .run(
          commandId,
          input.sessionId,
          input.commandType,
          input.priority,
          JSON.stringify(input.payload || {}),
          idempotencyKey,
          now,
        );

      const refreshed = this.getSessionRowOrThrow(input.sessionId, input.userId);
      const events = this.insertEventsWithIncrementingSeq(
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

      const command = this.getCommandOrThrow(commandId);
      const snapshot = this.buildSessionSnapshot(input.sessionId, input.userId);
      return { command, reused: false, session: snapshot, events };
    });

    return tx();
  }

  startNextQueuedCommand(sessionId: string, userId: string): StartNextCommandResult | null {
    const tx = this.db.transaction(() => {
      this.getSessionRowOrThrow(sessionId, userId);
      const next = this.db
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
      this.db
        .prepare(
          `
          UPDATE agent_v2_commands
          SET status = 'running', started_at = ?
          WHERE id = ? AND session_id = ?
        `,
        )
        .run(now, next.id, sessionId);

      this.db
        .prepare(
          `
          UPDATE agent_v2_sessions
          SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND user_id = ?
        `,
        )
        .run(now, sessionId, userId);

      const refreshed = this.getSessionRowOrThrow(sessionId, userId);
      const events = this.insertEventsWithIncrementingSeq(
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

      const command = this.getCommandOrThrow(next.id);
      const snapshot = this.buildSessionSnapshot(sessionId, userId);
      return { command, session: snapshot, events };
    });

    return tx();
  }

  completeCommand(input: CompleteCommandInput): CompleteCommandResult {
    const tx = this.db.transaction(() => {
      this.getSessionRowOrThrow(input.sessionId, input.userId);
      const command = this.getCommandRowOrThrow(input.commandId, input.sessionId);
      const now = new Date().toISOString();
      const resolvedStatus = input.status;

      const serializedResult =
        input.result === undefined ? null : JSON.stringify(input.result as Record<string, unknown>);
      this.db
        .prepare(
          `
          UPDATE agent_v2_commands
          SET status = ?, finished_at = ?, error_code = ?, error_message = ?, result_json = ?
          WHERE id = ? AND session_id = ?
        `,
        )
        .run(
          resolvedStatus,
          now,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          serializedResult,
          input.commandId,
          input.sessionId,
        );

      const hasQueued = this.countQueuedCommandsUnsafe(input.sessionId) > 0;
      const nextStatus = resolveSessionStatusAfterCommand(resolvedStatus, hasQueued);

      this.db
        .prepare(
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
        )
        .run(
          nextStatus,
          input.errorMessage ?? null,
          now,
          nextStatus === 'completed' || nextStatus === 'aborted' ? now : null,
          input.sessionId,
          input.userId,
        );

      const refreshed = this.getSessionRowOrThrow(input.sessionId, input.userId);

      const eventItems: Array<{ type: AgentV2EventType; payload: Record<string, unknown> }> = [];
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

      const events = this.insertEventsWithIncrementingSeq(
        refreshed,
        input.commandId,
        eventItems,
        now,
      );
      return {
        command: this.getCommandOrThrow(input.commandId),
        session: this.buildSessionSnapshot(input.sessionId, input.userId),
        events,
      };
    });

    return tx();
  }

  appendEvent(input: {
    sessionId: string;
    userId: string;
    commandId?: string | null;
    type: AgentV2EventType;
    payload: Record<string, unknown>;
  }): AgentV2EventEnvelope {
    const tx = this.db.transaction(() => {
      const session = this.getSessionRowOrThrow(input.sessionId, input.userId);
      const now = new Date().toISOString();
      const [event] = this.insertEventsWithIncrementingSeq(
        session,
        input.commandId ?? null,
        [{ type: input.type, payload: input.payload }],
        now,
      );
      return event;
    });
    return tx();
  }

  replayEvents(input: {
    sessionId: string;
    userId: string;
    fromSeq: number;
    limit?: number;
  }): AgentV2EventEnvelope[] {
    const session = this.getSessionRowOrThrow(input.sessionId, input.userId);
    const fromSeq = Math.max(0, Math.floor(input.fromSeq || 0));
    const limit = Math.max(1, Math.min(Math.floor(input.limit || 500), 5000));
    const cutoffIso = replayCutoffIso();

    const oldestAvailable = this.db
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
      throw new AgentV2Error('Replay window expired; use session.get snapshot and re-subscribe.', 'REPLAY_WINDOW_EXPIRED');
    }

    if (session.last_seq > fromSeq && minSeq === 0) {
      throw new AgentV2Error('Replay window expired; use session.get snapshot and re-subscribe.', 'REPLAY_WINDOW_EXPIRED');
    }

    const rows = this.db
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

  pruneExpiredEvents(now = new Date()): number {
    const cutoff = new Date(now.getTime() - REPLAY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
    const result = this.db
      .prepare('DELETE FROM agent_v2_events WHERE emitted_at < ?')
      .run(cutoff);
    return Number(result.changes || 0);
  }

  recoverRunningCommandsOnStartup(): { recoveredCommands: number; touchedSessions: number } {
    const tx = this.db.transaction(() => {
      const running = this.db
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
        this.db
          .prepare(
            `
            UPDATE agent_v2_commands
            SET status = 'failed_recoverable',
                finished_at = ?,
                error_code = 'RECOVERED_ON_BOOT',
                error_message = 'Command marked recoverable after process restart.'
            WHERE id = ?
          `,
          )
          .run(now, row.command_id);

        this.getSessionRowOrThrow(row.session_id, row.user_id);
        this.db
          .prepare(
            `
            UPDATE agent_v2_sessions
            SET status = 'error_recoverable', revision = revision + 1, last_error = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
          `,
          )
          .run('Recovered running command on startup.', now, row.session_id, row.user_id);

        const refreshed = this.getSessionRowOrThrow(row.session_id, row.user_id);
        this.insertEventsWithIncrementingSeq(
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

  upsertExtensionManifest(manifest: ExtensionManifestV1, enabled = true): void {
    const now = new Date().toISOString();
    const serialized = JSON.stringify(manifest);
    this.db
      .prepare(
        `
        INSERT INTO agent_v2_extensions (
          id, version, digest, manifest_json, enabled, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id, version, digest)
        DO UPDATE SET
          manifest_json = excluded.manifest_json,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        manifest.id,
        manifest.version,
        manifest.digest,
        serialized,
        enabled ? 1 : 0,
        now,
        now,
      );
  }

  listEnabledExtensionManifests(): ExtensionManifestV1[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM agent_v2_extensions
        WHERE enabled = 1
        ORDER BY id ASC, version ASC
      `,
      )
      .all() as ExtensionRow[];
    return rows
      .map((row) => safeJsonParse<ExtensionManifestV1>(row.manifest_json))
      .filter((row): row is ExtensionManifestV1 => Boolean(row));
  }

  upsertSigningKey(input: {
    keyId: string;
    algorithm: string;
    publicKeyPem: string;
    status?: 'active' | 'rotated' | 'revoked';
    rotatedAt?: string | null;
    revokedAt?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO agent_v2_signing_keys (
          key_id, algorithm, public_key_pem, status, created_at, rotated_at, revoked_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_id)
        DO UPDATE SET
          algorithm = excluded.algorithm,
          public_key_pem = excluded.public_key_pem,
          status = excluded.status,
          rotated_at = excluded.rotated_at,
          revoked_at = excluded.revoked_at
      `,
      )
      .run(
        input.keyId,
        input.algorithm,
        input.publicKeyPem,
        input.status ?? 'active',
        now,
        input.rotatedAt ?? null,
        input.revokedAt ?? null,
      );
  }

  listSigningKeys(): AgentV2SigningKeyRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM agent_v2_signing_keys
      `,
      )
      .all() as Array<{
      key_id: string;
      algorithm: string;
      public_key_pem: string;
      status: 'active' | 'rotated' | 'revoked';
      created_at: string;
      rotated_at: string | null;
      revoked_at: string | null;
    }>;
    return rows.map((row) => ({
      keyId: row.key_id,
      algorithm: row.algorithm,
      publicKeyPem: row.public_key_pem,
      status: row.status,
      createdAt: row.created_at,
      rotatedAt: row.rotated_at,
      revokedAt: row.revoked_at,
    }));
  }

  revokeSignature(signatureDigest: string, reason?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO agent_v2_revoked_signatures (signature_digest, reason, revoked_at)
        VALUES (?, ?, ?)
        ON CONFLICT(signature_digest)
        DO UPDATE SET reason = excluded.reason, revoked_at = excluded.revoked_at
      `,
      )
      .run(signatureDigest, reason ?? null, now);
  }

  listRevokedSignatureDigests(): Set<string> {
    const rows = this.db
      .prepare('SELECT signature_digest FROM agent_v2_revoked_signatures')
      .all() as Array<{ signature_digest: string }>;
    return new Set(rows.map((row) => row.signature_digest));
  }

  close(): void {
    this.db.close();
  }

  private getSessionRow(sessionId: string, userId: string): SessionRow | null {
    const row = this.db
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

  private getSessionRowOrThrow(sessionId: string, userId: string): SessionRow {
    const row = this.getSessionRow(sessionId, userId);
    if (!row) {
      throw new AgentV2Error('Session not found.', 'NOT_FOUND');
    }
    return row;
  }

  private getCommandRowOrThrow(commandId: string, sessionId: string): CommandRow {
    const row = this.db
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

  private getCommandOrThrow(commandId: string): AgentCommand {
    const row = this.db
      .prepare('SELECT * FROM agent_v2_commands WHERE id = ? LIMIT 1')
      .get(commandId) as CommandRow | undefined;
    if (!row) {
      throw new AgentV2Error('Command not found.', 'NOT_FOUND');
    }
    return toAgentCommand(row);
  }

  private countQueuedCommandsUnsafe(sessionId: string): number {
    const row = this.db
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

  private buildSessionSnapshot(sessionId: string, userId: string): AgentSessionSnapshot {
    const row = this.getSessionRowOrThrow(sessionId, userId);
    const queueDepth = this.countQueuedCommandsUnsafe(sessionId);
    const running = this.db
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

  private insertEventsWithIncrementingSeq(
    session: SessionRow,
    commandId: string | null,
    events: Array<{ type: AgentV2EventType; payload: Record<string, unknown> }>,
    emittedAt: string,
  ): AgentV2EventEnvelope[] {
    let nextSeq = Number(session.last_seq || 0);
    const envelopes: AgentV2EventEnvelope[] = [];
    const insertStmt = this.db.prepare(
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

    this.db
      .prepare(
        `
        UPDATE agent_v2_sessions
        SET last_seq = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(nextSeq, emittedAt, session.id);

    return envelopes;
  }
}

function normalizeIdempotencyKey(value?: string): string | null {
  const normalized = String(value || '').trim();
  return normalized ? normalized : null;
}

function toAgentCommand(row: CommandRow): AgentCommand {
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

function toEventEnvelope(row: EventRow): AgentV2EventEnvelope {
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

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function replayCutoffIso(now = new Date()): string {
  return new Date(now.getTime() - REPLAY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
}

function resolveSessionStatusAfterCommand(
  commandStatus: AgentV2CommandStatus,
  hasQueuedCommands: boolean,
): AgentV2SessionStatus {
  if (commandStatus === 'aborted') return 'aborted';
  if (commandStatus === 'failed_recoverable') return 'error_recoverable';
  if (commandStatus === 'failed') return 'error';
  if (hasQueuedCommands) return 'idle';
  return 'idle';
}
