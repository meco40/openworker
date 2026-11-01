//! `betaclaw-scheduler reconcile` replaces `pnpm run world-model:reconcile`
//! (`scripts/world-model-reconcile.ts`, Phase 13).
//!
//! It compares the TypeScript-era SQLite files (`MESSAGES_DB_PATH`, `DATABASE_PATH`)
//! with the World-Model rows of PostgreSQL, writes an optional JSON report and
//! prints one line per domain. Like the script, it reads the SQLite files
//! read-only and PostgreSQL only through the scoped statements of the runtime.
//!
//! Usage:
//!   betaclaw-scheduler reconcile --dry-run
//!   betaclaw-scheduler reconcile --scope user1:persona1:workspace1
//!   betaclaw-scheduler reconcile --output report.json
//!
//! Exit status 0 when every row is `ok`, 1 otherwise. A snapshot of the legacy
//! data is taken before either side is read; the report keeps the same field names
//! as the script (`generatedAt`, `sourceSnapshotAt`, `rows`, `hashes`, ...).

use std::path::Path;

use betaclaw_core::world_model::db::{
    scoped_query, NormalizedScope, PgError, PgExecutor, PgRow, PgStatement, PgValue,
};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use super::{
    connect_lazy_executor, iso_now, load_config, migrate, number_of, parse_scope, text_of,
};

/// The parsed flags (`parseArgs`, `reconcile.ts:94-108`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileOptions {
    pub dry_run: bool,
    pub scope: Option<String>,
    pub output: Option<String>,
}

/// `--dry-run`, `--scope <value>`, `--output <path>`. A flag without its value
/// takes the next argument even when that is another flag, as in the script.
pub fn parse_args(args: &[String]) -> ReconcileOptions {
    let mut options = ReconcileOptions::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--dry-run" => options.dry_run = true,
            "--scope" => {
                index += 1;
                options.scope = args.get(index).cloned();
            }
            "--output" => {
                index += 1;
                options.output = args.get(index).cloned();
            }
            _ => {}
        }
        index += 1;
    }
    options
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileRow {
    pub domain: String,
    pub old_count: i64,
    pub new_count: i64,
    pub difference: i64,
    pub status: String,
    pub details: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ReconcileHashes {
    pub assertions: Vec<String>,
    pub events: Vec<String>,
    pub tasks: Vec<String>,
}

/// `ReconcileReport` (`reconcile.ts:36-45`). `scope` is left out when it was not
/// given, as `JSON.stringify` drops `undefined`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileReport {
    pub generated_at: String,
    pub source_snapshot_at: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub rows: Vec<ReconcileRow>,
    pub overall: String,
    pub errors: Vec<String>,
    pub hashes: ReconcileHashes,
}

impl ReconcileReport {
    fn new(scope: Option<String>) -> Self {
        let now = iso_now();
        Self {
            generated_at: now.clone(),
            source_snapshot_at: now,
            mode: "off".to_string(),
            scope,
            rows: Vec::new(),
            overall: "ok".to_string(),
            errors: Vec::new(),
            hashes: ReconcileHashes::default(),
        }
    }
}

/// Runs the reconciliation and prints the report. Returns the exit status.
pub async fn run(args: &[String]) -> i32 {
    let options = parse_args(args);
    let mut report = ReconcileReport::new(options.scope.clone());

    println!("=== World Model Reconcile ===");
    println!("Mode: {}", if options.dry_run { "DRY RUN" } else { "LIVE" });
    println!("Scope: {}", options.scope.as_deref().unwrap_or("all"));
    println!();

    if let Err(message) = reconcile(&options, &mut report).await {
        report.errors.push(format!("Reconcile failed: {message}"));
        report.overall = "error".to_string();
        eprintln!("Reconcile failed: {message}");
    }

    if !report.errors.is_empty() {
        println!("Errors:");
        for error in &report.errors {
            println!("  - {error}");
        }
    }
    if report.overall != "ok" || !report.errors.is_empty() {
        1
    } else {
        0
    }
}

