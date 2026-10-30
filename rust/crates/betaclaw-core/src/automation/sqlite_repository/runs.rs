//! Port of `src/server/automation/sqlite-automation-repository/runs.ts`.
//!
//! Run and dead-letter rows. `createOrGetRun` relies on `ON CONFLICT(run_key) DO NOTHING`,
//! so one scheduled occurrence creates exactly one run.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::automation::row_mappers::{to_dead_letter, to_run};
use crate::automation::types::{
    AutomationDeadLetter, AutomationRun, AutomationRunStatus, CreateAutomationRunInput,
};
use crate::stats::util::now_iso;

pub fn create_or_get_run(
    connection: &Connection,
    input: &CreateAutomationRunInput,
) -> rusqlite::Result<AutomationRun> {
    let now = now_iso();
    let id = Uuid::new_v4().to_string();
    let next_attempt_at = input
        .next_attempt_at
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| now.clone());

    connection.execute(
        "INSERT INTO automation_runs (
            id, rule_id, user_id, trigger_source, scheduled_for,
            run_key, status, attempt, next_attempt_at,
            error_message, result_summary, started_at, finished_at, created_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?8, NULL, NULL, NULL, NULL, ?9)
         ON CONFLICT(run_key) DO NOTHING",
        params![
            id,
            input.rule_id,
            input.user_id,
            input.trigger_source.as_str(),
            input.scheduled_for,
            input.run_key,
            input.attempt,
            next_attempt_at,
            now,
        ],
    )?;

    connection.query_row(
        "SELECT * FROM automation_runs WHERE run_key = ?1",
        params![input.run_key],
        to_run,
    )
}

pub fn get_run(connection: &Connection, run_id: &str) -> rusqlite::Result<Option<AutomationRun>> {
    connection
        .query_row(
            "SELECT * FROM automation_runs WHERE id = ?1",
            params![run_id],
            to_run,
        )
        .optional()
}

pub fn list_runs(
    connection: &Connection,
    rule_id: &str,
    user_id: &str,
    limit: i64,
) -> rusqlite::Result<Vec<AutomationRun>> {
    let mut statement = connection.prepare(
        "SELECT *
         FROM automation_runs
         WHERE rule_id = ?1 AND user_id = ?2
         ORDER BY created_at DESC
         LIMIT ?3",
    )?;
    let rows = statement.query_map(params![rule_id, user_id, limit], to_run)?;
    rows.collect()
}

pub fn list_queued_runs_due(
    connection: &Connection,
    now_iso: &str,
    limit: i64,
) -> rusqlite::Result<Vec<AutomationRun>> {
    let mut statement = connection.prepare(
        "SELECT *
         FROM automation_runs
         WHERE status = 'queued'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
         ORDER BY created_at ASC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![now_iso, limit], to_run)?;
    rows.collect()
}

pub fn mark_run_running(
    connection: &Connection,
    run_id: &str,
    started_at: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE automation_runs
         SET status = 'running', started_at = ?1, error_message = NULL
         WHERE id = ?2",
        params![started_at, run_id],
    )?;
    Ok(())
}

pub fn mark_run_succeeded(
    connection: &Connection,
    run_id: &str,
    finished_at: &str,
    summary: Option<&str>,
) -> rusqlite::Result<()> {
    let summary = summary.filter(|text| !text.is_empty());
    connection.execute(
        "UPDATE automation_runs
         SET status = 'succeeded', finished_at = ?1, result_summary = ?2, error_message = NULL
         WHERE id = ?3",
        params![finished_at, summary, run_id],
    )?;
    Ok(())
}

pub fn mark_run_for_retry(
    connection: &Connection,
    run_id: &str,
    attempt: i64,
    error_message: &str,
    next_attempt_at: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE automation_runs
         SET status = 'queued', attempt = ?1, error_message = ?2, next_attempt_at = ?3, finished_at = NULL
         WHERE id = ?4",
        params![attempt, error_message, next_attempt_at, run_id],
    )?;
    Ok(())
}

pub fn mark_run_dead_letter(
    connection: &Connection,
    run_id: &str,
    error_message: &str,
    finished_at: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE automation_runs
         SET status = 'dead_letter', error_message = ?1, finished_at = ?2
         WHERE id = ?3",
        params![error_message, finished_at, run_id],
    )?;
    Ok(())
}

pub fn record_dead_letter(
    connection: &Connection,
    run_id: &str,
    rule_id: &str,
    reason: &str,
    payload: Option<&str>,
) -> rusqlite::Result<AutomationDeadLetter> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let payload = payload.filter(|text| !text.is_empty());
    connection.execute(
        "INSERT INTO automation_dead_letters (id, run_id, rule_id, reason, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, run_id, rule_id, reason, payload, now],
    )?;
    connection.query_row(
        "SELECT * FROM automation_dead_letters WHERE id = ?1",
        params![id],
        to_dead_letter,
    )
}

pub fn count_active_rules(connection: &Connection) -> rusqlite::Result<i64> {
    connection.query_row(
        "SELECT COUNT(*) FROM automation_rules WHERE enabled = 1",
        [],
        |row| row.get(0),
    )
}

pub fn count_runs_by_status(
    connection: &Connection,
    status: AutomationRunStatus,
) -> rusqlite::Result<i64> {
    connection.query_row(
        "SELECT COUNT(*) FROM automation_runs WHERE status = ?1",
        params![status.as_str()],
        |row| row.get(0),
    )
}
