//! Port of `scripts/world-model-verify-rls.ts`.
//!
//! Proves that the dedicated runtime roles of the World Model are login-enabled,
//! scope-enforced by RLS and least-privilege granted. The check is read-only
//! against business data: it writes and removes one clearly marked probe row per
//! run, in the scope `user-a`, and checks that the other scope cannot see it.
//!
//! The checks, their names and their details are the TypeScript's, so the output
//! of `betaclaw-scheduler verify-rls` can be compared line by line with the old
//! `pnpm run world-model:verify-rls`. The caller reads the two connection URLs
//! (`WORLD_MODEL_APP_DATABASE_URL`, `WORLD_MODEL_WORKER_DATABASE_URL`), connects
//! them and hands the executors over, in the TypeScript order: the app role is
//! verified first, and the worker URL is required only after that.
//!
//! The statements of the TypeScript run one by one on one connection each. The
//! port keeps that order, including the `COMMIT` that follows a failed read in
//! the worker check: PostgreSQL turns that `COMMIT` into a rollback without an
//! error, so the port does the same.

use serde_json::Value;

use crate::world_model::db::{
    set_database_scope, NormalizedScope, PgError, PgExecutor, PgQueryResult, PgSession,
    PgStatement, PgValue, SQL_BEGIN, SQL_COMMIT, SQL_ROLLBACK,
};

/// `APP_ROLE` of the provisioning script (`world-model-provision-roles.ts:27`).
pub const APP_ROLE: &str = "world_model_app";
/// `WORKER_ROLE` of the provisioning script (`world-model-provision-roles.ts:28`).
pub const WORKER_ROLE: &str = "world_model_worker";
/// The env variable of the app connection (`world-model-verify-rls.ts:45`).
pub const APP_DATABASE_URL_ENV: &str = "WORLD_MODEL_APP_DATABASE_URL";
/// The env variable of the worker connection (`world-model-verify-rls.ts:47`).
pub const WORKER_DATABASE_URL_ENV: &str = "WORLD_MODEL_WORKER_DATABASE_URL";

/// `SCOPE_A` of the script (`world-model-verify-rls.ts:28`).
const SCOPE_A: (&str, &str, &str) = ("rls-verify-user-a", "rls-verify-persona", "ws-a");
/// `SCOPE_B` of the script (`world-model-verify-rls.ts:29`).
const SCOPE_B: (&str, &str, &str) = ("rls-verify-user-b", "rls-verify-persona", "ws-b");

/// One line of the report (`Check` in the script, `:31-35`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RlsCheck {
    pub name: String,
    pub passed: bool,
    pub detail: String,
}

/// The probe source id of one run: `rls-verify-${Date.now()}` (`:27`).
pub fn probe_source_id(now_millis: i64) -> String {
    format!("rls-verify-{now_millis}")
}

/// The lines the script prints: one `PASS`/`FAIL` line per check, then the summary.
pub fn report_lines(checks: &[RlsCheck]) -> Vec<String> {
    let failed = checks.iter().filter(|check| !check.passed).count();
    let mut lines: Vec<String> = checks
        .iter()
        .map(|check| {
            format!(
                "{}  {}  ({})",
                if check.passed { "PASS" } else { "FAIL" },
                check.name,
                check.detail
            )
        })
        .collect();
    lines.push(format!(
        "{}/{} checks passed",
        checks.len() - failed,
        checks.len()
    ));
    lines
}

/// `true` when the script would exit with status 1 (`process.exitCode = 1`).
pub fn has_failures(checks: &[RlsCheck]) -> bool {
    checks.iter().any(|check| !check.passed)
}

fn record(checks: &mut Vec<RlsCheck>, name: &str, passed: bool, detail: impl Into<String>) {
    checks.push(RlsCheck {
        name: name.to_string(),
        passed,
        detail: detail.into(),
    });
}

