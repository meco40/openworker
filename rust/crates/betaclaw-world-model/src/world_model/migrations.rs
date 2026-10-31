//! Port of the migration runner of `src/server/world-model/db.ts:130-202`.
//!
//! `docs/RUST_MIGRATION.md:71-73` fixes two properties that this module keeps:
//!
//! * the 19 `.sql` files stay where they are (`src/server/world-model/migrations`)
//!   and are applied by Rust with the same advisory-lock procedure, so there is
//!   no second copy that could drift;
//! * the bookkeeping table is `_world_model_migrations` with the same `id`
//!   values (the file name without `.sql`) and the same `applied_at` column.
//!
//! The directory is resolved like `db.ts:138` — `path.join(process.cwd(), 'src',
//! 'server', 'world-model', 'migrations')` — and can be pointed elsewhere with
//! `WORLD_MODEL_MIGRATIONS_DIR` for tests and for a container whose working
//! directory is not the repository root.

use std::path::{Path, PathBuf};

use crate::world_model::db::{
    PgError, PgExecutor, PgSession, PgStatement, PgValue, SQL_BEGIN, SQL_COMMIT, SQL_ROLLBACK,
};
use crate::world_model::driver::{PgPoolSettings, SqlxPgExecutor};

/// `CREATE TABLE IF NOT EXISTS _world_model_migrations …` (`db.ts:131-136`).
pub const MIGRATIONS_TABLE_SQL: &str = "
    CREATE TABLE IF NOT EXISTS _world_model_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  ";

/// `SELECT pg_advisory_lock(hashtext($1))` (`db.ts:184-186`).
pub const ADVISORY_LOCK_SQL: &str = "SELECT pg_advisory_lock(hashtext($1))";
/// `SELECT pg_advisory_unlock(hashtext($1))` (`db.ts:190-192`).
pub const ADVISORY_UNLOCK_SQL: &str = "SELECT pg_advisory_unlock(hashtext($1))";

/// The lock name of `db.ts:185`. Both implementations must use the same string,
/// otherwise they do not exclude each other during a rollout.
pub const ADVISORY_LOCK_KEY: &str = "clawtest:world-model:migrations";

/// `WORLD_MODEL_ADMIN_DATABASE_URL` (`db.ts:169`).
pub const ADMIN_DATABASE_URL_ENV: &str = "WORLD_MODEL_ADMIN_DATABASE_URL";
/// The override for the migration directory (see the module header).
pub const MIGRATIONS_DIR_ENV: &str = "WORLD_MODEL_MIGRATIONS_DIR";

/// Everything `runWorldModelMigrations` reads from the process environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationSettings {
    /// `WORLD_MODEL_ADMIN_DATABASE_URL` — `None` means "reuse the app pool".
    pub admin_database_url: Option<String>,
    pub migrations_dir: String,
}

impl MigrationSettings {
    /// The default resolution of `db.ts:138`.
    pub fn default_migrations_dir() -> String {
        std::env::current_dir()
            .map(|cwd| cwd.join("src/server/world-model/migrations"))
            .unwrap_or_else(|_| PathBuf::from("src/server/world-model/migrations"))
            .to_string_lossy()
            .into_owned()
    }

    pub fn from_env() -> Self {
        Self {
            admin_database_url: std::env::var(ADMIN_DATABASE_URL_ENV)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            migrations_dir: std::env::var(MIGRATIONS_DIR_ENV)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(Self::default_migrations_dir),
        }
    }

    pub fn with_migrations_dir(dir: impl Into<String>) -> Self {
        Self {
            admin_database_url: None,
            migrations_dir: dir.into(),
        }
    }
}

/// The failure of `db.ts:176-181`: the canonical database is not reachable.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("[world-model:db] canonical PostgreSQL is not reachable at {database_url}")]
pub struct UnreachableCanonicalDatabase {
    pub database_url: String,
}

/// `isConnectionUsable(pool)` (`db.ts:121-128`).
pub async fn is_connection_usable(executor: &dyn PgExecutor) -> bool {
    executor.query(PgStatement::new("SELECT 1")).await.is_ok()
}

