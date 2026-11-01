//! Port of `scripts/world-model-provision-roles.ts`.
//!
//! Creates or updates the two dedicated runtime roles of the World Model,
//! `world_model_app` (the web and gateway process) and `world_model_worker` (the
//! scheduler), and grants them their tables. The command is read-only unless
//! `--apply` is given: without it, it reports the database name, the number of
//! World-Model tables and the state of both roles, and changes nothing.
//!
//! What must not drift from the TypeScript:
//!
//! * the role names, the passwords from `WORLD_MODEL_APP_ROLE_PASSWORD` and
//!   `WORLD_MODEL_WORKER_ROLE_PASSWORD` (trimmed; they must differ), and the role
//!   settings `statement_timeout = 15000ms` and
//!   `idle_in_transaction_session_timeout = 30000ms`;
//! * the table lists and privileges. Both roles get `SELECT, INSERT, UPDATE,
//!   DELETE` on their tables. `world_model_outbox_events` is the exception: the app
//!   role keeps DELETE for the persona privacy lifecycle, the worker gets
//!   `SELECT, INSERT, UPDATE`. A table that does not exist yet is skipped;
//! * one transaction for both roles, so a failure leaves no half-provisioned state;
//! * the passwords are quoted as SQL literals (`''` doubling) and never printed.
//!
//! One difference from the TypeScript is deliberate. OP-18 (decided by the
//! user): the application role gets `SELECT` on the migration ledger
//! (`_world_model_migrations`). The TypeScript branch that granted it never ran,
//! because `existingTables` did not ask for the ledger; the port checks the ledger on
//! its own and grants it to `world_model_app` only, so the health check of the gateway
//! can read the applied migrations. The TypeScript branch would have granted both
//! roles; the worker gets no grant here, which is the one grant that differs.
//!
//! The command loads `.env.local` in the TypeScript. The Rust `migrate` subcommand
//! reads only the process environment, which Compose provides.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::Value;

use crate::world_model::db::{
    PgError, PgExecutor, PgQueryResult, PgRow, PgSession, PgStatement, PgValue, SQL_BEGIN,
    SQL_COMMIT, SQL_ROLLBACK,
};

/// `APP_ROLE` (`world-model-provision-roles.ts:27`).
pub const APP_ROLE: &str = "world_model_app";
/// `WORKER_ROLE` (`world-model-provision-roles.ts:28`).
pub const WORKER_ROLE: &str = "world_model_worker";
/// The app password variable, as in `requireApplySecret` (`:85-89`, `:202`).
pub const APP_ROLE_PASSWORD_ENV: &str = "WORLD_MODEL_APP_ROLE_PASSWORD";
/// The worker password variable (`:203`).
pub const WORKER_ROLE_PASSWORD_ENV: &str = "WORLD_MODEL_WORKER_ROLE_PASSWORD";

/// `APP_TABLES` (`:30-48`).
const APP_TABLES: [&str; 17] = [
    "world_model_observations",
    "world_model_entities",
    "world_model_entity_relations",
    "world_model_assertions",
    "world_model_events",
    "world_model_event_transitions",
    "world_model_tasks",
    "world_model_task_transitions",
    "world_model_action_attempts",
    "world_model_open_loops",
    "world_model_standing_intents",
    "world_model_embeddings",
    "world_model_ingestion_checkpoints",
    "world_model_projection_pending",
    "world_model_delivery_receipts",
    "world_model_rebuild_checkpoints",
    "world_model_graphiti_shadow",
];

/// The tables the worker adds to `APP_TABLES` (`WORKER_TABLES`, `:50-66`). Four
/// names repeat entries of `APP_TABLES`; the grants are idempotent, so the list is
/// kept as written.
const WORKER_EXTRA_TABLES: [&str; 7] = [
    "world_model_memory_items",
    "world_model_memory_item_history",
    "world_model_outbox_events",
    "world_model_projection_pending",
    "world_model_delivery_receipts",
    "world_model_rebuild_checkpoints",
    "world_model_graphiti_shadow",
];

/// The outbox is written by both roles; only the app role may delete from it.
const OUTBOX_TABLE: &str = "world_model_outbox_events";

/// The migration ledger. The application role reads it for the health check of the
/// gateway (`families/ops_wire/world_model_port.rs`, `SQL_MIGRATIONS`). OP-18: decided
/// by the user, so the grant deliberately differs from the TypeScript original, which
/// only ever checked the World-Model tables and never granted it.
pub const LEDGER_TABLE: &str = "_world_model_migrations";