/// The body of `runReconcile`'s `try`. Errors are returned, and the caller records
/// them as `Reconcile failed: …`.
async fn reconcile(options: &ReconcileOptions, report: &mut ReconcileReport) -> Result<(), String> {
    let config = load_config();
    report.mode = config.mode.as_str().to_string();

    if !config.enabled && !config.e2e_enabled {
        println!("World Model not enabled. Set WORLD_MODEL_ENABLED=true or WORLD_MODEL_E2E=true");
        report.overall = "error".to_string();
        report
            .errors
            .push("World Model is disabled; no reconciliation was performed.".to_string());
        return Ok(());
    }

    let executor = connect_lazy_executor(&config).map_err(|error| error.into_message())?;
    migrate(&executor)
        .await
        .map_err(|error| error.into_message())?;

    // `null` for `all`, the explicit scope otherwise (`parseScope`, `:55-58`).
    let parsed_scope = match options.scope.as_deref() {
        None | Some("all") => None,
        Some(value) => Some(parse_scope(value)?),
    };

    // Freeze the legacy source boundary before reading either side.
    report.source_snapshot_at = iso_now();
    let snapshot = report.source_snapshot_at.clone();
    let mut sqlite_message_count = 0_i64;
    match sqlite_message_snapshot(&messages_db_path(), parsed_scope.as_ref(), &snapshot) {
        Ok(count) => sqlite_message_count = count,
        Err(message) => report
            .errors
            .push(format!("SQLite message snapshot failed: {message}")),
    }

    let mut scopes: Vec<NormalizedScope> = Vec::new();
    if let Some(scope) = &parsed_scope {
        push_scope(&mut scopes, scope.clone());
    } else {
        // Scopes that have legacy conversations; errors are ignored, as in the script.
        for (user_id, persona_id) in
            sqlite_conversation_scopes(&messages_db_path(), &snapshot).unwrap_or_default()
        {
            push_scope(
                &mut scopes,
                NormalizedScope {
                    user_id,
                    persona_id,
                    workspace_id: String::new(),
                },
            );
        }
        if scopes.is_empty() {
            push_scope(
                &mut scopes,
                NormalizedScope {
                    user_id: "default".into(),
                    persona_id: "default".into(),
                    workspace_id: String::new(),
                },
            );
        }
        // Scopes that have World-Model rows (an unscoped read, as `db.query` does).
        let rows = executor
            .query(PgStatement::with_params(
                "SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_observations
                 WHERE received_at <= $1
                 UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_entities
                 WHERE created_at <= $1
                 UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_tasks
                 WHERE created_at <= $1",
                vec![PgValue::text(snapshot.as_str())],
            ))
            .await
            .map_err(|error| error.into_message())?;
        for row in &rows.rows {
            push_scope(
                &mut scopes,
                NormalizedScope {
                    user_id: text_column(row, "user_id"),
                    persona_id: text_column(row, "persona_id"),
                    workspace_id: text_column(row, "workspace_id"),
                },
            );
        }
    }

    let mut totals = Totals::default();
    for scope in &scopes {
        scoped_totals(&executor, scope, &snapshot, &mut totals).await?;
    }

    report.rows.push(ReconcileRow {
        domain: "observations".into(),
        old_count: sqlite_message_count,
        new_count: totals.chat_observations,
        difference: totals.chat_observations - sqlite_message_count,
        status: if totals.chat_observations == sqlite_message_count {
            "ok"
        } else {
            "error"
        }
        .into(),
        details: format!(
            "chat_message observations vs SQLite message snapshot at {snapshot}; total canonical observations including derived sources={}",
            totals.observations
        ),
    });
    report.rows.push(ReconcileRow {
        domain: "assertions".into(),
        old_count: totals.active_assertions,
        new_count: totals.active_assertions,
        difference: 0,
        status: "ok".into(),
        details: format!(
            "canonical active={}; historical superseded={}, retracted={}",
            totals.active_assertions, totals.superseded_assertions, totals.retracted_assertions
        ),
    });
    report.rows.push(ReconcileRow {
        domain: "events".into(),
        old_count: totals.events,
        new_count: totals.events,
        difference: 0,
        status: "ok".into(),
        details: format!(
            "canonical total={}; cancelled historical={}",
            totals.events, totals.cancelled_events
        ),
    });
    report.rows.push(ReconcileRow {
        domain: "open_loops (active)".into(),
        old_count: totals.active_loops,
        new_count: totals.active_loops,
        difference: 0,
        status: if totals.active_loops > 100 {
            "warn"
        } else {
            "ok"
        }
        .into(),
        details: "active open loops".into(),
    });

    // The legacy task count of mission-control.db, or the canonical count when the file
    // cannot be read (the script keeps its default and records the error).
    let mut old_task_count = totals.canonical_tasks;
    match sqlite_task_count(&mission_control_db_path(), parsed_scope.as_ref(), &snapshot) {
        Ok(count) => old_task_count = count,
        Err(message) => report
            .errors
            .push(format!("SQLite task count failed: {message}")),
    }
    report.rows.push(ReconcileRow {
        domain: "tasks".into(),
        old_count: old_task_count,
        new_count: totals.external_tasks,
        difference: totals.external_tasks - old_task_count,
        status: if totals.external_tasks == old_task_count {
            "ok"
        } else {
            "error"
        }
        .into(),
        details: format!(
            "legacy Mission-Control mirror={}, sqlite={old_task_count}; derived internal tasks={}",
            totals.external_tasks,
            totals.canonical_tasks - totals.external_tasks
        ),
    });
    report.rows.push(ReconcileRow {
        domain: "embeddings".into(),
        old_count: totals.embedding_targets,
        new_count: totals.embeddings,
        difference: totals.embeddings - totals.embedding_targets,
        status: if totals.embeddings == totals.embedding_targets
            && totals.embeddings_without_text == 0
        {
            "ok"
        } else {
            "error"
        }
        .into(),
        details: format!(
            "targets={}, stored={}, without_text={}",
            totals.embedding_targets, totals.embeddings, totals.embeddings_without_text
        ),
    });
    report.rows.push(ReconcileRow {
        domain: "projection_pending".into(),
        old_count: 0,
        new_count: totals.pending_projections + totals.failed_projections,
        difference: totals.pending_projections + totals.failed_projections,
        status: if totals.failed_projections > 0 {
            "error"
        } else if totals.pending_projections > 0 {
            "warn"
        } else {
            "ok"
        }
        .into(),
        details: format!(
            "pending={}, failed={}",
            totals.pending_projections, totals.failed_projections
        ),
    });
    report.rows.push(ReconcileRow {
        domain: "delivery_receipts".into(),
        old_count: 0,
        new_count: totals.delivery_receipts,
        difference: 0,
        status: "ok".into(),
        details: "provider acknowledgements inventory; no legacy row mapping exists".into(),
    });
    report.rows.push(ReconcileRow {
        domain: "outbox".into(),
        old_count: 0,
        new_count: totals.pending_outbox + totals.failed_outbox,
        difference: totals.pending_outbox + totals.failed_outbox,
        status: if totals.failed_outbox > 10 {
            "error"
        } else if totals.pending_outbox > 100 {
            "warn"
        } else {
            "ok"
        }
        .into(),
        details: format!(
            "pending={}, failed={}",
            totals.pending_outbox, totals.failed_outbox
        ),
    });

    // The overall status: `error` beats `warn`, which beats `ok`.
    for row in &report.rows {
        if row.status == "error" {
            report.overall = "error".into();
            break;
        }
        if row.status == "warn" && report.overall != "error" {
            report.overall = "warn".into();
        }
    }
    report.hashes = ReconcileHashes {
        assertions: totals.assertion_hashes.clone(),
        events: totals.event_hashes.clone(),
        tasks: totals.task_hashes.clone(),
    };
    if !report.errors.is_empty() {
        report.overall = "error".into();
    }

    if options.dry_run {
        println!("[DRY RUN] Reconcile report would be generated. No changes made.");
    }
    println!();
    println!("=== Reconcile Report ===");
    for row in &report.rows {
        let icon = match row.status.as_str() {
            "ok" => "✅",
            "warn" => "⚠️",
            _ => "❌",
        };
        let details = if row.details.is_empty() {
            String::new()
        } else {
            format!(" ({})", row.details)
        };
        println!(
            "{icon} {}: old={}, new={}, diff={}{details}",
            row.domain, row.old_count, row.new_count, row.difference
        );
    }
    println!();
    println!("Overall: {}", report.overall);

    if let Some(output) = &options.output {
        let json = serde_json::to_string_pretty(report).map_err(|error| error.to_string())?;
        std::fs::write(output, json).map_err(|error| error.to_string())?;
        println!("Report written to {output}");
    }
    Ok(())
}

