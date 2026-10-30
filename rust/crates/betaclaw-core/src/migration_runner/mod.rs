//! Startup runner for the SQLite databases of the Rust backend.
//!
//! [`run_all`] opens every database that the TypeScript backend opens and runs
//! the migrations that belong to it. The statements live in the modules that
//! port them (`tasks::migrations`, `messages_store::migrations`, ...). This file
//! decides which of them run, in which order, and on which file.
//!
//! # Ledger
//!
//! Only mission-control.db has a `_migrations` ledger on the TypeScript side
//! (`src/lib/db/migrations.ts`). Steps 001 to 014 are recorded there under the
//! names of that file, and each step writes its row in the same transaction as
//! its DDL. The other databases have no ledger in TypeScript, so none is created
//! here either: a new table would change what the TypeScript backend sees when
//! it opens the same file. Their ladders are idempotent `IF NOT EXISTS` DDL and
//! run on every start.
//!
//! # Order
//!
//! Only the order inside one file matters, because the files do not depend on
//! each other. The TypeScript backend reaches them lazily through its
//! request-time singletons, so there is no single startup sequence to copy.
//! Mission-control runs the tasks ladder (002, 003, 004, 006, 008, 013, 014),
//! the legacy tables of `schema.ts`, the steps 001, 005 and 007 and finally the
//! engineering steps 009 to 012. Ledger rows are inserted in that order, which
//! differs from the id order only in insertion order; the steps do not depend on
//! each other. messages.db runs the messages store first, because it creates the
//! base tables of that file, and the stores that share it follow.
//!
//! # Departures from TypeScript
//!
//! * `tasks::migrations` runs with foreign keys off, so a mission-control.db from
//!   before step 002 with rows migrates. The TypeScript backend fails there,
//!   because `schema.ts` creates a workspace index before the ladder adds the
//!   column.
//! * `auth.db` gets its DDL only. `AuthUserStore::open` with an empty
//!   [`BootstrapConfig`] seeds no account; the default account stays with the
//!   auth runtime.
//! * The world model keeps its tables in Postgres and is not part of this runner.

use std::collections::HashSet;
use std::fmt::Display;

use rusqlite::{params, Connection};

use crate::agent_v2::migrations::run_migrations as run_agent_v2_migrations;
use crate::auth::user_store::{AuthUserStore, BootstrapConfig};
use crate::automation::sqlite_repository::migration::migrate_automation_schema;
use crate::clawhub::repository::ClawHubRepository;
use crate::db::{self, OpenOptions};
use crate::gateway_config::constants::GATEWAY_CONFIG_DB_TABLE_SQL;
use crate::knowledge::repositories::migrations::run_knowledge_migrations;
use crate::logging::repository::LogRepository;
use crate::master::migrations::run_master_migrations;
use crate::memory::sqlite::migrations::run_migrations as run_memory_migrations;
use crate::messages_store::migrations::{has_column, run_migrations as run_messages_migrations};
use crate::model_hub::sqlite::SqliteModelHubRepository;
use crate::personas::repository::PersonaRepository;
use crate::personas::telegram_bots::PersonaTelegramBotRegistry;
use crate::personas::workspace::PersonaWorkspace;
use crate::proactive::sqlite_repository::SqliteProactiveRepository;
use crate::skills::runtime_config::SkillRuntimeConfigStore;
use crate::skills::store::SkillRepository;
use crate::stats::engineering_migrations::run_engineering_migrations;
use crate::stats::prompt_dispatch::migration::migrate as migrate_prompt_dispatch;
use crate::stats::token_usage::TokenUsageRepository;
use crate::tasks::migrations::run_migrations as run_tasks_migrations;

/// Paths of every database, resolved the way the TypeScript backend resolves them.
#[derive(Debug, Clone)]
pub struct DbPaths {
    pub mission_control: String,
    pub messages: String,
    /// Defaults to `messages`, as in TypeScript. agent_v2 always uses `messages`.
    pub knowledge: String,
    /// Defaults to `messages`, as in TypeScript.
    pub memory: String,
    /// Defaults to `messages`, as in TypeScript.
    pub proactive: String,
    pub personas: String,
    /// Root of the persona workspace. Only the persona migration writes here.
    pub personas_root: String,
    pub automation: String,
    pub stats: String,
    pub skills: String,
    pub clawhub: String,
    pub master: String,
    pub logs: String,
    pub auth: String,
    pub model_hub: String,
    pub gateway_config: String,
}

