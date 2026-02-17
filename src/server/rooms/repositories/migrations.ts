import type BetterSqlite3 from 'better-sqlite3';

/**
 * Database migrations for the rooms module.
 */

export function runMigrations(db: BetterSqlite3.Database): void {
  // Schema migrations for CHECK constraints
  migrateCheckConstraints(db);

  // Core tables
  createRoomsTable(db);
  createRoomMembersTable(db);
  createRoomMessagesTable(db);
  createRoomMessageSequencesTable(db);
  createRoomRunsTable(db);
  createRoomMemberRuntimeTable(db);
  createRoomPersonaSessionsTable(db);
  createRoomPersonaThreadMessagesTable(db);
  createRoomPersonaContextTable(db);
  createPersonaPermissionsTable(db);
  createRoomInterventionsTable(db);
}

function hasColumn(db: BetterSqlite3.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === columnName);
}

function migrateCheckConstraints(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _room_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM _room_migrations').all() as { id: string }[]).map((r) => r.id),
  );

  // Fix broken FK references from previous migration attempt
  if (!applied.has('fix_broken_fk_refs')) {
    fixBrokenForeignKeys(db);
    db.prepare('INSERT OR IGNORE INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
      'fix_broken_fk_refs',
      new Date().toISOString(),
    );
  }

  // Add free goal mode to rooms
  if (!applied.has('rooms_add_free_goal_mode')) {
    const roomsInfo = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rooms'")
      .get() as { sql: string } | undefined;

    if (roomsInfo && !roomsInfo.sql.includes("'free'")) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
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
        db.exec('INSERT INTO _rooms_new SELECT * FROM rooms');
        db.exec('DROP TABLE rooms');
        db.exec('ALTER TABLE _rooms_new RENAME TO rooms');
        db.prepare('INSERT INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
          'rooms_add_free_goal_mode',
          new Date().toISOString(),
        );
      })();
      db.exec('PRAGMA foreign_keys = ON');
    } else {
      db.prepare('INSERT OR IGNORE INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
        'rooms_add_free_goal_mode',
        new Date().toISOString(),
      );
    }
  }

  // Add extended statuses to runtime
  if (!applied.has('runtime_add_extended_statuses')) {
    const runtimeInfo = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='room_member_runtime'")
      .get() as { sql: string } | undefined;

    if (runtimeInfo && !runtimeInfo.sql.includes("'interrupting'")) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
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
        db.exec('INSERT INTO _room_member_runtime_new SELECT * FROM room_member_runtime');
        db.exec('DROP TABLE room_member_runtime');
        db.exec('ALTER TABLE _room_member_runtime_new RENAME TO room_member_runtime');
        db.prepare('INSERT INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
          'runtime_add_extended_statuses',
          new Date().toISOString(),
        );
      })();
      db.exec('PRAGMA foreign_keys = ON');
    } else {
      db.prepare('INSERT OR IGNORE INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
        'runtime_add_extended_statuses',
        new Date().toISOString(),
      );
    }
  }

  // Add paused status to runtime
  if (!applied.has('runtime_add_paused_status')) {
    const runtimeInfo = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='room_member_runtime'")
      .get() as { sql: string } | undefined;

    if (runtimeInfo && !runtimeInfo.sql.includes("'paused'")) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
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
        db.exec('INSERT INTO _room_member_runtime_paused_new SELECT * FROM room_member_runtime');
        db.exec('DROP TABLE room_member_runtime');
        db.exec('ALTER TABLE _room_member_runtime_paused_new RENAME TO room_member_runtime');
        db.prepare('INSERT INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
          'runtime_add_paused_status',
          new Date().toISOString(),
        );
      })();
      db.exec('PRAGMA foreign_keys = ON');
    } else {
      db.prepare('INSERT OR IGNORE INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
        'runtime_add_paused_status',
        new Date().toISOString(),
      );
    }
  }

  // Add description column to rooms
  if (!applied.has('rooms_add_description')) {
    const roomsInfo = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rooms'")
      .get() as { sql: string } | undefined;

    if (roomsInfo && !roomsInfo.sql.includes('description')) {
      db.exec('ALTER TABLE rooms ADD COLUMN description TEXT');
    }
    db.prepare('INSERT OR IGNORE INTO _room_migrations (id, applied_at) VALUES (?, ?)').run(
      'rooms_add_description',
      new Date().toISOString(),
    );
  }
}