/// The `.sql` files of a directory, sorted by file name — `db.ts:139-142`.
pub fn migration_files(dir: &Path) -> Result<Vec<(String, PathBuf)>, PgError> {
    let entries = std::fs::read_dir(dir)
        .map_err(|error| PgError::new(format!("cannot read {}: {error}", dir.display())))?;
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| PgError::new(format!("{error}")))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".sql") {
            continue;
        }
        files.push((name.trim_end_matches(".sql").to_string(), path));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

/// `applyMigrations(client)` (`db.ts:130-166`).
///
/// Returns the ids that were applied in this call, in file order.
pub async fn apply_migrations(session: &dyn PgSession, dir: &Path) -> Result<Vec<String>, PgError> {
    session
        .query(PgStatement::new(MIGRATIONS_TABLE_SQL))
        .await
        .map(|_| ())?;

    let mut applied = Vec::new();
    for (id, path) in migration_files(dir)? {
        let existing = session
            .query(PgStatement::with_params(
                "SELECT 1 FROM _world_model_migrations WHERE id = $1",
                vec![PgValue::text(id.as_str())],
            ))
            .await?;
        if existing.row_count > 0 {
            continue;
        }
        let sql = std::fs::read_to_string(&path)
            .map_err(|error| PgError::new(format!("cannot read {}: {error}", path.display())))?;
        session.query(PgStatement::new(SQL_BEGIN)).await?;
        match apply_one(session, &sql, &id).await {
            Ok(()) => applied.push(id),
            Err(error) => {
                let _ = session.query(PgStatement::new(SQL_ROLLBACK)).await;
                return Err(error);
            }
        }
    }
    Ok(applied)
}

/// The `try` block of `db.ts:154-163`: the file, its bookkeeping row, `COMMIT`.
async fn apply_one(session: &dyn PgSession, sql: &str, id: &str) -> Result<(), PgError> {
    session.query(PgStatement::new(sql)).await?;
    session
        .query(PgStatement::with_params(
            "INSERT INTO _world_model_migrations (id) VALUES ($1)",
            vec![PgValue::text(id)],
        ))
        .await?;
    session.query(PgStatement::new(SQL_COMMIT)).await?;
    Ok(())
}

/// `runWorldModelMigrations()` (`db.ts:168-202`).
///
/// The advisory lock is taken and released around [`apply_migrations`], exactly
/// like the `pg_advisory_lock`/`pg_advisory_unlock` pair of the source. The
/// caller supplies the connection, because the admin pool and the app pool are
/// owned by [`driver`](crate::world_model::driver) in the port.
pub async fn run_world_model_migrations(
    executor: &dyn PgExecutor,
    settings: &MigrationSettings,
) -> Result<Vec<String>, PgError> {
    if !is_connection_usable(executor).await {
        return Err(PgError::new(
            UnreachableCanonicalDatabase {
                database_url: settings
                    .admin_database_url
                    .clone()
                    .unwrap_or_else(|| "<the configured world-model pool>".to_string()),
            }
            .to_string(),
        ));
    }

    let session = executor.connect().await?;
    let outcome = locked_migrations(session.as_ref(), settings).await;
    // `finally { try { await client.query('SELECT pg_advisory_unlock…') } finally
    // { client.release() } }` (`db.ts:188-195`).
    let _ = session
        .query(PgStatement::with_params(
            ADVISORY_UNLOCK_SQL,
            vec![PgValue::text(ADVISORY_LOCK_KEY)],
        ))
        .await;
    session.release();
    outcome
}

/// `runWorldModelMigrations` (`db.ts:168-201`) as the dispatcher calls it. With an admin
/// URL the run gets its own small pool (`max: 2`, idle 5 s), closed afterwards, because the
/// app and worker roles may not create tables. Without one the app pool runs it.
pub async fn run_world_model_migrations_with_admin_pool(
    app: &dyn PgExecutor,
    settings: &MigrationSettings,
) -> Result<Vec<String>, PgError> {
    let Some(admin_url) = settings
        .admin_database_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
    else {
        return run_world_model_migrations(app, settings).await;
    };
    let pool = PgPoolSettings {
        database_url: admin_url.to_string(),
        pool_max: 2,
        pool_idle_timeout_ms: 5_000,
    };
    let admin = SqlxPgExecutor::connect(&pool).await.map_err(|_| {
        PgError::new(
            UnreachableCanonicalDatabase {
                database_url: admin_url.to_string(),
            }
            .to_string(),
        )
    })?;
    let outcome = run_world_model_migrations(&admin, settings).await;
    admin.close().await;
    outcome
}

