import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RoomRepository } from './repository';
import type {
  AppendRoomMessageInput,
  CreateRoomInput,
  PersonaPermissions,
  Room,
  RoomMemberRuntime,
  RoomPersonaContext,
  RoomPersonaSession,
  RoomIntervention,
  RoomRun,
  RoomMember,
  RoomMessage,
  RoomRunState,
  UpsertMemberRuntimeInput,
} from './types';
import {
  toIntervention,
  toMember,
  toMemberRuntime,
  toPersonaContext,
  toPersonaSession,
  toRoom,
  toRoomMessage as toMessage,
  toRun,
} from './roomRowMappers';

export class SqliteRoomRepository implements RoomRepository {
  private readonly db: ReturnType<typeof Database>;

  constructor(dbPath = process.env.ROOMS_DB_PATH || process.env.MESSAGES_DB_PATH || '.local/messages.db') {
    if (dbPath === ':memory:') {
      this.db = new Database(':memory:');
    } else {
      const fullPath = path.resolve(dbPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      this.db = new Database(fullPath);
    }

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /**
   * Migrate CHECK constraints on existing tables that were created with older schemas.
   * SQLite does not support ALTER TABLE to change CHECK constraints, so we rebuild
   * affected tables using: create new → copy data → drop old → rename new.
   *
   * Uses a migrations tracking table to ensure each migration runs exactly once.
   */
  private migrateCheckConstraints(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _room_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const applied = new Set(
      (this.db.prepare('SELECT id FROM _room_migrations').all() as { id: string }[]).map((r) => r.id),
    );

    // ── Fix broken FK references from previous migration attempt ──
    if (!applied.has('fix_broken_fk_refs')) {
      this.fixBrokenForeignKeys();
      this.db.prepare('INSERT OR IGNORE INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
        'fix_broken_fk_refs', new Date().toISOString(),
      );
    }

    if (!applied.has('rooms_add_free_goal_mode')) {
      const roomsInfo = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='rooms'"
      ).get() as { sql: string } | undefined;

      if (roomsInfo && !roomsInfo.sql.includes("'free'")) {
        this.db.exec('PRAGMA foreign_keys = OFF');
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE _rooms_new (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              name TEXT NOT NULL,
              goal_mode TEXT NOT NULL CHECK (goal_mode IN ('planning', 'simulation', 'free')),
              routing_profile_id TEXT NOT NULL DEFAULT 'p1',
              run_state TEXT NOT NULL DEFAULT 'stopped' CHECK (run_state IN ('stopped', 'running', 'degraded')),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
          `);
          this.db.exec('INSERT INTO _rooms_new SELECT * FROM rooms');
          this.db.exec('DROP TABLE rooms');
          this.db.exec('ALTER TABLE _rooms_new RENAME TO rooms');
          this.db.prepare('INSERT INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
            'rooms_add_free_goal_mode', new Date().toISOString(),
          );
        })();
        this.db.exec('PRAGMA foreign_keys = ON');
      } else {
        this.db.prepare('INSERT OR IGNORE INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
          'rooms_add_free_goal_mode', new Date().toISOString(),
        );
      }
    }

    if (!applied.has('runtime_add_extended_statuses')) {
      const runtimeInfo = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='room_member_runtime'"
      ).get() as { sql: string } | undefined;

      if (runtimeInfo && !runtimeInfo.sql.includes("'interrupting'")) {
        this.db.exec('PRAGMA foreign_keys = OFF');
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE _room_member_runtime_new (
              room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
              persona_id TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('idle', 'busy', 'interrupting', 'interrupted', 'error', 'paused')),
              busy_reason TEXT,
              busy_until TEXT,
              current_task TEXT,
              last_model TEXT,
              last_profile_id TEXT,
              last_tool TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (room_id, persona_id)
            )
          `);
          this.db.exec('INSERT INTO _room_member_runtime_new SELECT * FROM room_member_runtime');
          this.db.exec('DROP TABLE room_member_runtime');
          this.db.exec('ALTER TABLE _room_member_runtime_new RENAME TO room_member_runtime');
          this.db.prepare('INSERT INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
            'runtime_add_extended_statuses', new Date().toISOString(),
          );
        })();
        this.db.exec('PRAGMA foreign_keys = ON');
      } else {
        this.db.prepare('INSERT OR IGNORE INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
          'runtime_add_extended_statuses', new Date().toISOString(),
        );
      }
    }