fn push_scope(scopes: &mut Vec<NormalizedScope>, scope: NormalizedScope) {
    if !scopes.contains(&scope) {
        scopes.push(scope);
    }
}

fn text_column(row: &PgRow, column: &str) -> String {
    text_of(row.get(column)).unwrap_or_default()
}

/// The sums of the per-scope reads (the `total*` variables of the script).
#[derive(Debug, Default)]
struct Totals {
    observations: i64,
    chat_observations: i64,
    active_assertions: i64,
    superseded_assertions: i64,
    retracted_assertions: i64,
    events: i64,
    cancelled_events: i64,
    active_loops: i64,
    canonical_tasks: i64,
    external_tasks: i64,
    embeddings: i64,
    embeddings_without_text: i64,
    embedding_targets: i64,
    pending_projections: i64,
    failed_projections: i64,
    delivery_receipts: i64,
    pending_outbox: i64,
    failed_outbox: i64,
    assertion_hashes: Vec<String>,
    event_hashes: Vec<String>,
    task_hashes: Vec<String>,
}

/// The scoped reads of one scope, in the order of the script. Every statement is one
/// scoped transaction, as `runWithWorldModelScope` + `db.query` makes it.
async fn scoped_totals(
    executor: &dyn PgExecutor,
    scope: &NormalizedScope,
    snapshot: &str,
    totals: &mut Totals,
) -> Result<(), String> {
    // `$1..$3` are the scope, `$4` the snapshot boundary of every read.
    let read = |sql: &'static str| async move {
        let params = vec![
            PgValue::text(scope.user_id.as_str()),
            PgValue::text(scope.persona_id.as_str()),
            PgValue::text(scope.workspace_id.as_str()),
            PgValue::text(snapshot),
        ];
        scoped_query::<PgError>(executor, scope, PgStatement::with_params(sql, params))
            .await
            .map(|result| result.rows)
            .map_err(|error| error.into_message())
    };
    let first = |rows: &[PgRow], column: &str| -> i64 {
        number_of(rows.first().and_then(|row| row.get(column)))
    };
    let hash_of = |rows: &[PgRow]| text_of(rows.first().and_then(|row| row.get("hash")));

    let rows = read(
        "SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE source_type = 'chat_message') AS chat
         FROM world_model_observations
         WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND received_at <= $4",
    )
    .await?;
    totals.observations += first(&rows, "total");
    totals.chat_observations += first(&rows, "chat");

    let rows = read(
        "SELECT
           COUNT(*) FILTER (WHERE status='active') as active,
           COUNT(*) FILTER (WHERE status='superseded') as superseded,
           COUNT(*) FILTER (WHERE status='retracted') as retracted
         FROM world_model_assertions WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND created_at <= $4",
    )
    .await?;
    totals.active_assertions += first(&rows, "active");
    totals.superseded_assertions += first(&rows, "superseded");
    totals.retracted_assertions += first(&rows, "retracted");

    let rows = read(
        "SELECT md5(COALESCE(string_agg(
           id::text || ':' || predicate || ':' || COALESCE(object_value, ''),
           '|' ORDER BY id
         ) FILTER (WHERE status = 'active'), '')) AS hash
         FROM world_model_assertions WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND created_at <= $4",
    )
    .await?;
    if let Some(hash) = hash_of(&rows) {
        totals.assertion_hashes.push(hash);
    }

    let rows = read(
        "SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled
         FROM world_model_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND created_at <= $4",
    )
    .await?;
    totals.events += first(&rows, "total");
    totals.cancelled_events += first(&rows, "cancelled");

    let rows = read(
        "SELECT md5(COALESCE(string_agg(
           id::text || ':' || status::text || ':' || COALESCE(replaces_event_id::text, ''),
           '|' ORDER BY id
         ), '')) AS hash
         FROM world_model_events WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND created_at <= $4",
    )
    .await?;
    if let Some(hash) = hash_of(&rows) {
        totals.event_hashes.push(hash);
    }

    let rows = read(
        "SELECT COUNT(*) as count FROM world_model_open_loops
         WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND status IN ('open','scheduled','asked') AND created_at <= $4",
    )
    .await?;
    totals.active_loops += first(&rows, "count");

    let rows = read(
        "SELECT COUNT(*) as count FROM world_model_tasks
         WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND created_at <= $4",
    )
    .await?;
    totals.canonical_tasks += first(&rows, "count");

    let rows = read(
        "SELECT COUNT(*) AS count FROM world_model_tasks
         WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND external_task_id IS NOT NULL AND created_at <= $4",
    )
    .await?;
    totals.external_tasks += first(&rows, "count");

    let rows = read(
        "SELECT md5(COALESCE(string_agg(
           id::text || ':' || status::text || ':' || title,
           '|' ORDER BY id
         ), '')) AS hash
         FROM world_model_tasks WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND created_at <= $4",
    )
    .await?;
    if let Some(hash) = hash_of(&rows) {
        totals.task_hashes.push(hash);
    }

    let rows = read(
        "SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE target_content IS NULL OR target_content = '') AS without_text
         FROM world_model_embeddings WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND created_at <= $4",
    )
    .await?;
    totals.embeddings += first(&rows, "total");
    totals.embeddings_without_text += first(&rows, "without_text");

    let rows = read(
        "SELECT COUNT(*) AS count FROM (
           SELECT id FROM world_model_observations
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND received_at <= $4
           UNION ALL
           SELECT id FROM world_model_entities
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND created_at <= $4
           UNION ALL
           SELECT id FROM world_model_assertions
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
             AND status = 'active' AND known_to IS NULL AND created_at <= $4
           UNION ALL
           SELECT id FROM world_model_events
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND created_at <= $4
           UNION ALL
           SELECT id FROM world_model_tasks
           WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3 AND created_at <= $4
         ) targets",
    )
    .await?;
    totals.embedding_targets += first(&rows, "count");

    let rows = read(
        "SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed
         FROM world_model_projection_pending
         WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND created_at <= $4",
    )
    .await?;
    totals.pending_projections += first(&rows, "pending");
    totals.failed_projections += first(&rows, "failed");

    let rows = read(
        "SELECT COUNT(*) AS count FROM world_model_delivery_receipts
         WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND delivered_at <= $4",
    )
    .await?;
    totals.delivery_receipts += first(&rows, "count");

    let rows = read(
        "SELECT
           COUNT(*) FILTER (WHERE status='pending') as pending,
           COUNT(*) FILTER (WHERE status='failed') as failed
         FROM world_model_outbox_events
         WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3
           AND created_at <= $4",
    )
    .await?;
    totals.pending_outbox += first(&rows, "pending");
    totals.failed_outbox += first(&rows, "failed");
    Ok(())
}

