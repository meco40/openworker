//! Port of the parts of `src/lib/db/schema.ts` and `src/lib/db/migrations.ts` that
//! the task code depends on: the base DDL, the `_migrations` ledger and the
//! ladder steps 002, 003, 004, 006, 008, 013 and 014.
//!
//! The TypeScript backend runs `db.exec(schema)` and then `runMigrations(db)` on
//! every open. This module does the same, in the same order, with the same
//! statements and the same ledger, so both backends can open one database file.
//!
//! Only the ledger rows of steps that this module ran are written. A row says
//! "the statements ran", so a row for a step that did not run would make the
//! TypeScript runner skip that step for good. Steps 001, 005, 007 and 009-012
//! stay pending. They belong to other slices or to the TypeScript side, and
//! their statements are idempotent, so the TypeScript runner applies them later.
//!
//! Two departures from the TypeScript runner, both for databases that predate
//! step 002 (`tasks` and `agents` without `workspace_id`):
//! * The workspace indexes are created after their `ALTER TABLE`. `schema.ts`
//!   creates them before the ladder, which fails on such a database.
//! * Foreign-key enforcement is off while the ladder runs. Step 002 adds a
//!   `REFERENCES` column with a non-NULL default, which SQLite rejects on a
//!   non-empty table while enforcement is on. See [`run_migrations`].
//!
//! The base DDL creates only the tables that task code reads or writes:
//! `workspaces`, `agents`, `tasks`, `conversations`, `events`,
//! `betaclaw_sessions`, `task_activities` and `task_deliverables`. The tables of
//! other slices (`messages`, `conversation_participants`, `businesses`) are left
//! to their owners. Step 013 creates `workspace_members`.

use std::collections::HashSet;

use rusqlite::{params, Connection};

use super::js_trim;

const BASE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT DEFAULT '📁',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT,
  avatar_emoji TEXT DEFAULT '🤖',
  status TEXT DEFAULT 'standby' CHECK (status IN ('standby', 'working', 'offline')),
  is_master INTEGER DEFAULT 0,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  soul_md TEXT,
  user_md TEXT,
  agents_md TEXT,
  model TEXT,
  source TEXT DEFAULT 'local',
  gateway_agent_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'inbox' CHECK (status IN ('pending_dispatch', 'planning', 'inbox', 'assigned', 'in_progress', 'testing', 'review', 'done')),
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_agent_id TEXT REFERENCES agents(id),
  created_by_agent_id TEXT REFERENCES agents(id),
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  business_id TEXT DEFAULT 'default',
  due_date TEXT,
  planning_session_key TEXT,
  planning_messages TEXT,
  planning_complete INTEGER DEFAULT 0,
  planning_spec TEXT,
  planning_agents TEXT,
  planning_dispatch_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT DEFAULT 'direct' CHECK (type IN ('direct', 'group', 'task')),
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS betaclaw_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  workspace_id TEXT REFERENCES workspaces(id),
  betaclaw_session_id TEXT NOT NULL,
  channel TEXT,
  status TEXT DEFAULT 'active',
  session_type TEXT DEFAULT 'persistent',
  task_id TEXT REFERENCES tasks(id),
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id),
  activity_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_deliverables (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  deliverable_type TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_activities_task ON task_activities(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverables_task ON task_deliverables(task_id);
CREATE INDEX IF NOT EXISTS idx_betaclaw_sessions_task ON betaclaw_sessions(task_id);
"#;

const LEDGER_DDL: &str = "CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now'))
)";

type Step = fn(&Connection) -> rusqlite::Result<()>;

/// The ladder steps this module runs, in the order of `migrations.ts`.
const LADDER: [(&str, &str, Step); 7] = [
    ("002", "add_workspaces", add_workspaces),
    ("003", "add_planning_tables", add_planning_tables),
    (
        "004",
        "add_planning_session_columns",
        add_planning_session_columns,
    ),
    (
        "006",
        "add_planning_dispatch_error_column",
        add_planning_dispatch_error_column,
    ),
    (
        "008",
        "drop_legacy_planning_tables",
        drop_legacy_planning_tables,
    ),
    (
        "013",
        "add_workspace_memberships",
        add_workspace_memberships,
    ),
    (
        "014",
        "add_betaclaw_session_workspace",
        add_betaclaw_session_workspace,
    ),
];

/// The fallback of step 013 when `PRINCIPAL_USER_ID` is blank.
const LEGACY_PRINCIPAL_ID: &str = "legacy-local-user";

/// `db.exec(schema)` followed by `runMigrations(db)`.
///
/// Foreign-key enforcement is switched off for the ladder and restored afterwards.
/// `PRAGMA foreign_keys` does nothing inside a transaction, so the switch has to
/// wrap the per-step transactions and cannot live inside a step.
pub fn run_migrations(connection: &mut Connection) -> rusqlite::Result<()> {
    connection.execute_batch(BASE_SCHEMA)?;
    connection.execute_batch(LEDGER_DDL)?;

    let applied: HashSet<String> = {
        let mut statement = connection.prepare("SELECT id FROM _migrations")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<HashSet<String>>>()?
    };

    let foreign_keys_were_on =
        connection.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))? == 1;
    connection.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let outcome = run_ladder(connection, &applied);
    if foreign_keys_were_on {
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    }
    outcome
}