    if (!applied.has('runtime_add_paused_status')) {
      const runtimeInfo = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='room_member_runtime'"
      ).get() as { sql: string } | undefined;

      if (runtimeInfo && !runtimeInfo.sql.includes("'paused'")) {
        this.db.exec('PRAGMA foreign_keys = OFF');
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE _room_member_runtime_paused_new (
              room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
              persona_id TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('idle', 'busy', 'interrupting', 'interrupted', 'error', 'paused')),
              busy_reason TEXT,
              busy_until TEXT,
              current_task TEXT,
              last_model TEXT,
              last_profile_id TEXT,
              last_tool TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (room_id, persona_id)
            )
          `);
          this.db.exec('INSERT INTO _room_member_runtime_paused_new SELECT * FROM room_member_runtime');
          this.db.exec('DROP TABLE room_member_runtime');
          this.db.exec('ALTER TABLE _room_member_runtime_paused_new RENAME TO room_member_runtime');
          this.db.prepare('INSERT INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
            'runtime_add_paused_status', new Date().toISOString(),
          );
        })();
        this.db.exec('PRAGMA foreign_keys = ON');
      } else {
        this.db.prepare('INSERT OR IGNORE INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
          'runtime_add_paused_status', new Date().toISOString(),
        );
      }
    }

    // ── Add description column to rooms ────────────────────────
    if (!applied.has('rooms_add_description')) {
      const roomsInfo = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='rooms'"
      ).get() as { sql: string } | undefined;

      if (roomsInfo && !roomsInfo.sql.includes('description')) {
        this.db.exec('ALTER TABLE rooms ADD COLUMN description TEXT');
      }
      this.db.prepare('INSERT OR IGNORE INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
        'rooms_add_description', new Date().toISOString(),
      );
    }
  }

  /**
   * Repairs tables whose REFERENCES were broken by a previous migration
   * that used ALTER TABLE … RENAME TO (which SQLite rewrites FK refs to).
   * Rebuilds any table referencing "_rooms_old" to point back to "rooms".
   */
  private fixBrokenForeignKeys(): void {
    const brokenTables = (
      this.db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%_rooms_old%'"
      ).all() as { name: string; sql: string }[]
    );

    if (brokenTables.length === 0) return;

    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.transaction(() => {
      for (const table of brokenTables) {
        const fixedSql = table.sql.replace(/"_rooms_old"/g, 'rooms');
        const columns = this.db.prepare(`PRAGMA table_info("${table.name}")`).all() as { name: string }[];
        const colList = columns.map((c) => `"${c.name}"`).join(', ');

        // Create temp table with fixed schema, copy data, drop old, rename
        const tempName = `_${table.name}_fkfix`;
        const createSql = fixedSql.replace(
          `CREATE TABLE ${table.name}`,
          `CREATE TABLE "${tempName}"`,
        ).replace(
          `CREATE TABLE "${table.name}"`,
          `CREATE TABLE "${tempName}"`,
        );
        this.db.exec(createSql);
        this.db.exec(`INSERT INTO "${tempName}" (${colList}) SELECT ${colList} FROM "${table.name}"`);
        this.db.exec(`DROP TABLE "${table.name}"`);
        this.db.exec(`ALTER TABLE "${tempName}" RENAME TO "${table.name}"`);
      }
    })();
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  private migrate(): void {
    // ── Schema migrations for existing DBs ─────────────────────
    this.migrateCheckConstraints();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        goal_mode TEXT NOT NULL CHECK (goal_mode IN ('planning', 'simulation', 'free')),
        routing_profile_id TEXT NOT NULL DEFAULT 'p1',
        run_state TEXT NOT NULL DEFAULT 'stopped' CHECK (run_state IN ('stopped', 'running', 'degraded')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rooms_user_updated
        ON rooms (user_id, updated_at DESC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_members (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        persona_id TEXT NOT NULL,
        role_label TEXT NOT NULL,
        turn_priority INTEGER NOT NULL DEFAULT 1,
        model_override TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, persona_id)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_room_members_room
        ON room_members (room_id, turn_priority ASC, created_at ASC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        speaker_type TEXT NOT NULL CHECK (speaker_type IN ('persona', 'system', 'user')),
        speaker_persona_id TEXT,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (room_id, seq)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_room_messages_room_seq
        ON room_messages (room_id, seq DESC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_message_sequences (
        room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
        last_seq INTEGER NOT NULL DEFAULT 0
      );
    `);

    this.db.exec(`
      INSERT INTO room_message_sequences (room_id, last_seq)
      SELECT room_id, COALESCE(MAX(seq), 0) AS last_seq
      FROM room_messages
      GROUP BY room_id
      ON CONFLICT(room_id) DO UPDATE SET
        last_seq = CASE
          WHEN excluded.last_seq > room_message_sequences.last_seq THEN excluded.last_seq
          ELSE room_message_sequences.last_seq
        END;
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_runs (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        run_state TEXT NOT NULL CHECK (run_state IN ('running', 'degraded', 'stopped')),
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        failure_reason TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_room_runs_room_active
        ON room_runs (room_id)
        WHERE ended_at IS NULL;
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_member_runtime (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        persona_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'busy', 'interrupting', 'interrupted', 'error', 'paused')),
        busy_reason TEXT,
        busy_until TEXT,
        current_task TEXT,
        last_model TEXT,
        last_profile_id TEXT,
        last_tool TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, persona_id)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_persona_sessions (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        persona_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, persona_id)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_persona_context (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        persona_id TEXT NOT NULL,
        summary_text TEXT NOT NULL DEFAULT '',
        last_message_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, persona_id)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persona_permissions (
        persona_id TEXT PRIMARY KEY,
        tools_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_interventions (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_room_interventions_room_created
        ON room_interventions (room_id, created_at DESC);
    `);
  }

  createRoom(input: CreateRoomInput): Room {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO rooms (id, user_id, name, description, goal_mode, routing_profile_id, run_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?, ?)
      `,
      )
      .run(id, input.userId, input.name, input.description ?? null, input.goalMode, input.routingProfileId, now, now);
    return this.getRoom(id)!;
  }

  getRoom(id: string): Room | null {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toRoom(row) : null;
  }

  listRooms(userId: string): Room[] {
    const rows = this.db
      .prepare('SELECT * FROM rooms WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(toRoom);
  }

  deleteRoom(roomId: string): boolean {
    const result = this.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    return result.changes > 0;
  }

  listRunningRooms(): Room[] {
    const rows = this.db
      .prepare("SELECT * FROM rooms WHERE run_state = 'running' ORDER BY updated_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(toRoom);
  }

  updateRunState(roomId: string, runState: RoomRunState): Room {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE rooms SET run_state = ?, updated_at = ? WHERE id = ?')
      .run(runState, now, roomId);

    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error(`Room not found: ${roomId}`);
    }
    return room;
  }

  addMember(
    roomId: string,
    personaId: string,
    roleLabel: string,
    turnPriority = 1,
    modelOverride: string | null = null,
  ): RoomMember {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `
          INSERT INTO room_members (
            room_id, persona_id, role_label, turn_priority, model_override, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(roomId, personaId, roleLabel, turnPriority, modelOverride, now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        throw new Error(`Persona ${personaId} is already a room member`);
      }
      throw error;
    }

    return this.listMembers(roomId).find((m) => m.personaId === personaId)!;
  }

  removeMember(roomId: string, personaId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM room_members WHERE room_id = ? AND persona_id = ?')
      .run(roomId, personaId);
    return result.changes > 0;
  }

  listMembers(roomId: string): RoomMember[] {
    const rows = this.db
      .prepare('SELECT * FROM room_members WHERE room_id = ? ORDER BY turn_priority ASC, created_at ASC')
      .all(roomId) as Array<Record<string, unknown>>;
    return rows.map(toMember);
  }

  appendMessage(input: AppendRoomMessageInput): RoomMessage {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const tx = this.db.transaction((payload: AppendRoomMessageInput) => {
      this.db
        .prepare(
          `
          INSERT INTO room_message_sequences (room_id, last_seq)
          VALUES (?, 0)
          ON CONFLICT(room_id) DO NOTHING
        `,
        )
        .run(payload.roomId);

      this.db
        .prepare('UPDATE room_message_sequences SET last_seq = last_seq + 1 WHERE room_id = ?')
        .run(payload.roomId);

      const row = this.db
        .prepare('SELECT last_seq FROM room_message_sequences WHERE room_id = ?')
        .get(payload.roomId) as { last_seq: number } | undefined;
      const seq = Number(row?.last_seq || 0);
      if (!seq) {
        throw new Error(`Failed to allocate room message sequence for room ${payload.roomId}`);
      }

      this.db
        .prepare(
          `
          INSERT INTO room_messages (
            id, room_id, seq, speaker_type, speaker_persona_id, content, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          id,
          payload.roomId,
          seq,
          payload.speakerType,
          payload.speakerPersonaId || null,
          payload.content,
          JSON.stringify(payload.metadata || {}),
          now,
        );
      return seq;
    });

    const seq = tx(input);
    const row = this.db
      .prepare('SELECT * FROM room_messages WHERE room_id = ? AND seq = ?')
      .get(input.roomId, seq) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error('Failed to load inserted room message');
    }
    return toMessage(row);
  }

  listMessages(roomId: string, limit = 100, beforeSeq?: number): RoomMessage[] {
    const cappedLimit = Math.max(1, Math.min(limit, 200));
    let rows: Array<Record<string, unknown>>;
    if (typeof beforeSeq === 'number') {
      rows = this.db
        .prepare(
          `
          SELECT * FROM (
            SELECT * FROM room_messages
            WHERE room_id = ? AND seq < ?
            ORDER BY seq DESC
            LIMIT ?
          ) sub ORDER BY seq ASC
        `,
        )
        .all(roomId, beforeSeq, cappedLimit) as Array<Record<string, unknown>>;
    } else {
      rows = this.db
        .prepare(
          `
          SELECT * FROM (
            SELECT * FROM room_messages
            WHERE room_id = ?
            ORDER BY seq DESC
            LIMIT ?
          ) sub ORDER BY seq ASC
        `,
        )
        .all(roomId, cappedLimit) as Array<Record<string, unknown>>;
    }
    return rows.map(toMessage);
  }

  countMessages(roomId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM room_messages WHERE room_id = ?')
      .get(roomId) as { count: number };
    return Number(row.count || 0);
  }

  addIntervention(roomId: string, userId: string, note: string): RoomIntervention {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO room_interventions (id, room_id, user_id, note, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(id, roomId, userId, note, now);
    return { id, roomId, userId, note, createdAt: now };
  }

  listInterventions(roomId: string, limit = 50): RoomIntervention[] {
    const cappedLimit = Math.max(1, Math.min(limit, 200));
    const rows = this.db
      .prepare(
        `
        SELECT * FROM room_interventions
        WHERE room_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(roomId, cappedLimit) as Array<Record<string, unknown>>;
    return rows.map(toIntervention);
  }

  setPersonaPermissions(personaId: string, permissions: PersonaPermissions): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO persona_permissions (persona_id, tools_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(persona_id) DO UPDATE
          SET tools_json = excluded.tools_json,
              updated_at = excluded.updated_at
      `,
      )
      .run(personaId, JSON.stringify(permissions.tools || {}), now);
  }

  getPersonaPermissions(personaId: string): PersonaPermissions | null {
    const row = this.db
      .prepare('SELECT tools_json FROM persona_permissions WHERE persona_id = ?')
      .get(personaId) as { tools_json: string } | undefined;
    if (!row) {
      return null;
    }
    return { tools: JSON.parse(row.tools_json) as Record<string, boolean> };
  }

  acquireRoomLease(roomId: string, leaseOwner: string, leaseExpiresAt: string): RoomRun {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const active = this.db
        .prepare('SELECT * FROM room_runs WHERE room_id = ? AND ended_at IS NULL')
        .get(roomId) as Record<string, unknown> | undefined;

      if (active) {
        const activeLeaseOwner = (active.lease_owner as string) || null;
        const activeLeaseExpiresAt = (active.lease_expires_at as string) || null;
        if (
          activeLeaseOwner &&
          activeLeaseOwner !== leaseOwner &&
          activeLeaseExpiresAt &&
          activeLeaseExpiresAt > now
        ) {
          return toRun(active);
        }

        this.db
          .prepare(
            `
            UPDATE room_runs
            SET run_state = 'running',
                lease_owner = ?,
                lease_expires_at = ?,
                heartbeat_at = ?,
                failure_reason = NULL,
                updated_at = ?,
                ended_at = NULL
            WHERE id = ?
          `,
          )
          .run(leaseOwner, leaseExpiresAt, now, now, active.id as string);
      } else {
        this.db
          .prepare(
            `
            INSERT INTO room_runs (
              id, room_id, run_state, lease_owner, lease_expires_at, heartbeat_at, failure_reason, started_at, ended_at, created_at, updated_at
            ) VALUES (?, ?, 'running', ?, ?, ?, NULL, ?, NULL, ?, ?)
          `,
          )
          .run(crypto.randomUUID(), roomId, leaseOwner, leaseExpiresAt, now, now, now, now);
      }

      this.db
        .prepare('UPDATE rooms SET run_state = ?, updated_at = ? WHERE id = ?')
        .run('running', now, roomId);

      const current = this.db
        .prepare('SELECT * FROM room_runs WHERE room_id = ? AND ended_at IS NULL')
        .get(roomId) as Record<string, unknown>;
      return toRun(current);
    });

    return tx();
  }

  heartbeatRoomLease(
    roomId: string,
    runId: string,
    leaseOwner: string,
    leaseExpiresAt: string,
  ): RoomRun {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        UPDATE room_runs
        SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND room_id = ? AND lease_owner = ? AND ended_at IS NULL
      `,
      )
      .run(now, leaseExpiresAt, now, runId, roomId, leaseOwner);
    if (result.changes === 0) {
      throw new Error(`Could not heartbeat run lease: ${roomId}/${runId}`);
    }
    const row = this.db
      .prepare('SELECT * FROM room_runs WHERE id = ?')
      .get(runId) as Record<string, unknown>;
    return toRun(row);
  }

  getActiveRoomRun(roomId: string): RoomRun | null {
    const row = this.db
      .prepare('SELECT * FROM room_runs WHERE room_id = ? AND ended_at IS NULL')
      .get(roomId) as Record<string, unknown> | undefined;
    return row ? toRun(row) : null;
  }

  closeActiveRoomRun(
    roomId: string,
    endedState: RoomRunState = 'stopped',
    failureReason: string | null = null,
  ): void {
    const now = new Date().toISOString();
    const active = this.getActiveRoomRun(roomId);
    if (active) {
      this.db
        .prepare(
          `
          UPDATE room_runs
          SET run_state = ?, failure_reason = ?, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ?, ended_at = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(endedState, failureReason, now, now, now, active.id);
    }

    this.db
      .prepare('UPDATE rooms SET run_state = ?, updated_at = ? WHERE id = ?')
      .run(endedState, now, roomId);
  }

  upsertMemberRuntime(input: UpsertMemberRuntimeInput): RoomMemberRuntime {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO room_member_runtime (
          room_id, persona_id, status, busy_reason, busy_until, current_task, last_model, last_profile_id, last_tool, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_id, persona_id) DO UPDATE SET
          status = excluded.status,
          busy_reason = excluded.busy_reason,
          busy_until = excluded.busy_until,
          current_task = excluded.current_task,
          last_model = excluded.last_model,
          last_profile_id = excluded.last_profile_id,
          last_tool = excluded.last_tool,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        input.roomId,
        input.personaId,
        input.status,
        input.busyReason || null,
        input.busyUntil || null,
        input.currentTask || null,
        input.lastModel || null,
        input.lastProfileId || null,
        input.lastTool || null,
        now,
      );

    return this.getMemberRuntime(input.roomId, input.personaId)!;
  }

  getMemberRuntime(roomId: string, personaId: string): RoomMemberRuntime | null {
    const row = this.db
      .prepare('SELECT * FROM room_member_runtime WHERE room_id = ? AND persona_id = ?')
      .get(roomId, personaId) as Record<string, unknown> | undefined;
    return row ? toMemberRuntime(row) : null;
  }

  listMemberRuntime(roomId: string): RoomMemberRuntime[] {
    const rows = this.db
      .prepare('SELECT * FROM room_member_runtime WHERE room_id = ? ORDER BY updated_at DESC')
      .all(roomId) as Array<Record<string, unknown>>;
    return rows.map(toMemberRuntime);
  }

  upsertPersonaSession(
    roomId: string,
    personaId: string,
    input: { providerId: string; model: string; sessionId: string },
  ): RoomPersonaSession {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO room_persona_sessions (room_id, persona_id, provider_id, model, session_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_id, persona_id) DO UPDATE SET
          provider_id = excluded.provider_id,
          model = excluded.model,
          session_id = excluded.session_id,
          updated_at = excluded.updated_at
      `,
      )
      .run(roomId, personaId, input.providerId, input.model, input.sessionId, now);
    return this.getPersonaSession(roomId, personaId)!;
  }

  getPersonaSession(roomId: string, personaId: string): RoomPersonaSession | null {
    const row = this.db
      .prepare('SELECT * FROM room_persona_sessions WHERE room_id = ? AND persona_id = ?')
      .get(roomId, personaId) as Record<string, unknown> | undefined;
    return row ? toPersonaSession(row) : null;
  }

  upsertPersonaContext(
    roomId: string,
    personaId: string,
    input: { summary: string; lastMessageSeq: number },
  ): RoomPersonaContext {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO room_persona_context (room_id, persona_id, summary_text, last_message_seq, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(room_id, persona_id) DO UPDATE SET
          summary_text = excluded.summary_text,
          last_message_seq = excluded.last_message_seq,
          updated_at = excluded.updated_at
      `,
      )
      .run(roomId, personaId, input.summary, input.lastMessageSeq, now);
    return this.getPersonaContext(roomId, personaId)!;
  }

  getPersonaContext(roomId: string, personaId: string): RoomPersonaContext | null {
    const row = this.db
      .prepare('SELECT * FROM room_persona_context WHERE room_id = ? AND persona_id = ?')
      .get(roomId, personaId) as Record<string, unknown> | undefined;
    return row ? toPersonaContext(row) : null;
  }

  listActiveRoomCountsByPersona(userId: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `
        SELECT rm.persona_id AS persona_id, COUNT(*) AS count
        FROM room_members rm
        INNER JOIN rooms r ON r.id = rm.room_id
        WHERE r.user_id = ? AND r.run_state = 'running'
        GROUP BY rm.persona_id
      `,
      )
      .all(userId) as Array<{ persona_id: string; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.persona_id] = Number(row.count || 0);
    }
    return counts;
  }

  getMetrics(): {
    totalRooms: number;
    runningRooms: number;
    totalMembers: number;
    totalMessages: number;
  } {
    const totalRooms = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM rooms').get() as { count: number }).count || 0,
    );
    const runningRooms = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM rooms WHERE run_state = 'running'")
          .get() as { count: number }
      ).count || 0,
    );
    const totalMembers = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM room_members').get() as { count: number })
        .count || 0,
    );
    const totalMessages = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM room_messages').get() as { count: number })
        .count || 0,
    );

    return { totalRooms, runningRooms, totalMembers, totalMessages };
  }

  close(): void {
    this.db.close();
  }
}