async fn locked_migrations(
    session: &dyn PgSession,
    settings: &MigrationSettings,
) -> Result<Vec<String>, PgError> {
    session
        .query(PgStatement::with_params(
            ADVISORY_LOCK_SQL,
            vec![PgValue::text(ADVISORY_LOCK_KEY)],
        ))
        .await?;
    apply_migrations(session, Path::new(&settings.migrations_dir)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult};

    /// A temporary migration directory with the given files.
    struct TempMigrations {
        dir: PathBuf,
    }

    impl TempMigrations {
        fn new(files: &[(&str, &str)]) -> Self {
            let dir = std::env::temp_dir().join(format!("wm-migrations-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            for (name, contents) in files {
                std::fs::write(dir.join(name), contents).expect("fixture file");
            }
            Self { dir }
        }
    }

    impl Drop for TempMigrations {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn sqls(executor: &RecordingExecutor) -> Vec<String> {
        executor
            .calls()
            .iter()
            .map(|call| call.sql().to_string())
            .collect()
    }

    fn statement_param(executor: &RecordingExecutor, index: usize) -> Option<PgValue> {
        match executor.calls().get(index) {
            Some(Recorded::Statement(statement)) => statement.params.first().cloned(),
            _ => None,
        }
    }

    #[test]
    fn files_are_sorted_by_id_and_only_sql_is_read() {
        let fixtures = TempMigrations::new(&[
            ("003_c.sql", "SELECT 3;"),
            ("001_a.sql", "SELECT 1;"),
            ("README.md", "not a migration"),
            ("002_b.sql", "SELECT 2;"),
        ]);
        let files = migration_files(&fixtures.dir).expect("list");
        let ids: Vec<String> = files.into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, vec!["001_a", "002_b", "003_c"]);
    }

    #[test]
    fn an_applied_file_is_skipped_and_a_new_one_gets_its_own_transaction() {
        let fixtures = TempMigrations::new(&[
            ("001_a.sql", "CREATE TABLE a (id TEXT);"),
            ("002_b.sql", "CREATE TABLE b (id TEXT);"),
        ]);
        let executor = RecordingExecutor::new(vec![
            // The bookkeeping table.
            Ok(PgQueryResult::empty()),
            // `001_a` is already recorded.
            Ok(PgQueryResult::affected(1)),
            // The existence check of `002_b` finds nothing.
            Ok(PgQueryResult::empty()),
        ]);
        let session = drive_sync(executor.connect())
            .expect("bridge")
            .expect("connect");
        let applied = drive_sync(apply_migrations(session.as_ref(), &fixtures.dir))
            .expect("bridge")
            .expect("migrate");
        assert_eq!(applied, vec!["002_b".to_string()]);
        assert_eq!(
            sqls(&executor),
            vec![
                MIGRATIONS_TABLE_SQL.to_string(),
                "SELECT 1 FROM _world_model_migrations WHERE id = $1".to_string(),
                "SELECT 1 FROM _world_model_migrations WHERE id = $1".to_string(),
                "BEGIN".to_string(),
                "CREATE TABLE b (id TEXT);".to_string(),
                "INSERT INTO _world_model_migrations (id) VALUES ($1)".to_string(),
                "COMMIT".to_string(),
            ]
        );
    }

    #[test]
    fn the_bookkeeping_insert_carries_the_file_id() {
        let fixtures = TempMigrations::new(&[("019_worker.sql", "SELECT 1;")]);
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::empty()), Ok(PgQueryResult::empty())]);
        let session = drive_sync(executor.connect())
            .expect("bridge")
            .expect("connect");
        drive_sync(apply_migrations(session.as_ref(), &fixtures.dir))
            .expect("bridge")
            .expect("migrate");
        let insert = executor
            .calls()
            .into_iter()
            .find(|call| match call {
                Recorded::Statement(statement) => statement.sql.starts_with("INSERT INTO"),
                Recorded::Release => false,
            })
            .expect("the insert");
        match insert {
            Recorded::Statement(statement) => {
                assert_eq!(statement.params, vec![PgValue::text("019_worker")]);
            }
            Recorded::Release => unreachable!(),
        }
    }

    #[test]
    fn a_failing_migration_rolls_back_and_stops() {
        let fixtures =
            TempMigrations::new(&[("001_a.sql", "SELECT 1;"), ("002_b.sql", "SELECT 2;")]);
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::empty()),
            Err(PgError::new("syntax error")),
        ]);
        let session = drive_sync(executor.connect())
            .expect("bridge")
            .expect("connect");
        let error = drive_sync(apply_migrations(session.as_ref(), &fixtures.dir))
            .expect("bridge")
            .expect_err("fails");
        assert_eq!(error, PgError::new("syntax error"));
        let recorded = sqls(&executor);
        assert!(recorded.contains(&"ROLLBACK".to_string()));
        assert!(
            !recorded.iter().any(|sql| sql == "SELECT 2;"),
            "the second migration must not run: {recorded:?}"
        );
    }

    #[test]
    fn the_runner_takes_the_advisory_lock_and_releases_the_session() {
        let fixtures = TempMigrations::new(&[("001_a.sql", "SELECT 1;")]);
        let executor = RecordingExecutor::new(vec![
            // isConnectionUsable
            Ok(PgQueryResult::empty()),
            // the lock
            Ok(PgQueryResult::empty()),
            // the bookkeeping table
            Ok(PgQueryResult::empty()),
            // the existence check of `001_a`
            Ok(PgQueryResult::empty()),
        ]);
        let settings = MigrationSettings::with_migrations_dir(fixtures.dir.to_string_lossy());
        let applied = drive_sync(run_world_model_migrations(&executor, &settings))
            .expect("bridge")
            .expect("run");
        assert_eq!(applied, vec!["001_a".to_string()]);
        let recorded = sqls(&executor);
        assert_eq!(
            recorded[0], "SELECT 1",
            "the reachability probe comes first"
        );
        assert_eq!(recorded[1], ADVISORY_LOCK_SQL);
        assert_eq!(
            statement_param(&executor, 1),
            Some(PgValue::text(ADVISORY_LOCK_KEY))
        );
        assert!(
            recorded.iter().any(|sql| sql == ADVISORY_UNLOCK_SQL),
            "the advisory lock is released: {recorded:?}"
        );
        assert_eq!(
            executor.calls().last(),
            Some(&Recorded::Release),
            "the session is released after the unlock"
        );
    }

    #[test]
    fn an_unreachable_database_reports_the_admin_url() {
        let executor = RecordingExecutor::new(vec![Err(PgError::new("connection refused"))]);
        let settings = MigrationSettings {
            admin_database_url: Some("postgres://admin".to_string()),
            migrations_dir: "unused".to_string(),
        };
        let error = drive_sync(run_world_model_migrations(&executor, &settings))
            .expect("bridge")
            .expect_err("fails");
        assert!(
            error.message.contains("postgres://admin"),
            "the message names the admin URL: {}",
            error.message
        );
        assert!(error.message.contains("is not reachable"));
    }

    #[test]
    fn an_admin_url_runs_on_its_own_pool_and_leaves_the_app_pool_alone() {
        let executor = RecordingExecutor::new(vec![]);
        let settings = MigrationSettings {
            admin_database_url: Some("not a postgres url".to_string()),
            migrations_dir: "unused".to_string(),
        };
        let error = drive_sync(run_world_model_migrations_with_admin_pool(
            &executor, &settings,
        ))
        .expect("bridge")
        .expect_err("the admin pool cannot open");
        assert!(
            error.message.contains("is not reachable"),
            "{}",
            error.message
        );
        assert!(executor.calls().is_empty(), "the app pool is not used");
    }

    #[test]
    fn settings_can_be_pointed_at_a_directory() {
        let settings = MigrationSettings::with_migrations_dir("/tmp/migrations");
        assert_eq!(settings.migrations_dir, "/tmp/migrations");
        assert_eq!(settings.admin_database_url, None);
    }

    #[test]
    fn the_advisory_lock_key_is_the_shared_one() {
        assert_eq!(ADVISORY_LOCK_KEY, "clawtest:world-model:migrations");
        assert!(MIGRATIONS_TABLE_SQL.contains("_world_model_migrations"));
        assert!(MIGRATIONS_TABLE_SQL.contains("applied_at TIMESTAMPTZ"));
    }
}