fn run_ladder(connection: &mut Connection, applied: &HashSet<String>) -> rusqlite::Result<()> {
    for (id, name, step) in LADDER {
        if applied.contains(id) {
            continue;
        }
        let transaction = connection.transaction()?;
        step(&transaction)?;
        transaction.execute(
            "INSERT INTO _migrations (id, name) VALUES (?, ?)",
            params![id, name],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

fn has_column(connection: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get("name")?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Step 002. Its `CREATE TABLE workspaces` is already part of the base DDL.
///
/// The indexes run after the `ALTER` steps and on every call. A fresh database
/// already has the column from the base DDL and skips the `ALTER`, so the index
/// cannot hang off the `ALTER` branch.
fn add_workspaces(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon)
         VALUES ('default', 'Default Workspace', 'default', 'Default workspace', '🏠');",
    )?;
    if !has_column(connection, "tasks", "workspace_id")? {
        connection.execute_batch(
            "ALTER TABLE tasks ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id);",
        )?;
    }
    connection
        .execute_batch("CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);")?;
    if !has_column(connection, "agents", "workspace_id")? {
        connection.execute_batch(
            "ALTER TABLE agents ADD COLUMN workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id);",
        )?;
    }
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);",
    )?;
    Ok(())
}

/// Step 003. The check that the `tasks` status constraint lists `planning` only logs in the source.
fn add_planning_tables(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS planning_questions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          category TEXT NOT NULL,
          question TEXT NOT NULL,
          question_type TEXT DEFAULT 'multiple_choice' CHECK (question_type IN ('multiple_choice', 'text', 'yes_no')),
          options TEXT,
          answer TEXT,
          answered_at TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS planning_specs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          spec_markdown TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          locked_by TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_planning_questions_task ON planning_questions(task_id, sort_order);",
    )
}

/// Step 004.
fn add_planning_session_columns(connection: &Connection) -> rusqlite::Result<()> {
    let columns = [
        ("planning_session_key", "TEXT"),
        ("planning_messages", "TEXT"),
        ("planning_complete", "INTEGER DEFAULT 0"),
        ("planning_spec", "TEXT"),
        ("planning_agents", "TEXT"),
    ];
    for (column, definition) in columns {
        if !has_column(connection, "tasks", column)? {
            connection.execute_batch(&format!(
                "ALTER TABLE tasks ADD COLUMN {column} {definition}"
            ))?;
        }
    }
    Ok(())
}

/// Step 006.
fn add_planning_dispatch_error_column(connection: &Connection) -> rusqlite::Result<()> {
    if !has_column(connection, "tasks", "planning_dispatch_error")? {
        connection.execute_batch("ALTER TABLE tasks ADD COLUMN planning_dispatch_error TEXT")?;
    }
    Ok(())
}

/// Step 008.
fn drop_legacy_planning_tables(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_planning_questions_task;
         DROP TABLE IF EXISTS planning_specs;
         DROP TABLE IF EXISTS planning_questions;",
    )
}

/// Step 013. Creates `workspace_members` and gives every existing workspace an
/// owner row for the legacy principal, so a single-principal install keeps access.
fn add_workspace_memberships(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace_members (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
          created_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (workspace_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id, workspace_id);",
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
         SELECT id, ?, 'owner' FROM workspaces",
        params![legacy_principal()],
    )?;
    Ok(())
}