/// The value of a column as the script prints it (`${who.rows[0]?.current_user}`).
/// `count(*)` and `count(*)::text` are both accepted.
fn column_text(result: &PgQueryResult, column: &str) -> Option<String> {
    match result.first()?.get(column)? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

fn scope_of(scope: (&str, &str, &str)) -> NormalizedScope {
    NormalizedScope {
        user_id: scope.0.to_string(),
        persona_id: scope.1.to_string(),
        workspace_id: scope.2.to_string(),
    }
}

/// `selectObservationIds` (`:50-56`): the probe rows of this run that are visible.
async fn visible_probe_rows(session: &dyn PgSession, probe: &str) -> Result<usize, PgError> {
    let result = session
        .query(PgStatement::with_params(
            "SELECT id FROM world_model_observations WHERE source_id = $1",
            vec![PgValue::text(probe)],
        ))
        .await?;
    Ok(result.rows.len())
}

/// The `INSERT` of the probe row (`:85-87`, `:136-138`).
fn probe_insert(source_id: &str, scope: (&str, &str, &str)) -> PgStatement {
    PgStatement::with_params(
        "INSERT INTO world_model_observations (user_id, persona_id, workspace_id, source_type, source_id, occurred_at, payload)
       VALUES ($1, $2, $3, 'automation', $4, now(), $5::jsonb)",
        vec![
            PgValue::text(scope.0),
            PgValue::text(scope.1),
            PgValue::text(scope.2),
            PgValue::text(source_id),
            PgValue::text("{}"),
        ],
    )
}

/// `verifyAppRole(url)` (`:58-155`). The checks are appended to `checks`; an error
/// of a statement propagates, as the script's `await` does.
pub async fn verify_app_role(
    executor: &dyn PgExecutor,
    probe: &str,
    checks: &mut Vec<RlsCheck>,
) -> Result<(), PgError> {
    let session = executor.connect().await?;
    let outcome = app_checks(session.as_ref(), probe, checks).await;
    if outcome.is_err() {
        // The script closes the client, which rolls back an open transaction.
        let _ = session.query(PgStatement::new(SQL_ROLLBACK)).await;
    }
    session.release();
    outcome
}

async fn app_checks(
    session: &dyn PgSession,
    probe: &str,
    checks: &mut Vec<RlsCheck>,
) -> Result<(), PgError> {
    let who = session
        .query(PgStatement::new("SELECT current_user"))
        .await?;
    let current_user = column_text(&who, "current_user").unwrap_or_else(|| "undefined".into());
    record(
        checks,
        &format!("app role connects as {APP_ROLE}"),
        current_user == APP_ROLE,
        format!("current_user={current_user}"),
    );

    // Unscoped session: RLS hides every scoped row.
    let unscoped = session
        .query(PgStatement::new(
            "SELECT count(*)::text AS count FROM world_model_observations",
        ))
        .await?;
    let visible = column_text(&unscoped, "count").unwrap_or_else(|| "undefined".into());
    record(
        checks,
        "app role without scope sees zero rows (RLS deny-all)",
        visible == "0",
        format!("visible rows={visible}"),
    );

    // Scoped session A: insert the probe row, then read it back.
    session.query(PgStatement::new(SQL_BEGIN)).await?;
    set_database_scope::<PgError>(session, &scope_of(SCOPE_A)).await?;
    session.query(probe_insert(probe, SCOPE_A)).await?;
    let in_scope_a = visible_probe_rows(session, probe).await?;
    session.query(PgStatement::new(SQL_COMMIT)).await?;
    record(
        checks,
        "app role inserts and reads row inside its scope",
        in_scope_a == 1,
        format!("rows in scope A={in_scope_a}"),
    );

    // Scoped session B: the probe row of scope A must be invisible.
    session.query(PgStatement::new(SQL_BEGIN)).await?;
    set_database_scope::<PgError>(session, &scope_of(SCOPE_B)).await?;
    let in_scope_b = visible_probe_rows(session, probe).await?;
    session.query(PgStatement::new(SQL_COMMIT)).await?;
    record(
        checks,
        "cross-scope isolation: scope B cannot see scope A row",
        in_scope_b == 0,
        format!("rows in scope B={in_scope_b}"),
    );

    // A cross-scope write must be rejected by the WITH CHECK clause.
    session.query(PgStatement::new(SQL_BEGIN)).await?;
    set_database_scope::<PgError>(session, &scope_of(SCOPE_B)).await?;
    let cross_write = session
        .query(probe_insert(&format!("{probe}-x"), SCOPE_A))
        .await;
    session.query(PgStatement::new(SQL_ROLLBACK)).await?;
    let cross_write_rejected = cross_write.is_err();
    record(
        checks,
        "cross-scope write rejected by RLS WITH CHECK",
        cross_write_rejected,
        if cross_write_rejected {
            "insert raised error"
        } else {
            "insert unexpectedly succeeded"
        },
    );

    // Cleanup of the probe row from scope A.
    session.query(PgStatement::new(SQL_BEGIN)).await?;
    set_database_scope::<PgError>(session, &scope_of(SCOPE_A)).await?;
    let deleted = session
        .query(PgStatement::with_params(
            "DELETE FROM world_model_observations WHERE source_id = $1",
            vec![PgValue::text(probe)],
        ))
        .await?;
    session.query(PgStatement::new(SQL_COMMIT)).await?;
    record(
        checks,
        "probe row cleaned up",
        deleted.row_count == 1,
        format!("deleted={}", deleted.row_count),
    );

    // OP-18: the application role reads the migration ledger for the gateway health check.
    let migrations_readable = session
        .query(PgStatement::new(
            "SELECT count(*) FROM _world_model_migrations",
        ))
        .await
        .is_ok();
    record(
        checks,
        "app role reads _world_model_migrations (health check, OP-18)",
        migrations_readable,
        if migrations_readable {
            "readable"
        } else {
            "permission denied"
        },
    );
    Ok(())
}

/// `verifyWorkerRole(url)` (`:157-214`).
pub async fn verify_worker_role(
    executor: &dyn PgExecutor,
    checks: &mut Vec<RlsCheck>,
) -> Result<(), PgError> {
    let session = executor.connect().await?;
    let outcome = worker_checks(session.as_ref(), checks).await;
    if outcome.is_err() {
        let _ = session.query(PgStatement::new(SQL_ROLLBACK)).await;
    }
    session.release();
    outcome
}

async fn worker_checks(session: &dyn PgSession, checks: &mut Vec<RlsCheck>) -> Result<(), PgError> {
    let who = session
        .query(PgStatement::new("SELECT current_user"))
        .await?;
    let current_user = column_text(&who, "current_user").unwrap_or_else(|| "undefined".into());
    record(
        checks,
        &format!("worker role connects as {WORKER_ROLE}"),
        current_user == WORKER_ROLE,
        format!("current_user={current_user}"),
    );

    // Migration 019 grants the worker the scoped domain tables: the embedding worker
    // (`embedding_worker.rs`, `collect_embedding_targets`) and the projection retry
    // (`observation_repository.rs`) read observations. RLS still limits the rows. The
    // TypeScript check predates 019 and expected "permission denied" here.
    let observations_readable = session
        .query(PgStatement::new(
            "SELECT count(*) FROM world_model_observations",
        ))
        .await
        .is_ok();
    record(
        checks,
        "worker role can read world_model_observations (019 grant, RLS scoped)",
        observations_readable,
        if observations_readable {
            "readable"
        } else {
            "permission denied"
        },
    );

    // The worker reads the outbox, its job, scoped. The COMMIT runs even after a
    // failed read, as in the script.
    session.query(PgStatement::new(SQL_BEGIN)).await?;
    set_database_scope::<PgError>(session, &scope_of(("rls-verify", "worker", ""))).await?;
    let outbox = session
        .query(PgStatement::new(
            "SELECT count(*) FROM world_model_outbox_events",
        ))
        .await;
    session.query(PgStatement::new(SQL_COMMIT)).await?;
    let (outbox_readable, outbox_detail) = match outbox {
        Ok(_) => (true, "ok".to_string()),
        Err(error) => (false, error.into_message()),
    };
    record(
        checks,
        "worker role reads world_model_outbox_events",
        outbox_readable,
        outbox_detail,
    );

    // The worker must not delete from the outbox (SELECT and UPDATE only). Any
    // failure of the block counts as "denied", as the catch of the script does.
    let delete_outcome = async {
        session.query(PgStatement::new(SQL_BEGIN)).await?;
        set_database_scope::<PgError>(session, &scope_of(("rls-verify", "worker", ""))).await?;
        session
            .query(PgStatement::new(
                "DELETE FROM world_model_outbox_events WHERE false",
            ))
            .await?;
        session.query(PgStatement::new(SQL_COMMIT)).await
    }
    .await;
    let delete_denied = match delete_outcome {
        Ok(_) => false,
        Err(_) => {
            let _ = session.query(PgStatement::new(SQL_ROLLBACK)).await;
            true
        }
    };
    record(
        checks,
        "worker role cannot delete outbox rows (SELECT/UPDATE only)",
        delete_denied,
        if delete_denied {
            "permission denied"
        } else {
            "delete unexpectedly allowed"
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use serde_json::json;

    fn row(pairs: &[(&str, Value)]) -> crate::world_model::db::PgRow {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect()
    }

    fn one_text(column: &str, value: &str) -> Result<PgQueryResult, PgError> {
        Ok(PgQueryResult::from_rows(vec![row(&[(
            column,
            json!(value),
        )])]))
    }

    fn rows(count: usize) -> Result<PgQueryResult, PgError> {
        Ok(PgQueryResult::from_rows(
            (0..count)
                .map(|index| row(&[("id", json!(format!("obs-{index}")))]))
                .collect(),
        ))
    }

    /// The answers of a healthy installation, in statement order (control
    /// statements do not consume an answer).
    fn healthy_app_answers() -> Vec<Result<PgQueryResult, PgError>> {
        // One answer per data statement: current_user, unscoped count, probe insert,
        // read in scope A, read in scope B, cross-scope insert, cleanup, migrations.
        vec![
            one_text("current_user", APP_ROLE),
            one_text("count", "0"),
            Ok(PgQueryResult::affected(1)),
            rows(1),
            rows(0),
            Err(PgError::new("new row violates row-level security policy")),
            Ok(PgQueryResult::affected(1)),
            rows(1),
        ]
    }

    fn healthy_worker_answers() -> Vec<Result<PgQueryResult, PgError>> {
        vec![
            one_text("current_user", WORKER_ROLE),
            // Observations are readable for the worker (migration 019).
            rows(1),
            rows(0),
            Err(PgError::new("permission denied for table")),
        ]
    }

    fn run(
        app: Vec<Result<PgQueryResult, PgError>>,
        worker: Vec<Result<PgQueryResult, PgError>>,
    ) -> (Vec<RlsCheck>, RecordingExecutor, RecordingExecutor) {
        let probe = probe_source_id(42);
        let app_executor = RecordingExecutor::new(app);
        let worker_executor = RecordingExecutor::new(worker);
        let mut checks = Vec::new();
        drive_sync(verify_app_role(&app_executor, &probe, &mut checks))
            .expect("bridge")
            .expect("app checks");
        drive_sync(verify_worker_role(&worker_executor, &mut checks))
            .expect("bridge")
            .expect("worker checks");
        (checks, app_executor, worker_executor)
    }

    #[test]
    fn a_healthy_installation_passes_all_eleven_checks() {
        let (checks, _, _) = run(healthy_app_answers(), healthy_worker_answers());
        assert_eq!(checks.len(), 11);
        assert!(!has_failures(&checks), "{checks:#?}");
        let lines = report_lines(&checks);
        assert_eq!(
            lines[0],
            "PASS  app role connects as world_model_app  (current_user=world_model_app)"
        );
        assert_eq!(
            lines.last().map(String::as_str),
            Some("11/11 checks passed")
        );
    }

    #[test]
    fn a_cross_scope_write_that_succeeds_is_a_failure() {
        let mut app = healthy_app_answers();
        app[5] = Ok(PgQueryResult::affected(1));
        let (checks, _, _) = run(app, healthy_worker_answers());
        let line = checks
            .iter()
            .find(|check| check.name.starts_with("cross-scope write"))
            .expect("check");
        assert!(!line.passed);
        assert_eq!(line.detail, "insert unexpectedly succeeded");
        assert!(has_failures(&checks));
        assert_eq!(
            report_lines(&checks).last().map(String::as_str),
            Some("10/11 checks passed")
        );
    }

    #[test]
    fn the_app_role_must_be_the_app_role() {
        let mut app = healthy_app_answers();
        app[0] = one_text("current_user", "postgres");
        let (checks, _, _) = run(app, healthy_worker_answers());
        assert!(!checks[0].passed);
        assert_eq!(checks[0].detail, "current_user=postgres");
    }

    #[test]
    fn a_missing_probe_cleanup_is_reported_with_the_row_count() {
        let mut app = healthy_app_answers();
        app[6] = Ok(PgQueryResult::affected(0));
        let (checks, _, _) = run(app, healthy_worker_answers());
        let cleanup = checks
            .iter()
            .find(|c| c.name == "probe row cleaned up")
            .expect("check");
        assert!(!cleanup.passed);
        assert_eq!(cleanup.detail, "deleted=0");
    }

    #[test]
    fn the_outbox_read_error_text_is_the_detail() {
        let mut worker = healthy_worker_answers();
        worker[2] = Err(PgError::new("relation does not exist"));
        let (checks, _, _) = run(healthy_app_answers(), worker);
        let outbox = checks
            .iter()
            .find(|check| check.name == "worker role reads world_model_outbox_events")
            .expect("check");
        assert!(!outbox.passed);
        assert_eq!(outbox.detail, "relation does not exist");
    }

    #[test]
    fn the_probe_statements_run_in_the_order_of_the_script() {
        let (_, app, _) = run(healthy_app_answers(), healthy_worker_answers());
        let sql: Vec<String> = app
            .calls()
            .iter()
            .filter_map(|call| match call {
                Recorded::Statement(statement) => Some(statement.sql.clone()),
                Recorded::Release => None,
            })
            .collect();
        assert_eq!(sql.first().map(String::as_str), Some("SELECT current_user"));
        // Four scoped blocks on the app connection: insert, read B, cross write, cleanup.
        assert_eq!(sql.iter().filter(|s| s.as_str() == SQL_BEGIN).count(), 4);
        assert_eq!(sql.iter().filter(|s| s.as_str() == SQL_COMMIT).count(), 3);
        assert_eq!(sql.iter().filter(|s| s.as_str() == SQL_ROLLBACK).count(), 1);
        assert!(
            sql.last().map(String::as_str) == Some("SELECT count(*) FROM _world_model_migrations")
        );
        assert!(matches!(app.calls().last(), Some(Recorded::Release)));
    }

    #[test]
    fn the_probe_id_follows_the_script_format() {
        assert_eq!(
            probe_source_id(1_700_000_000_000),
            "rls-verify-1700000000000"
        );
    }
}