/// The read-only open of a legacy SQLite file (`new Database(path, { readonly: true })`).
pub fn open_readonly(path: &str) -> Result<Connection, String> {
    Connection::open_with_flags(
        Path::new(path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())
}

/// `MESSAGES_DB_PATH || .local/messages.db` (`openMessagesDb`, `reconcile.ts:110-113`).
fn messages_db_path() -> String {
    non_empty_env("MESSAGES_DB_PATH").unwrap_or_else(|| ".local/messages.db".into())
}

/// `DATABASE_PATH || mission-control.db` (`openMissionControlDb`).
fn mission_control_db_path() -> String {
    non_empty_env("DATABASE_PATH").unwrap_or_else(|| "mission-control.db".into())
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// `SELECT COUNT(*) …` of the legacy messages up to the snapshot.
fn sqlite_message_snapshot(
    path: &str,
    scope: Option<&NormalizedScope>,
    snapshot: &str,
) -> Result<i64, String> {
    let connection = open_readonly(path)?;
    let count: i64 = match scope {
        Some(scope) => connection
            .query_row(
                "SELECT COUNT(*) as count FROM messages m
                 JOIN conversations c ON c.id = m.conversation_id
                 WHERE c.user_id = ? AND c.persona_id = ? AND m.created_at <= ?",
                rusqlite::params![scope.user_id, scope.persona_id, snapshot],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?,
        None => connection
            .query_row(
                "SELECT COUNT(*) as count FROM messages WHERE created_at <= ?",
                rusqlite::params![snapshot],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?,
    };
    Ok(count)
}

/// The legacy `(user_id, persona_id)` pairs with conversations or messages up to the
/// snapshot. Any failure yields no pairs, as the script's `catch` does.
fn sqlite_conversation_scopes(path: &str, snapshot: &str) -> Result<Vec<(String, String)>, String> {
    let connection = open_readonly(path)?;
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT c.user_id, c.persona_id FROM conversations c
             WHERE c.created_at <= ? OR EXISTS (
               SELECT 1 FROM messages m
               WHERE m.conversation_id = c.id AND m.created_at <= ?
             )",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(rusqlite::params![snapshot, snapshot], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

/// `SELECT COUNT(*) … FROM tasks` of mission-control.db up to the snapshot.
fn sqlite_task_count(
    path: &str,
    scope: Option<&NormalizedScope>,
    snapshot: &str,
) -> Result<i64, String> {
    let connection = open_readonly(path)?;
    let count: i64 = match scope {
        Some(scope) => connection
            .query_row(
                "SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ? AND updated_at <= ?",
                rusqlite::params![scope.workspace_id, snapshot],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?,
        None => connection
            .query_row(
                "SELECT COUNT(*) as count FROM tasks WHERE updated_at <= ?",
                rusqlite::params![snapshot],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?,
    };
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn the_flags_are_read_in_any_order_and_unknown_ones_are_ignored() {
        assert_eq!(
            parse_args(&args(&[
                "--scope",
                "u:p:w",
                "--unknown",
                "--dry-run",
                "--output",
                "r.json"
            ])),
            ReconcileOptions {
                dry_run: true,
                scope: Some("u:p:w".into()),
                output: Some("r.json".into()),
            }
        );
    }

    #[test]
    fn a_flag_without_a_value_takes_the_next_argument_as_in_the_script() {
        let parsed = parse_args(&args(&["--scope", "--dry-run"]));
        assert_eq!(parsed.scope.as_deref(), Some("--dry-run"));
        assert!(!parsed.dry_run);
        assert_eq!(parse_args(&args(&["--output"])).output, None);
    }

    #[test]
    fn the_report_keeps_the_field_names_and_leaves_out_an_absent_scope() {
        let report = ReconcileReport {
            generated_at: "t".into(),
            source_snapshot_at: "s".into(),
            mode: "canonical".into(),
            scope: None,
            rows: vec![ReconcileRow {
                domain: "events".into(),
                old_count: 1,
                new_count: 1,
                difference: 0,
                status: "ok".into(),
                details: "canonical total=1".into(),
            }],
            overall: "ok".into(),
            errors: vec![],
            hashes: ReconcileHashes::default(),
        };
        let json = serde_json::to_value(&report).expect("json");
        assert!(json.get("scope").is_none());
        assert_eq!(json["sourceSnapshotAt"], "s");
        assert_eq!(json["rows"][0]["oldCount"], 1);
        assert_eq!(json["hashes"]["tasks"], serde_json::json!([]));
    }

    #[test]
    fn a_missing_legacy_file_is_an_error_for_the_snapshot() {
        let result = open_readonly("does-not-exist/messages.db");
        assert!(result.is_err());
    }

    #[test]
    fn the_legacy_snapshot_counts_the_messages_up_to_the_boundary() {
        let directory = std::env::temp_dir().join(format!("wm-reconcile-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("dir");
        let path = directory.join("messages.db");
        let connection = Connection::open(&path).expect("open");
        connection
            .execute_batch(
                "CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT, persona_id TEXT, created_at TEXT);
                 CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, created_at TEXT);
                 INSERT INTO conversations VALUES ('c1', 'u', 'p', '2026-01-01T00:00:00.000Z');
                 INSERT INTO messages VALUES ('m1', 'c1', '2026-01-01T00:00:00.000Z');
                 INSERT INTO messages VALUES ('m2', 'c1', '2026-06-01T00:00:00.000Z');",
            )
            .expect("schema");
        drop(connection);
        let path_str = path.to_str().expect("utf-8 path");
        let scope = NormalizedScope {
            user_id: "u".into(),
            persona_id: "p".into(),
            workspace_id: String::new(),
        };
        assert_eq!(
            sqlite_message_snapshot(path_str, None, "2026-03-01T00:00:00.000Z"),
            Ok(1)
        );
        assert_eq!(
            sqlite_message_snapshot(path_str, Some(&scope), "2026-07-01T00:00:00.000Z"),
            Ok(2)
        );
        assert_eq!(
            sqlite_conversation_scopes(path_str, "2026-03-01T00:00:00.000Z"),
            Ok(vec![("u".to_string(), "p".to_string())])
        );
        let _ = std::fs::remove_dir_all(&directory);
    }
}