/// Step 014. Adds the workspace scope to `betaclaw_sessions` and backfills it from
/// the session's agent, or else from its task. A session with neither stays NULL.
fn add_betaclaw_session_workspace(connection: &Connection) -> rusqlite::Result<()> {
    if !has_column(connection, "betaclaw_sessions", "workspace_id")? {
        connection.execute_batch(
            "ALTER TABLE betaclaw_sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);",
        )?;
    }
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_betaclaw_sessions_workspace ON betaclaw_sessions(workspace_id);
         UPDATE betaclaw_sessions
         SET workspace_id = COALESCE(
           (SELECT workspace_id FROM agents WHERE agents.id = betaclaw_sessions.agent_id),
           (SELECT workspace_id FROM tasks WHERE tasks.id = betaclaw_sessions.task_id)
         )
         WHERE workspace_id IS NULL;",
    )
}

/// `String(process.env.PRINCIPAL_USER_ID || '').trim() || 'legacy-local-user'`.
/// Not `auth::principal`, whose legacy fallback is a different id.
fn legacy_principal() -> String {
    principal_from(std::env::var("PRINCIPAL_USER_ID").ok().as_deref())
}

fn principal_from(raw: Option<&str>) -> String {
    raw.map(js_trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(LEGACY_PRINCIPAL_ID)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, OpenOptions};

    fn fresh() -> Connection {
        db::open(OpenOptions::new(":memory:")).expect("open in-memory database")
    }

    /// The tables as they were before step 002: no `workspace_id` on `agents`,
    /// `tasks` or `betaclaw_sessions`, and one row in each, so the ALTER statements
    /// run on data.
    fn pre_002_connection() -> Connection {
        let connection = fresh();
        connection
            .execute_batch(
                "CREATE TABLE agents (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
                   status TEXT DEFAULT 'standby', created_at TEXT, updated_at TEXT
                 );
                 CREATE TABLE tasks (
                   id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT DEFAULT 'inbox',
                   assigned_agent_id TEXT REFERENCES agents(id), created_at TEXT, updated_at TEXT
                 );
                 CREATE TABLE betaclaw_sessions (
                   id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id),
                   betaclaw_session_id TEXT NOT NULL, task_id TEXT REFERENCES tasks(id),
                   created_at TEXT, updated_at TEXT
                 );
                 INSERT INTO agents (id, name, role) VALUES ('a1', 'Agent', 'worker');
                 INSERT INTO tasks (id, title, assigned_agent_id) VALUES ('t1', 'Task', 'a1');
                 INSERT INTO betaclaw_sessions (id, agent_id, betaclaw_session_id, task_id)
                   VALUES ('s1', 'a1', 'bc-1', 't1');",
            )
            .expect("pre-002 schema");
        connection
    }

    fn ledger_ids(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT id FROM _migrations ORDER BY id")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    fn table_exists(connection: &Connection, name: &str) -> bool {
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
                [name],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
            == 1
    }

    fn index_exists(connection: &Connection, name: &str) -> bool {
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?",
                [name],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
            == 1
    }

    #[test]
    fn ledger_holds_only_the_steps_this_module_ran() {
        let mut connection = fresh();
        run_migrations(&mut connection).unwrap();
        assert_eq!(
            ledger_ids(&connection),
            ["002", "003", "004", "006", "008", "013", "014"]
        );
    }

    #[test]
    fn ledger_names_match_the_typescript_ladder() {
        let mut connection = fresh();
        run_migrations(&mut connection).unwrap();
        let rows: Vec<(String, String)> = connection
            .prepare("SELECT id, name FROM _migrations ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let expected = [
            ("002", "add_workspaces"),
            ("003", "add_planning_tables"),
            ("004", "add_planning_session_columns"),
            ("006", "add_planning_dispatch_error_column"),
            ("008", "drop_legacy_planning_tables"),
            ("013", "add_workspace_memberships"),
            ("014", "add_betaclaw_session_workspace"),
        ]
        .map(|(id, name)| (id.to_string(), name.to_string()));
        assert_eq!(rows, expected);
    }

    #[test]
    fn rerunning_is_a_no_op() {
        let mut connection = fresh();
        run_migrations(&mut connection).unwrap();
        run_migrations(&mut connection).unwrap();
        assert_eq!(ledger_ids(&connection).len(), 7);
    }

    #[test]
    fn planning_tables_are_created_and_dropped_again() {
        let mut connection = fresh();
        run_migrations(&mut connection).unwrap();
        assert!(!table_exists(&connection, "planning_questions"));
        assert!(!table_exists(&connection, "planning_specs"));
        assert!(table_exists(&connection, "tasks"));
        assert!(table_exists(&connection, "task_deliverables"));
    }

    #[test]
    fn default_workspace_is_seeded() {
        let mut connection = fresh();
        run_migrations(&mut connection).unwrap();
        let slug: String = connection
            .query_row(
                "SELECT slug FROM workspaces WHERE id = 'default'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(slug, "default");
    }

    #[test]
    fn pre_002_database_with_rows_migrates() {
        let mut connection = pre_002_connection();
        run_migrations(&mut connection).expect("migrate a database from before step 002");
        assert!(has_column(&connection, "tasks", "workspace_id").unwrap());
        assert!(has_column(&connection, "agents", "workspace_id").unwrap());
        assert!(index_exists(&connection, "idx_tasks_workspace"));
        assert!(index_exists(&connection, "idx_agents_workspace"));
        let task_workspace: String = connection
            .query_row(
                "SELECT workspace_id FROM tasks WHERE id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(task_workspace, "default");
        let session_workspace: Option<String> = connection
            .query_row(
                "SELECT workspace_id FROM betaclaw_sessions WHERE id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(session_workspace.as_deref(), Some("default"));
        assert_eq!(ledger_ids(&connection).len(), 7);
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn workspace_members_gives_the_legacy_principal_ownership() {
        let mut connection = fresh();
        run_migrations(&mut connection).unwrap();
        let (user_id, role): (String, String) = connection
            .query_row(
                "SELECT user_id, role FROM workspace_members WHERE workspace_id = 'default'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(user_id, legacy_principal());
        assert_eq!(role, "owner");
    }

    #[test]
    fn principal_falls_back_to_the_typescript_legacy_id() {
        assert_eq!(principal_from(None), "legacy-local-user");
        assert_eq!(principal_from(Some("   ")), "legacy-local-user");
        assert_eq!(principal_from(Some(" alice ")), "alice");
    }

    #[test]
    fn betaclaw_sessions_workspace_is_added_and_backfilled() {
        let mut connection = fresh();
        run_migrations(&mut connection).unwrap();
        // Recreate the table as it was before step 014 and forget that step ran.
        connection
            .execute_batch(
                "DROP TABLE betaclaw_sessions;
                 CREATE TABLE betaclaw_sessions (
                   id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id),
                   betaclaw_session_id TEXT NOT NULL, channel TEXT, status TEXT DEFAULT 'active',
                   session_type TEXT DEFAULT 'persistent', task_id TEXT REFERENCES tasks(id),
                   ended_at TEXT, created_at TEXT, updated_at TEXT
                 );
                 INSERT INTO workspaces (id, name, slug) VALUES ('ws-b', 'B', 'ws-b');
                 INSERT INTO agents (id, name, role, workspace_id) VALUES ('a-b', 'Bee', 'worker', 'ws-b');
                 INSERT INTO tasks (id, title, workspace_id) VALUES ('t-b', 'Task B', 'ws-b');
                 INSERT INTO betaclaw_sessions (id, agent_id, betaclaw_session_id)
                   VALUES ('s-agent', 'a-b', 'bc-1');
                 INSERT INTO betaclaw_sessions (id, task_id, betaclaw_session_id)
                   VALUES ('s-task', 't-b', 'bc-2');
                 INSERT INTO betaclaw_sessions (id, betaclaw_session_id)
                   VALUES ('s-none', 'bc-3');
                 DELETE FROM _migrations WHERE id IN ('013', '014');",
            )
            .unwrap();
        run_migrations(&mut connection).unwrap();

        let workspace_of = |id: &str| -> Option<String> {
            connection
                .query_row(
                    "SELECT workspace_id FROM betaclaw_sessions WHERE id = ?",
                    [id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap()
        };
        assert_eq!(workspace_of("s-agent").as_deref(), Some("ws-b"));
        assert_eq!(workspace_of("s-task").as_deref(), Some("ws-b"));
        assert_eq!(workspace_of("s-none"), None);
    }
}