impl DbPaths {
    /// The paths the TypeScript backend derives from its environment, with the same fallbacks.
    pub fn from_env() -> Self {
        let messages = env_or("MESSAGES_DB_PATH", ".local/messages.db");
        Self {
            mission_control: env_or("DATABASE_PATH", "mission-control.db"),
            knowledge: env_or("KNOWLEDGE_DB_PATH", &messages),
            memory: env_or("MEMORY_DB_PATH", &messages),
            proactive: env_or("PROACTIVE_DB_PATH", &messages),
            messages,
            personas: env_or("PERSONAS_DB_PATH", ".local/personas.db"),
            personas_root: PersonaWorkspace::from_env()
                .root_dir()
                .to_string_lossy()
                .into_owned(),
            automation: env_or("AUTOMATION_DB_PATH", ".local/automation.db"),
            stats: env_or("STATS_DB_PATH", ".local/stats.db"),
            skills: env_or("SKILLS_DB_PATH", ".local/skills.db"),
            clawhub: env_or("CLAWHUB_DB_PATH", ".local/clawhub.db"),
            master: env_or("MASTER_DB_PATH", ".local/master.db"),
            logs: env_or("LOGS_DB_PATH", ".local/logs.db"),
            auth: env_or("AUTH_DB_PATH", ".local/auth.db"),
            model_hub: env_or("MODEL_HUB_DB_PATH", ".local/model-hub.db"),
            gateway_config: ".local/gateway-config.db".to_string(),
        }
    }
}

fn env_or(name: &str, fallback: &str) -> String {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => value,
        _ => fallback.to_string(),
    }
}

/// A migration step that failed, with the store and the step it belongs to.
#[derive(Debug, thiserror::Error)]
#[error("migration `{step}` of {store} failed: {message}")]
pub struct MigrationError {
    pub store: &'static str,
    pub step: &'static str,
    pub message: String,
}

fn at<T, E: Display>(
    store: &'static str,
    step: &'static str,
    result: Result<T, E>,
) -> Result<T, MigrationError> {
    result.map_err(|error| MigrationError {
        store,
        step,
        message: error.to_string(),
    })
}

type Step = fn(&Connection) -> rusqlite::Result<()>;

/// Runs the migrations of every database in the order described in the module docs.
pub fn run_all(paths: &DbPaths) -> Result<(), MigrationError> {
    run_mission_control(&paths.mission_control)?;

    ddl(
        "messages",
        "messages_store",
        &paths.messages,
        run_messages_migrations,
    )?;
    ddl(
        "knowledge",
        "knowledge",
        &paths.knowledge,
        run_knowledge_migrations,
    )?;
    ddl("memory", "memory", &paths.memory, run_memory_migrations)?;
    ddl(
        "agent_v2",
        "agent_v2",
        &paths.messages,
        run_agent_v2_migrations,
    )?;
    repo(
        "proactive",
        SqliteProactiveRepository::open(&paths.proactive),
    )?;

    repo(
        "personas",
        PersonaRepository::open_with_workspace(
            &paths.personas,
            PersonaWorkspace::new(&paths.personas_root),
        ),
    )?;
    repo(
        "personas",
        PersonaTelegramBotRegistry::open(&paths.personas),
    )?;

    ddl(
        "automation",
        "automation",
        &paths.automation,
        migrate_automation_schema,
    )?;

    repo("stats", TokenUsageRepository::open(&paths.stats))?;
    ddl(
        "stats",
        "prompt_dispatch",
        &paths.stats,
        migrate_prompt_dispatch,
    )?;

    repo("skills", SkillRepository::open(&paths.skills))?;
    repo("skills", SkillRuntimeConfigStore::open(&paths.skills))?;

    repo("clawhub", ClawHubRepository::open(&paths.clawhub))?;
    ddl("master", "master", &paths.master, run_master_migrations)?;
    repo("logs", LogRepository::open(&paths.logs))?;
    repo(
        "auth",
        AuthUserStore::open(&paths.auth, &BootstrapConfig::default()),
    )?;
    repo(
        "model_hub",
        SqliteModelHubRepository::open(&paths.model_hub),
    )?;
    ddl(
        "gateway_config",
        "gateway_config_state",
        &paths.gateway_config,
        |connection| connection.execute_batch(GATEWAY_CONFIG_DB_TABLE_SQL),
    )?;
    Ok(())
}

fn open_db(store: &'static str, path: &str) -> Result<Connection, MigrationError> {
    at(store, "open", db::open(OpenOptions::new(path)))
}

/// Opens a file and runs one DDL function on it.
fn ddl(
    store: &'static str,
    step: &'static str,
    path: &str,
    run: impl FnOnce(&Connection) -> rusqlite::Result<()>,
) -> Result<(), MigrationError> {
    let connection = open_db(store, path)?;
    at(store, step, run(&connection))
}