function fixBrokenForeignKeys(db: BetterSqlite3.Database): void {
  const brokenTables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%_rooms_old%'")
    .all() as { name: string; sql: string }[];

  if (brokenTables.length === 0) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.transaction(() => {
    for (const table of brokenTables) {
      const fixedSql = table.sql.replace(/"_rooms_old"/g, 'rooms');
      const columns = db.prepare(`PRAGMA table_info("${table.name}")`).all() as {
        name: string;
      }[];
      const colList = columns.map((c) => `"${c.name}"`).join(', ');

      const tempName = `_${table.name}_fkfix`;
      const createSql = fixedSql
        .replace(`CREATE TABLE ${table.name}`, `CREATE TABLE "${tempName}"`)
        .replace(`CREATE TABLE "${table.name}"`, `CREATE TABLE "${tempName}"`);
      db.exec(createSql);
      db.exec(`INSERT INTO "${tempName}" (${colList}) SELECT ${colList} FROM "${table.name}"`);
      db.exec(`DROP TABLE "${table.name}"`);
      db.exec(`ALTER TABLE "${tempName}" RENAME TO "${table.name}"`);
    }
  })();
  db.exec('PRAGMA foreign_keys = ON');
}

function createRoomsTable(db: BetterSqlite3.Database): void {
  db.exec(`
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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rooms_user_updated
      ON rooms (user_id, updated_at DESC);
  `);
}

function createRoomMembersTable(db: BetterSqlite3.Database): void {
  db.exec(`
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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_room_members_room
      ON room_members (room_id, turn_priority ASC, created_at ASC);
  `);
}

function createRoomMessagesTable(db: BetterSqlite3.Database): void {
  db.exec(`
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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_room_messages_room_seq
      ON room_messages (room_id, seq DESC);
  `);
}

function createRoomMessageSequencesTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_message_sequences (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      last_seq INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Sync sequences with existing messages
  db.exec(`
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
}

function createRoomRunsTable(db: BetterSqlite3.Database): void {
  db.exec(`
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

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_room_runs_room_active
      ON room_runs (room_id)
      WHERE ended_at IS NULL;
  `);
}

function createRoomMemberRuntimeTable(db: BetterSqlite3.Database): void {
  db.exec(`
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
}

function createRoomPersonaSessionsTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_persona_sessions (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      persona_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_seen_room_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (room_id, persona_id)
    );
  `);

  // Add last_seen_room_seq column if it doesn't exist
  if (!hasColumn(db, 'room_persona_sessions', 'last_seen_room_seq')) {
    db.exec(
      'ALTER TABLE room_persona_sessions ADD COLUMN last_seen_room_seq INTEGER NOT NULL DEFAULT 0',
    );
  }
}

function createRoomPersonaThreadMessagesTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_persona_thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      persona_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_room_persona_thread_messages_lookup
      ON room_persona_thread_messages (room_id, persona_id, id ASC);
  `);
}

function createRoomPersonaContextTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_persona_context (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      persona_id TEXT NOT NULL,
      summary_text TEXT NOT NULL DEFAULT '',
      last_message_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (room_id, persona_id)
    );
  `);
}

function createPersonaPermissionsTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS persona_permissions (
      persona_id TEXT PRIMARY KEY,
      tools_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function createRoomInterventionsTable(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_interventions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_room_interventions_room_created
      ON room_interventions (room_id, created_at DESC);
  `);
}
