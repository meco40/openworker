//! Port of `src/server/world-model/runtime/scopeDiscovery.ts`.
//!
//! Finds runtime scopes without bypassing World-Model RLS: the legacy message
//! store is the authoritative scope registry for chat-backed tenants, and an
//! environment allowlist covers scopes that only contain scheduled or
//! operational data.
//!
//! The TypeScript reads `process.env` inside the function and swallows a failing
//! canonical scan with a warning (`scopeDiscovery.ts:67-69`). The port takes the
//! environment as a map and the pool as an optional argument, so both sources are
//! testable without a process-wide mutation and without a database; the warning
//! stays a warning.

use std::collections::HashMap;

use serde_json::Value;

use crate::world_model::config::RuntimeRole;
use crate::world_model::db::{PgExecutor, PgRow, PgStatement};
use crate::world_model::scope::WorldModelScope;

/// `WORLD_MODEL_DISPATCH_SCOPES` (`scopeDiscovery.ts:9`).
pub const DISPATCH_SCOPES_ENV: &str = "WORLD_MODEL_DISPATCH_SCOPES";
/// `MESSAGES_DB_PATH` (`scopeDiscovery.ts:27`).
pub const MESSAGES_DB_PATH_ENV: &str = "MESSAGES_DB_PATH";

/// The scope scan of `scopeDiscovery.ts:54-58`, verbatim.
pub const SCOPE_SCAN_SQL: &str =
    "SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_observations
       UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_memory_items
       UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_entities
       UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_events
       UNION SELECT DISTINCT user_id, persona_id, workspace_id FROM world_model_tasks";

/// The conversations scan of `scopeDiscovery.ts:31-37`, verbatim.
pub const CONVERSATION_SCOPE_SQL: &str = "SELECT DISTINCT user_id, persona_id
             FROM conversations
            WHERE user_id IS NOT NULL AND persona_id IS NOT NULL";

/// `parseConfiguredScopes` (`scopeDiscovery.ts:8-18`).
///
/// `value.split(':')` with `parts.length < 3 || !parts[0] || !parts[1]` skipped:
/// `"u:p"` is *not* a scope, `"u:p:"` is one with an empty workspace, and
/// everything after the second colon belongs to the workspace id again.
pub fn parse_configured_scopes(env: &HashMap<String, String>) -> Vec<WorldModelScope> {
    env.get(DISPATCH_SCOPES_ENV)
        .map(String::as_str)
        .unwrap_or("")
        .split(',')
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .flat_map(|value| {
            let parts: Vec<&str> = value.split(':').collect();
            if parts.len() < 3 || parts[0].is_empty() || parts[1].is_empty() {
                return Vec::new();
            }
            vec![WorldModelScope::new(
                parts[0],
                parts[1],
                Some(parts[2..].join(":")),
            )]
        })
        .collect()
}

/// The message store path of `scopeDiscovery.ts:27`
/// (`MESSAGES_DB_PATH || path.resolve('.local/messages.db')`).
pub fn messages_db_path(env: &HashMap<String, String>) -> String {
    match env.get(MESSAGES_DB_PATH_ENV) {
        Some(path) if !path.is_empty() => path.clone(),
        _ => std::env::current_dir()
            .map(|cwd| cwd.join(".local/messages.db"))
            .unwrap_or_else(|_| std::path::PathBuf::from(".local/messages.db"))
            .to_string_lossy()
            .into_owned(),
    }
}

/// The `SELECT DISTINCT user_id, persona_id FROM conversations` scan of
/// `scopeDiscovery.ts:31-37`.
///
/// A missing or unreadable file answers an empty list, like the
/// `fs.existsSync(dbPath)` guard of the source.
pub fn scopes_from_message_store(db_path: &str) -> Vec<WorldModelScope> {
    if db_path.is_empty() || !std::path::Path::new(db_path).exists() {
        return Vec::new();
    }
    let options = crate::db::OpenOptions {
        readonly: true,
        ..crate::db::OpenOptions::new(db_path)
    };
    let Ok(connection) = crate::db::open(options) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(CONVERSATION_SCOPE_SQL) else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .map(|(user_id, persona_id)| WorldModelScope::new(user_id, persona_id, Some(String::new())))
        .collect()
}

