//! Port of `src/server/tasks/` (S10). Submodules name their TypeScript source.
//!
//! Ported: the task types, the create and update validation, the status rules,
//! the `_migrations` ladder with the SQLite repositories, the task workspace
//! directories, the deliverable registration, the dispatch message, the failure
//! classification and the finalisation effects, and the test-job table with the
//! result summary.
//!
//! Not ported, because each needs a runtime that belongs to a later slice: the
//! `chat.send` retry loop and the connect step of the dispatch (S8, OP-S10-2),
//! the skill check of the dispatch (S11), the Playwright deliverable tester and
//! the `css-tree` check (no browser runtime and no CSS parser in the workspace),
//! the `task_updated` broadcasts, the World-Model mirror calls, the timer runtime of
//! the workspace cleanup and the process-wide singletons.

pub mod deliverables;
pub mod dispatch;
pub mod migrations;
pub mod repository;
pub mod state;
pub mod testing;
pub mod types;
pub mod validation;
pub mod workspace;

/// Errors of the task service. The messages are those of `taskService.ts`.
#[derive(Debug, thiserror::Error)]
pub enum TaskError {
    #[error("Task not found")]
    NotFound,
    #[error("{0}")]
    Forbidden(String),
    #[error("No updates provided")]
    NoUpdates,
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// The `\s` class of JavaScript regular expressions, which is also what `trim` removes.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `String(value || '')` for an optional JSON value.
pub(crate) fn js_string(value: Option<&serde_json::Value>) -> String {
    match value {
        None | Some(serde_json::Value::Null) | Some(serde_json::Value::Bool(false)) => {
            String::new()
        }
        Some(serde_json::Value::Number(number)) if number.as_f64() == Some(0.0) => String::new(),
        Some(other) => js_element(other),
    }
}

/// `String(value)` for a JSON value that is not falsy at the top level.
fn js_element(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_element).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `value || null` for text: the empty string counts as absent.
pub(crate) fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

#[cfg(test)]
pub(crate) mod test_support {
    use rusqlite::{params, Connection};

    use super::migrations::run_migrations;
    use crate::db::{self, OpenOptions};

    pub(crate) const FIXED_TIME: &str = "2026-01-01T00:00:00.000Z";

    /// A fresh in-memory database with the task tables and the default workspace.
    pub(crate) fn memory_connection() -> Connection {
        let mut connection =
            db::open(OpenOptions::new(":memory:")).expect("open in-memory database");
        run_migrations(&mut connection).expect("run migrations");
        connection
    }

    pub(crate) fn insert_agent(
        connection: &Connection,
        id: &str,
        name: &str,
        is_master: bool,
        status: &str,
    ) {
        connection
            .execute(
                "INSERT INTO agents (id, name, role, is_master, status, workspace_id, created_at, updated_at)
                 VALUES (?, ?, 'worker', ?, ?, 'default', ?, ?)",
                params![id, name, i64::from(is_master), status, FIXED_TIME, FIXED_TIME],
            )
            .expect("insert agent");
    }

    pub(crate) fn insert_task(
        connection: &Connection,
        id: &str,
        title: &str,
        status: &str,
        assigned_agent_id: Option<&str>,
    ) {
        connection
            .execute(
                "INSERT INTO tasks (id, title, status, assigned_agent_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![id, title, status, assigned_agent_id, FIXED_TIME, FIXED_TIME],
            )
            .expect("insert task");
    }

    /// A unique directory under the system temp dir, removed by the caller.
    pub(crate) fn temp_root(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "betaclaw-tasks-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }
}