const STATEMENT_TIMEOUT: &str = "15000ms";
const IDLE_IN_TRANSACTION_TIMEOUT: &str = "30000ms";

/// `requireApplySecret` (`:85-89`) reads both passwords. An empty or blank value is
/// missing. The struct has no `Debug` derive, so a password cannot end up in a log
/// line by accident.
#[derive(Clone, Default)]
pub struct RolePasswords {
    pub app: Option<String>,
    pub worker: Option<String>,
}

impl RolePasswords {
    pub fn from_env(env: &HashMap<String, String>) -> Self {
        let read = |name: &str| {
            env.get(name)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Self {
            app: read(APP_ROLE_PASSWORD_ENV),
            worker: read(WORKER_ROLE_PASSWORD_ENV),
        }
    }
}

/// The failures of the command. The messages are the TypeScript's `Error` messages.
#[derive(Debug, thiserror::Error)]
pub enum RoleProvisioningError {
    /// `WORLD_MODEL_ADMIN_DATABASE_URL is required with --apply.` (`:201`).
    #[error("WORLD_MODEL_ADMIN_DATABASE_URL is required with --apply.")]
    MissingAdminUrl,
    /// `${name} is required with --apply.` (`:86-88`).
    #[error("{0} is required with --apply.")]
    MissingPassword(&'static str),
    /// `App and worker role passwords must be different.` (`:208`).
    #[error("App and worker role passwords must be different.")]
    SamePasswords,
    #[error(transparent)]
    Database(#[from] PgError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RoleState {
    rolname: String,
    rolcanlogin: bool,
}

/// `quoteIdentifier` (`:76-78`).
pub fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// `quoteLiteral` (`:80-82`).
pub fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// `scripts/world-model-provision-roles.ts` `main()`.
///
/// `admin` is the connection of `WORLD_MODEL_ADMIN_DATABASE_URL`, `None` when it is
/// not set. `report` receives the lines the script prints, in order, also when the
/// command fails later, so the caller can print what was inspected before an error.
pub async fn provision_roles(
    admin: Option<&dyn PgExecutor>,
    passwords: &RolePasswords,
    apply: bool,
    report: &mut Vec<String>,
) -> Result<(), RoleProvisioningError> {
    let Some(admin) = admin else {
        if apply {
            return Err(RoleProvisioningError::MissingAdminUrl);
        }
        report.push(
            "DRY RUN: set WORLD_MODEL_ADMIN_DATABASE_URL to inspect the target database."
                .to_string(),
        );
        return Ok(());
    };

    let session = admin.connect().await?;
    let outcome = inspect_and_apply(session.as_ref(), passwords, apply, report).await;
    session.release();
    outcome
}

async fn inspect_and_apply(
    session: &dyn PgSession,
    passwords: &RolePasswords,
    apply: bool,
    report: &mut Vec<String>,
) -> Result<(), RoleProvisioningError> {
    let database = current_database(session).await?;
    let roles = load_role_state(session).await?;
    let tables = existing_tables(session).await?;
    report.push(format!("Database: {database}"));
    report.push(format!("Existing World-Model tables: {}", tables.len()));
    report.push(format!("Roles: {}", role_summary(&roles)));

    if !apply {
        report.push("DRY RUN: no roles, passwords, grants, or role settings were changed.".into());
        return Ok(());
    }

    let app_password = passwords
        .app
        .as_deref()
        .ok_or(RoleProvisioningError::MissingPassword(
            APP_ROLE_PASSWORD_ENV,
        ))?;
    let worker_password =
        passwords
            .worker
            .as_deref()
            .ok_or(RoleProvisioningError::MissingPassword(
                WORKER_ROLE_PASSWORD_ENV,
            ))?;
    if app_password == worker_password {
        return Err(RoleProvisioningError::SamePasswords);
    }

    session.query(PgStatement::new(SQL_BEGIN)).await?;
    let provisioned: Result<(), PgError> = async {
        provision_role(session, APP_ROLE, app_password, &app_grant_tables()).await?;
        provision_role(
            session,
            WORKER_ROLE,
            worker_password,
            &worker_grant_tables(),
        )
        .await
    }
    .await;
    match provisioned {
        Ok(()) => {
            session.query(PgStatement::new(SQL_COMMIT)).await?;
        }
        Err(error) => {
            // A failing rollback must not hide the original error.
            let _ = session.query(PgStatement::new(SQL_ROLLBACK)).await;
            return Err(error.into());
        }
    }

    report.push(
        "APPLIED: dedicated World-Model roles are login-enabled and granted only existing World-Model tables."
            .into(),
    );
    report.push(
        "Next: set WORLD_MODEL_APP_DATABASE_URL and WORLD_MODEL_WORKER_DATABASE_URL, then run a scoped canary."
            .into(),
    );
    Ok(())
}

/// `provisionRole` (`:92-133`).
async fn provision_role(
    session: &dyn PgSession,
    role: &str,
    password: &str,
    tables: &[&str],
) -> Result<(), PgError> {
    let quoted_role = quote_identifier(role);
    let roles = load_role_state(session).await?;
    let exists = roles.iter().any(|entry| entry.rolname == role);
    let verb = if exists { "ALTER" } else { "CREATE" };
    exec(
        session,
        format!(
            "{verb} ROLE {quoted_role} LOGIN PASSWORD {}",
            quote_literal(password)
        ),
    )
    .await?;
    exec(
        session,
        format!(
            "ALTER ROLE {quoted_role} SET statement_timeout = {}",
            quote_literal(STATEMENT_TIMEOUT)
        ),
    )
    .await?;
    exec(
        session,
        format!(
            "ALTER ROLE {quoted_role} SET idle_in_transaction_session_timeout = {}",
            quote_literal(IDLE_IN_TRANSACTION_TIMEOUT)
        ),
    )
    .await?;

    let database = current_database(session).await?;
    exec(
        session,
        format!(
            "GRANT CONNECT ON DATABASE {} TO {quoted_role}",
            quote_identifier(&database)
        ),
    )
    .await?;
    exec(
        session,
        format!("GRANT USAGE ON SCHEMA public TO {quoted_role}"),
    )
    .await?;

    let available = existing_tables(session).await?;
    if role == APP_ROLE && ledger_exists(session).await? {
        exec(
            session,
            format!(
                "GRANT SELECT ON TABLE public.{} TO {quoted_role}",
                quote_identifier(LEDGER_TABLE)
            ),
        )
        .await?;
    }
    for table in tables {
        if !available.contains(*table) {
            continue;
        }
        let privileges = if *table == OUTBOX_TABLE && role != APP_ROLE {
            "SELECT, INSERT, UPDATE"
        } else {
            "SELECT, INSERT, UPDATE, DELETE"
        };
        exec(
            session,
            format!(
                "GRANT {privileges} ON TABLE public.{} TO {quoted_role}",
                quote_identifier(table)
            ),
        )
        .await?;
    }
    Ok(())
}

/// The app role's tables: `[...APP_TABLES, 'world_model_outbox_events']` (`:186-188`).
fn app_grant_tables() -> Vec<&'static str> {
    APP_TABLES.iter().copied().chain([OUTBOX_TABLE]).collect()
}

/// The worker role's tables: `WORKER_TABLES` (`:50-66`).
fn worker_grant_tables() -> Vec<&'static str> {
    APP_TABLES
        .iter()
        .chain(WORKER_EXTRA_TABLES.iter())
        .copied()
        .collect()
}

/// `existingTables` (`:68-78`): every name of either list, without duplicates.
async fn existing_tables(session: &dyn PgSession) -> Result<HashSet<String>, PgError> {
    let names: Vec<String> = app_grant_tables()
        .into_iter()
        .chain(worker_grant_tables())
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let result = session
        .query(PgStatement::with_params(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename",
            vec![PgValue::text_array(names)],
        ))
        .await?;
    Ok(result
        .rows
        .iter()
        .filter_map(|row| row_text(row, "tablename"))
        .collect())
}

/// Whether the migration ledger exists. It is not part of [`existing_tables`], so the
/// World-Model count of the report stays as the TypeScript printed it.
async fn ledger_exists(session: &dyn PgSession) -> Result<bool, PgError> {
    let result = session
        .query(PgStatement::with_params(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
            vec![PgValue::text(LEDGER_TABLE)],
        ))
        .await?;
    Ok(!result.rows.is_empty())
}

/// `loadRoleState` (`:61-66`).
async fn load_role_state(session: &dyn PgSession) -> Result<Vec<RoleState>, PgError> {
    let result: PgQueryResult = session
        .query(PgStatement::with_params(
            "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
            vec![PgValue::text_array(vec![
                APP_ROLE.to_string(),
                WORKER_ROLE.to_string(),
            ])],
        ))
        .await?;
    Ok(result
        .rows
        .iter()
        .filter_map(|row| {
            Some(RoleState {
                rolname: row_text(row, "rolname")?,
                rolcanlogin: row.get("rolcanlogin")?.as_bool()?,
            })
        })
        .collect())
}

/// `SELECT current_database()` (`:173`, `:116`).
async fn current_database(session: &dyn PgSession) -> Result<String, PgError> {
    let result = session
        .query(PgStatement::new("SELECT current_database()"))
        .await?;
    result
        .first()
        .and_then(|row| row_text(row, "current_database"))
        .ok_or_else(|| PgError::new("SELECT current_database() returned no row"))
}

/// `Roles: world_model_app=present/login=true, world_model_worker=missing` (`:180-185`).
fn role_summary(roles: &[RoleState]) -> String {
    [APP_ROLE, WORKER_ROLE]
        .iter()
        .map(
            |role| match roles.iter().find(|entry| entry.rolname == *role) {
                Some(state) => format!("{role}=present/login={}", state.rolcanlogin),
                None => format!("{role}=missing"),
            },
        )
        .collect::<Vec<_>>()
        .join(", ")
}

async fn exec(session: &dyn PgSession, sql: String) -> Result<(), PgError> {
    session.query(PgStatement::new(sql)).await.map(|_| ())
}

fn row_text(row: &PgRow, column: &str) -> Option<String> {
    match row.get(column)? {
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use serde_json::json;

    /// An answer for a statement whose result is ignored (`CREATE`, `ALTER`, `GRANT`).
    fn done() -> Result<PgQueryResult, PgError> {
        Ok(PgQueryResult::empty())
    }

    /// The three World-Model tables used by the apply tests.
    const TABLES: [&str; 3] = [
        "world_model_observations",
        "world_model_outbox_events",
        "world_model_memory_items",
    ];

    /// The answers of one role's provisioning, in the order the statements run:
    /// roles, `CREATE`/`ALTER` (3), current database, two `GRANT`s, existing tables,
    /// then one `GRANT` per table the role may get.
    fn role_answers(
        roles: Result<PgQueryResult, PgError>,
        grants: usize,
        ledger_present: Option<bool>,
    ) -> Vec<Result<PgQueryResult, PgError>> {
        let mut answers = vec![roles, done(), done(), done()];
        answers.push(database_row("betaclaw"));
        answers.push(done());
        answers.push(done());
        answers.push(table_rows(&TABLES));
        // Only the application role checks the ledger (OP-18).
        if let Some(present) = ledger_present {
            answers.push(table_rows(if present { &[LEDGER_TABLE] } else { &[] }));
        }
        answers.extend((0..grants).map(|_| done()));
        answers
    }

    fn row(pairs: &[(&str, Value)]) -> PgRow {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect()
    }

    fn database_row(name: &str) -> Result<PgQueryResult, PgError> {
        Ok(PgQueryResult::from_rows(vec![row(&[(
            "current_database",
            json!(name),
        )])]))
    }

    fn roles_rows(roles: &[(&str, bool)]) -> Result<PgQueryResult, PgError> {
        Ok(PgQueryResult::from_rows(
            roles
                .iter()
                .map(|(name, login)| {
                    row(&[("rolname", json!(name)), ("rolcanlogin", json!(login))])
                })
                .collect(),
        ))
    }

    fn table_rows(names: &[&str]) -> Result<PgQueryResult, PgError> {
        Ok(PgQueryResult::from_rows(
            names
                .iter()
                .map(|name| row(&[("tablename", json!(name))]))
                .collect(),
        ))
    }

    fn passwords(app: Option<&str>, worker: Option<&str>) -> RolePasswords {
        RolePasswords {
            app: app.map(str::to_string),
            worker: worker.map(str::to_string),
        }
    }

    /// Every statement the session received, without the `release()` markers.
    fn statements(executor: &RecordingExecutor) -> Vec<String> {
        executor
            .calls()
            .iter()
            .filter_map(|call| match call {
                Recorded::Statement(statement) => Some(statement.sql.clone()),
                Recorded::Release => None,
            })
            .collect()
    }

    #[test]
    fn identifiers_and_literals_are_quoted_like_the_script() {
        assert_eq!(quote_identifier("world_model_app"), "\"world_model_app\"");
        assert_eq!(quote_identifier("a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_literal("o'brien"), "'o''brien'");
        assert_eq!(quote_literal("back\\slash"), "'back\\slash'");
    }

    #[test]
    fn the_table_lists_match_the_script() {
        assert_eq!(APP_TABLES.len(), 17);
        let worker = worker_grant_tables();
        assert_eq!(worker.len(), 24, "17 app tables and 7 worker extras");
        assert!(worker.contains(&"world_model_memory_items"));
        assert!(!APP_TABLES.contains(&"world_model_memory_items"));
        assert_eq!(app_grant_tables().last(), Some(&OUTBOX_TABLE));
    }

    #[test]
    fn without_an_admin_url_the_dry_run_only_says_so() {
        let mut report = Vec::new();
        drive_sync(provision_roles(
            None,
            &passwords(None, None),
            false,
            &mut report,
        ))
        .expect("bridge")
        .expect("dry run");
        assert_eq!(
            report,
            vec!["DRY RUN: set WORLD_MODEL_ADMIN_DATABASE_URL to inspect the target database."]
        );
    }

    #[test]
    fn apply_without_an_admin_url_is_refused() {
        let mut report = Vec::new();
        let error = drive_sync(provision_roles(
            None,
            &passwords(Some("a"), Some("b")),
            true,
            &mut report,
        ))
        .expect("bridge")
        .expect_err("apply needs the admin URL");
        assert_eq!(
            error.to_string(),
            "WORLD_MODEL_ADMIN_DATABASE_URL is required with --apply."
        );
    }

    #[test]
    fn the_dry_run_reports_the_state_and_changes_nothing() {
        let executor = RecordingExecutor::new(vec![
            database_row("betaclaw"),
            roles_rows(&[(APP_ROLE, true)]),
            table_rows(&["world_model_observations", "world_model_outbox_events"]),
        ]);
        let mut report = Vec::new();
        drive_sync(provision_roles(
            Some(&executor),
            &passwords(None, None),
            false,
            &mut report,
        ))
        .expect("bridge")
        .expect("dry run");
        assert_eq!(
            report,
            vec![
                "Database: betaclaw".to_string(),
                "Existing World-Model tables: 2".to_string(),
                "Roles: world_model_app=present/login=true, world_model_worker=missing".to_string(),
                "DRY RUN: no roles, passwords, grants, or role settings were changed.".to_string(),
            ]
        );
        for sql in statements(&executor) {
            assert!(sql.starts_with("SELECT"), "a dry run only reads: {sql}");
        }
    }

    #[test]
    fn apply_refuses_a_missing_password_before_it_writes() {
        let executor = RecordingExecutor::new(vec![
            database_row("betaclaw"),
            roles_rows(&[]),
            table_rows(&[]),
        ]);
        let mut report = Vec::new();
        let error = drive_sync(provision_roles(
            Some(&executor),
            &passwords(Some("app-pw"), None),
            true,
            &mut report,
        ))
        .expect("bridge")
        .expect_err("worker password missing");
        assert_eq!(
            error.to_string(),
            "WORLD_MODEL_WORKER_ROLE_PASSWORD is required with --apply."
        );
        assert!(
            !statements(&executor).iter().any(|sql| sql == SQL_BEGIN),
            "nothing is written"
        );
        assert_eq!(report.len(), 3, "the inspection is still reported");
    }

    #[test]
    fn apply_refuses_equal_passwords() {
        let executor = RecordingExecutor::new(vec![
            database_row("betaclaw"),
            roles_rows(&[]),
            table_rows(&[]),
        ]);
        let mut report = Vec::new();
        let error = drive_sync(provision_roles(
            Some(&executor),
            &passwords(Some("same"), Some("same")),
            true,
            &mut report,
        ))
        .expect("bridge")
        .expect_err("passwords must differ");
        assert_eq!(
            error.to_string(),
            "App and worker role passwords must be different."
        );
        assert!(!statements(&executor).iter().any(|sql| sql == SQL_BEGIN));
    }

    #[test]
    fn apply_creates_missing_roles_with_the_scripts_grants() {
        // The inspection (database, roles, tables), then the app role (2 grants:
        // observations and the outbox; memory items are not in its list), then the
        // worker role (3 grants). The worker's roles answer shows the app role
        // created in the same transaction.
        let mut answers = vec![
            database_row("betaclaw"),
            roles_rows(&[]),
            table_rows(&TABLES),
        ];
        answers.extend(role_answers(roles_rows(&[]), 3, Some(true)));
        answers.extend(role_answers(roles_rows(&[(APP_ROLE, true)]), 3, None));
        let executor = RecordingExecutor::new(answers);
        let mut report = Vec::new();
        drive_sync(provision_roles(
            Some(&executor),
            &passwords(Some("app-pw"), Some("worker-pw")),
            true,
            &mut report,
        ))
        .expect("bridge")
        .expect("apply");

        let sql = statements(&executor);
        let has = |expected: &str| sql.iter().any(|statement| statement == expected);
        assert_eq!(
            sql.first().map(String::as_str),
            Some("SELECT current_database()")
        );
        assert!(has(SQL_BEGIN) && has(SQL_COMMIT) && !has(SQL_ROLLBACK));
        assert!(has(
            "CREATE ROLE \"world_model_app\" LOGIN PASSWORD 'app-pw'"
        ));
        assert!(has(
            "CREATE ROLE \"world_model_worker\" LOGIN PASSWORD 'worker-pw'"
        ));
        assert!(has(
            "ALTER ROLE \"world_model_app\" SET statement_timeout = '15000ms'"
        ));
        assert!(has(
            "ALTER ROLE \"world_model_worker\" SET idle_in_transaction_session_timeout = '30000ms'"
        ));
        assert!(has(
            "GRANT CONNECT ON DATABASE \"betaclaw\" TO \"world_model_app\""
        ));
        assert!(has(
            "GRANT USAGE ON SCHEMA public TO \"world_model_worker\""
        ));
        assert!(has("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.\"world_model_observations\" TO \"world_model_app\""));
        assert!(has(
            "GRANT SELECT ON TABLE public.\"_world_model_migrations\" TO \"world_model_app\""
        ));
        assert!(
            !sql.iter()
                .any(|statement| statement.contains("_world_model_migrations")
                    && statement.contains("world_model_worker")),
            "the worker gets no ledger grant"
        );
        assert!(has("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.\"world_model_outbox_events\" TO \"world_model_app\""));
        assert!(has("GRANT SELECT, INSERT, UPDATE ON TABLE public.\"world_model_outbox_events\" TO \"world_model_worker\""));
        assert!(has("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.\"world_model_memory_items\" TO \"world_model_worker\""));
        assert!(
            !has("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.\"world_model_outbox_events\" TO \"world_model_worker\""),
            "the worker may not delete from the outbox"
        );
        assert!(
            !sql.iter()
                .any(|statement| statement.contains("world_model_memory_items")
                    && statement.contains("world_model_app")),
            "the app role gets no memory-item grant"
        );
        assert!(
            report
                .iter()
                .all(|line| !line.contains("app-pw") && !line.contains("worker-pw")),
            "passwords are never reported: {report:?}"
        );
        assert_eq!(
            report.last().map(String::as_str),
            Some("Next: set WORLD_MODEL_APP_DATABASE_URL and WORLD_MODEL_WORKER_DATABASE_URL, then run a scoped canary.")
        );
    }

    #[test]
    fn an_existing_role_is_altered_not_created() {
        let both = || roles_rows(&[(APP_ROLE, true), (WORKER_ROLE, true)]);
        let mut answers = vec![database_row("betaclaw"), both(), table_rows(&[])];
        for role_index in 0..2 {
            // roles, CREATE/ALTER (3), current database, two GRANTs, existing tables;
            // the application role also reads the ledger (OP-18), which is absent here.
            answers.extend([
                both(),
                done(),
                done(),
                done(),
                database_row("betaclaw"),
                done(),
                done(),
                table_rows(&[]),
            ]);
            if role_index == 0 {
                answers.push(table_rows(&[]));
            }
        }
        let executor = RecordingExecutor::new(answers);
        let mut report = Vec::new();
        drive_sync(provision_roles(
            Some(&executor),
            &passwords(Some("app-pw"), Some("worker-pw")),
            true,
            &mut report,
        ))
        .expect("bridge")
        .expect("apply");
        let sql = statements(&executor);
        assert!(sql
            .iter()
            .any(|s| s == "ALTER ROLE \"world_model_app\" LOGIN PASSWORD 'app-pw'"));
        assert!(!sql.iter().any(|s| s.starts_with("CREATE ROLE")));
    }

    #[test]
    fn a_failing_grant_rolls_the_whole_transaction_back() {
        // Inspection, then the app role: roles, CREATE, two role settings, and the
        // database lookup, which fails. The transaction must be rolled back.
        let executor = RecordingExecutor::new(vec![
            database_row("betaclaw"),
            roles_rows(&[]),
            table_rows(&[]),
            roles_rows(&[]),
            done(),
            done(),
            done(),
            Err(PgError::new("permission denied to create role")),
        ]);
        let mut report = Vec::new();
        let error = drive_sync(provision_roles(
            Some(&executor),
            &passwords(Some("app-pw"), Some("worker-pw")),
            true,
            &mut report,
        ))
        .expect("bridge")
        .expect_err("the CREATE fails");
        assert_eq!(error.to_string(), "permission denied to create role");
        let sql = statements(&executor);
        assert!(
            sql.iter().any(|s| s == SQL_ROLLBACK),
            "rolled back: {sql:?}"
        );
        assert!(!sql.iter().any(|s| s == SQL_COMMIT));
    }

    #[test]
    fn passwords_are_read_trimmed_and_blank_means_missing() {
        let env: HashMap<String, String> = [
            (APP_ROLE_PASSWORD_ENV.to_string(), "  app-pw \n".to_string()),
            (WORKER_ROLE_PASSWORD_ENV.to_string(), "   ".to_string()),
        ]
        .into_iter()
        .collect();
        let read = RolePasswords::from_env(&env);
        assert_eq!(read.app.as_deref(), Some("app-pw"));
        assert_eq!(read.worker, None);
    }

    /// The statements of a full apply, with the ledger present or absent (OP-18). The
    /// roles are created on the first run and altered when they already exist.
    fn full_apply_answers(
        ledger_present: bool,
        roles_exist: bool,
    ) -> Vec<Result<PgQueryResult, PgError>> {
        let roles = if roles_exist {
            roles_rows(&[(APP_ROLE, true), (WORKER_ROLE, true)])
        } else {
            roles_rows(&[])
        };
        let mut answers = vec![
            database_row("betaclaw"),
            roles_rows(&[]),
            table_rows(&TABLES),
        ];
        let app_grants = if ledger_present { 3 } else { 2 };
        answers.extend(role_answers(
            roles.clone(),
            app_grants,
            Some(ledger_present),
        ));
        answers.extend(role_answers(roles, 3, None));
        answers
    }

    fn apply_statements(answers: Vec<Result<PgQueryResult, PgError>>) -> Vec<String> {
        let executor = RecordingExecutor::new(answers);
        let mut report = Vec::new();
        drive_sync(provision_roles(
            Some(&executor),
            &passwords(Some("app-pw"), Some("worker-pw")),
            true,
            &mut report,
        ))
        .expect("bridge")
        .expect("apply");
        statements(&executor)
    }

    #[test]
    fn the_ledger_is_granted_to_the_app_role_only_when_it_exists() {
        let ledger_grant =
            "GRANT SELECT ON TABLE public.\"_world_model_migrations\" TO \"world_model_app\"";
        let with = apply_statements(full_apply_answers(true, false));
        assert!(with.iter().any(|sql| sql == ledger_grant), "{with:?}");
        assert!(!with.iter().any(
            |sql| sql.contains("_world_model_migrations") && sql.contains("world_model_worker")
        ));
        let without = apply_statements(full_apply_answers(false, false));
        assert!(!without
            .iter()
            .any(|sql| sql.starts_with("GRANT") && sql.contains("_world_model_migrations")));
    }

    #[test]
    fn provisioning_twice_issues_the_same_grants() {
        // The second run finds the roles and alters them; the grants are the same statements.
        let grants = |sql: Vec<String>| {
            sql.into_iter()
                .filter(|statement| statement.starts_with("GRANT"))
                .collect::<Vec<_>>()
        };
        let first = grants(apply_statements(full_apply_answers(true, false)));
        let second = grants(apply_statements(full_apply_answers(true, true)));
        assert!(!first.is_empty());
        assert_eq!(first, second);
    }
}