/// `listRuntimeWorldModelScopes` (`scopeDiscovery.ts:25-77`).
pub async fn list_runtime_world_model_scopes(
    env: &HashMap<String, String>,
    database: Option<&dyn PgExecutor>,
    runtime_role: RuntimeRole,
) -> Vec<WorldModelScope> {
    let mut candidates = parse_configured_scopes(env);
    candidates.extend(scopes_from_message_store(&messages_db_path(env)));

    // `if (getWorldModelConfig().runtimeRole !== 'worker')` — a dedicated worker
    // role intentionally sees no rows for this unscoped query, so its explicit
    // `WORLD_MODEL_DISPATCH_SCOPES` remain the safe discovery path.
    if !runtime_role.is_worker() {
        if let Some(database) = database {
            match database.query(PgStatement::new(SCOPE_SCAN_SQL)).await {
                Ok(result) => {
                    for row in &result.rows {
                        candidates.push(WorldModelScope::new(
                            row_text(row, "user_id"),
                            row_text(row, "persona_id"),
                            Some(row_text(row, "workspace_id")),
                        ));
                    }
                }
                Err(error) => tracing::warn!(
                    target: "world_model::scope_discovery",
                    "[world-model:scope-discovery] canonical scope scan unavailable: {}",
                    crate::safe_error_message(&error)
                ),
            }
        }
    }

    let mut seen: Vec<String> = Vec::new();
    let mut unique: Vec<WorldModelScope> = Vec::new();
    for scope in candidates {
        // `${scope.userId}\u0000${scope.personaId}\u0000${scope.workspaceId ?? ''}`
        let key = format!(
            "{}\u{0}{}\u{0}{}",
            scope.user_id,
            scope.persona_id,
            scope.workspace_id.clone().unwrap_or_default()
        );
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        unique.push(scope);
    }
    unique
}