/// Opens a repository whose constructor runs its own migrations, then drops it.
fn repo<T, E: Display>(store: &'static str, opened: Result<T, E>) -> Result<(), MigrationError> {
    at(store, "open", opened).map(drop)
}

const LEDGER_DDL: &str = "CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now'))
)";

/// The tables of `src/lib/db/schema.ts` that the tasks module leaves to their
/// owners. The TypeScript backend still creates them in mission-control.db.
const LEGACY_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  joined_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, agent_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  sender_agent_id TEXT REFERENCES agents(id),
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'task_update', 'file')),
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
"#;

/// Steps 001, 005 and 007 of `migrations.ts`. The tasks ladder leaves their
/// ledger rows out, so they run here.
const LEDGER_STEPS: [(&str, &str, Step); 3] = [
    ("001", "initial_schema", baseline),
    ("005", "add_agent_model_field", add_agent_model_field),
    (
        "007",
        "add_agent_source_and_gateway_id",
        add_agent_source_and_gateway_id,
    ),
];

fn run_mission_control(path: &str) -> Result<(), MigrationError> {
    const STORE: &str = "mission_control";
    let mut connection = open_db(STORE, path)?;
    at(STORE, "tasks", run_tasks_migrations(&mut connection))?;
    at(
        STORE,
        "legacy_tables",
        connection.execute_batch(LEGACY_SCHEMA),
    )?;
    run_ledger_steps(&mut connection)?;
    at(
        STORE,
        "engineering",
        run_engineering_migrations(&mut connection),
    )?;
    Ok(())
}

fn run_ledger_steps(connection: &mut Connection) -> Result<(), MigrationError> {
    const STORE: &str = "mission_control";
    at(STORE, "ledger", connection.execute_batch(LEDGER_DDL))?;
    let applied = at(STORE, "ledger", applied_ids(connection))?;
    for (id, name, step) in LEDGER_STEPS {
        if applied.contains(id) {
            continue;
        }
        at(STORE, name, run_ledger_step(connection, id, name, step))?;
    }
    Ok(())
}

fn applied_ids(connection: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut statement = connection.prepare("SELECT id FROM _migrations")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let ids = rows.collect::<rusqlite::Result<HashSet<String>>>()?;
    Ok(ids)
}

fn run_ledger_step(
    connection: &mut Connection,
    id: &str,
    name: &str,
    step: Step,
) -> rusqlite::Result<()> {
    let transaction = connection.transaction()?;
    step(&transaction)?;
    transaction.execute(
        "INSERT INTO _migrations (id, name) VALUES (?, ?)",
        params![id, name],
    )?;
    transaction.commit()
}

/// Step 001. The TypeScript step only logs a marker.
fn baseline(_connection: &Connection) -> rusqlite::Result<()> {
    Ok(())
}

fn add_agent_model_field(connection: &Connection) -> rusqlite::Result<()> {
    if !has_column(connection, "agents", "model")? {
        connection.execute_batch("ALTER TABLE agents ADD COLUMN model TEXT;")?;
    }
    Ok(())
}