/// `text(value)` for a scanned column: a string keeps its trimmed value,
/// `null`/`undefined` is `''` — the `?? ''` of `scopeDiscovery.ts:64`.
fn row_text(row: &PgRow, column: &str) -> String {
    match row.get(column) {
        Some(Value::String(text)) => text.trim().to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::RecordingExecutor;
    use crate::world_model::db::{drive_sync, PgError, PgQueryResult};
    use serde_json::json;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn row(user: &str, persona: &str, workspace: Value) -> PgRow {
        let mut map = serde_json::Map::new();
        map.insert("user_id".to_string(), json!(user));
        map.insert("persona_id".to_string(), json!(persona));
        map.insert("workspace_id".to_string(), workspace);
        map
    }

    fn rendered(scopes: &[WorldModelScope]) -> Vec<String> {
        scopes
            .iter()
            .map(|scope| {
                format!(
                    "{}:{}:{}",
                    scope.user_id,
                    scope.persona_id,
                    scope.workspace_id.clone().unwrap_or_default()
                )
            })
            .collect()
    }

    #[test]
    fn configured_scopes_need_three_parts() {
        let scopes = parse_configured_scopes(&env(&[(
            DISPATCH_SCOPES_ENV,
            "u1:p1:w1, u2:p2 , , :p3:w3 , u4::w4 , u5:p5: , u6:p6:w:7",
        )]));
        assert_eq!(
            rendered(&scopes),
            vec!["u1:p1:w1", "u5:p5:", "u6:p6:w:7"],
            "a two-part value, an empty user and an empty persona are skipped"
        );
    }

    #[test]
    fn a_missing_scopes_variable_is_an_empty_list() {
        assert!(parse_configured_scopes(&env(&[])).is_empty());
        assert!(parse_configured_scopes(&env(&[(DISPATCH_SCOPES_ENV, "")])).is_empty());
    }

    #[test]
    fn the_message_store_supplies_the_distinct_scopes() {
        let dir = std::env::temp_dir().join(format!("wm-scopes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let db_path = dir.join("messages.db");
        let connection = crate::db::open(crate::db::OpenOptions::new(
            db_path.to_string_lossy().to_string(),
        ))
        .expect("sqlite");
        connection
            .execute_batch(
                "CREATE TABLE conversations (user_id TEXT, persona_id TEXT);
                 INSERT INTO conversations VALUES ('u1', 'p1'), ('u1', 'p1'), ('u2', 'p2');
                 INSERT INTO conversations VALUES (NULL, 'p2'), ('u3', NULL);",
            )
            .expect("fixture");

        let scopes = scopes_from_message_store(&db_path.to_string_lossy());
        assert_eq!(
            scopes
                .iter()
                .map(|scope| format!("{}:{}", scope.user_id, scope.persona_id))
                .collect::<Vec<String>>(),
            vec!["u1:p1", "u2:p2"],
            "`DISTINCT` collapses the duplicate and the NULL rows are filtered"
        );
        assert!(scopes
            .iter()
            .all(|scope| scope.workspace_id.as_deref() == Some("")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_message_store_contributes_nothing() {
        assert!(scopes_from_message_store("").is_empty());
        assert!(scopes_from_message_store("/does/not/exist/messages.db").is_empty());
    }

    #[test]
    fn the_canonical_scan_is_added_and_deduplicated() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![
            row("u1", "p1", json!("w1")),
            row("u1", "p1", json!("w1")),
            row("u2", "p2", json!(null)),
        ]))]);
        let scopes = drive_sync(list_runtime_world_model_scopes(
            &env(&[(DISPATCH_SCOPES_ENV, "u1:p1:w1")]),
            Some(&executor),
            RuntimeRole::App,
        ))
        .expect("discovery");
        assert_eq!(
            rendered(&scopes),
            vec!["u1:p1:w1", "u2:p2:"],
            "the configured scope wins the deduplication and NULL becomes empty"
        );
        assert_eq!(
            executor.calls().len(),
            1,
            "the scan is one unscoped statement"
        );
        assert_eq!(executor.calls()[0].sql(), SCOPE_SCAN_SQL);
    }

    #[test]
    fn a_worker_role_never_scans_the_canonical_tables() {
        let executor = RecordingExecutor::new(vec![]);
        let scopes = drive_sync(list_runtime_world_model_scopes(
            &env(&[(DISPATCH_SCOPES_ENV, "u1:p1:w1")]),
            Some(&executor),
            RuntimeRole::Worker,
        ))
        .expect("discovery");
        assert_eq!(scopes.len(), 1);
        assert!(
            executor.calls().is_empty(),
            "the worker keeps its explicit allowlist as the only discovery path"
        );
    }

    #[test]
    fn a_failing_scan_is_swallowed_like_the_warning_of_the_source() {
        let executor = RecordingExecutor::new(vec![Err(PgError::new("canonical unavailable"))]);
        let scopes = drive_sync(list_runtime_world_model_scopes(
            &env(&[(DISPATCH_SCOPES_ENV, "u1:p1:w1")]),
            Some(&executor),
            RuntimeRole::App,
        ))
        .expect("a failed scan is not an error");
        assert_eq!(scopes.len(), 1);
    }

    #[test]
    fn the_path_falls_back_to_the_workspace_default() {
        assert_eq!(messages_db_path(&env(&[])), {
            let cwd = std::env::current_dir().expect("cwd");
            cwd.join(".local/messages.db")
                .to_string_lossy()
                .into_owned()
        });
        assert_eq!(
            messages_db_path(&env(&[(MESSAGES_DB_PATH_ENV, "/tmp/m.db")])),
            "/tmp/m.db"
        );
    }
}