fn add_agent_source_and_gateway_id(connection: &Connection) -> rusqlite::Result<()> {
    if !has_column(connection, "agents", "source")? {
        connection.execute_batch("ALTER TABLE agents ADD COLUMN source TEXT DEFAULT 'local';")?;
    }
    if !has_column(connection, "agents", "gateway_agent_id")? {
        connection.execute_batch("ALTER TABLE agents ADD COLUMN gateway_agent_id TEXT;")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// Ledger rows of a mission-control.db as `(id, name)`, in id order.
    fn ledger(path: &str) -> Vec<(String, String)> {
        let connection = Connection::open(path).expect("open mission-control.db");
        let mut statement = connection
            .prepare("SELECT id, name FROM _migrations ORDER BY id")
            .expect("prepare ledger query");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query ledger")
            .map(|row| row.expect("ledger row"))
            .collect()
    }

    /// The ledger of `migrations.ts`, ids 001 to 014 and their names.
    fn typescript_ledger() -> Vec<(String, String)> {
        [
            ("001", "initial_schema"),
            ("002", "add_workspaces"),
            ("003", "add_planning_tables"),
            ("004", "add_planning_session_columns"),
            ("005", "add_agent_model_field"),
            ("006", "add_planning_dispatch_error_column"),
            ("007", "add_agent_source_and_gateway_id"),
            ("008", "drop_legacy_planning_tables"),
            ("009", "add_engineering_metrics_tables"),
            ("010", "add_harness_run_events_table"),
            ("011", "extend_harness_run_events_v3"),
            ("012", "add_engineering_rollout_tables"),
            ("013", "add_workspace_memberships"),
            ("014", "add_betaclaw_session_workspace"),
        ]
        .iter()
        .map(|(id, name)| (id.to_string(), name.to_string()))
        .collect()
    }

    fn table_exists(path: &str, table: &str) -> bool {
        let connection = Connection::open(path).expect("open database");
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get::<_, i64>(0),
            )
            .expect("query sqlite_master")
            == 1
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "betaclaw-migration-runner-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Every database in one temp directory. knowledge, memory and proactive share
    /// messages.db, as they do by default.
    fn paths_in(dir: &Path) -> DbPaths {
        let file = |name: &str| dir.join(name).to_string_lossy().into_owned();
        let messages = file("messages.db");
        DbPaths {
            mission_control: file("mission-control.db"),
            knowledge: messages.clone(),
            memory: messages.clone(),
            proactive: messages.clone(),
            messages,
            personas: file("personas.db"),
            personas_root: dir.join("personas").to_string_lossy().into_owned(),
            automation: file("automation.db"),
            stats: file("stats.db"),
            skills: file("skills.db"),
            clawhub: file("clawhub.db"),
            master: file("master.db"),
            logs: file("logs.db"),
            auth: file("auth.db"),
            model_hub: file("model-hub.db"),
            gateway_config: file("gateway-config.db"),
        }
    }

    #[test]
    fn migration_runner_fresh_databases_get_every_table_and_the_typescript_ledger() {
        let dir = TempDir::new();
        let paths = paths_in(&dir.0);
        run_all(&paths).expect("migrate fresh databases");

        assert_eq!(ledger(&paths.mission_control), typescript_ledger());
        let checks = [
            (&paths.mission_control, "tasks"),
            (&paths.mission_control, "businesses"),
            (&paths.mission_control, "engineering_metrics_snapshots"),
            (&paths.messages, "messages"),
            (&paths.messages, "channel_credentials"),
            (&paths.messages, "agent_v2_sessions"),
            (&paths.messages, "memory_nodes"),
            (&paths.messages, "knowledge_ingestion_checkpoints"),
            (&paths.messages, "proactive_signals"),
            (&paths.personas, "personas"),
            (&paths.personas, "persona_telegram_bots"),
            (&paths.automation, "automation_rules"),
            (&paths.stats, "token_usage"),
            (&paths.stats, "prompt_dispatch_logs"),
            (&paths.skills, "skills"),
            (&paths.skills, "skill_runtime_config"),
            (&paths.clawhub, "clawhub_skills"),
            (&paths.logs, "system_logs"),
            (&paths.auth, "auth_users"),
            (&paths.model_hub, "model_hub_accounts"),
            (&paths.gateway_config, "gateway_config_state"),
        ];
        for (path, table) in checks {
            assert!(table_exists(path, table), "{table} missing in {path}");
        }
    }

    #[test]
    fn migration_runner_second_run_changes_nothing() {
        let dir = TempDir::new();
        let paths = paths_in(&dir.0);
        run_all(&paths).expect("first run");
        let first = ledger(&paths.mission_control);
        run_all(&paths).expect("second run");
        assert_eq!(ledger(&paths.mission_control), first);
        assert_eq!(first.len(), 14);
    }

    #[test]
    fn migration_runner_mission_control_from_before_step_002_migrates() {
        let dir = TempDir::new();
        let paths = paths_in(&dir.0);
        {
            let connection = Connection::open(&paths.mission_control).expect("create legacy db");
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
        }

        run_all(&paths).expect("migrate a database from before step 002");

        assert_eq!(ledger(&paths.mission_control), typescript_ledger());
        let connection = Connection::open(&paths.mission_control).expect("reopen");
        let task_workspace: String = connection
            .query_row(
                "SELECT workspace_id FROM tasks WHERE id = 't1'",
                [],
                |row| row.get(0),
            )
            .expect("task row survives");
        assert_eq!(task_workspace, "default");
        let session_workspace: Option<String> = connection
            .query_row(
                "SELECT workspace_id FROM betaclaw_sessions WHERE id = 's1'",
                [],
                |row| row.get(0),
            )
            .expect("session row survives");
        assert_eq!(session_workspace.as_deref(), Some("default"));
        for column in ["model", "source", "gateway_agent_id"] {
            assert!(
                has_column(&connection, "agents", column).expect("table_info"),
                "agents.{column} missing"
            );
        }
    }
}
