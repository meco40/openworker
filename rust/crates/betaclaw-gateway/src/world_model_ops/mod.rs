//! Operations scripts as subcommands of `betaclaw-scheduler`. The memory, knowledge and
//! drill modules follow the same pattern and name their TypeScript original in their
//! header.
//!
//! Port of the scripts `scripts/world-model-verify-rls.ts`,
//! `scripts/world-model-reconcile.ts`, `scripts/world-model-rebuild-projections.ts`
//! and `scripts/world-model-backfill.ts` (Phase 3 of
//! `docs/TS_BACKEND_REMOVAL_PLAN.md`). Each module names the script it replaces and
//! keeps its flags, env variables, output lines and exit codes.
//!
//! The four modules live here and not in `betaclaw-world-model`, because
//! `reconcile` and `backfill` read the TypeScript-era SQLite files and need the
//! knowledge, master and task stores, which depend on the world-model crate.
//!
//! What the Rust binary reads is the process environment only. The TypeScript
//! scripts loaded `.env.local` with `@next/env`; `scripts/rust-scheduler-ops.mjs`
//! does the same before it starts the binary.

pub mod attachments;
pub mod backfill;
pub mod drill;
pub mod graphiti_evaluate;
pub mod knowledge_ingest;
pub mod memory_backfill_channel_scope;
pub mod memory_cleanup_noise;
pub mod memory_migrate_to_postgres;
pub mod memory_reset;
pub mod rebuild;
pub mod reconcile;
pub mod verify_rls;
pub mod workspaces;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use betaclaw_core::memory::mem0::{create_mem0_client_from_env, Mem0HttpClient};
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::world_model::config::{world_model_config_from_process_env, WorldModelConfig};
use betaclaw_core::world_model::db::{NormalizedScope, PgError, PgExecutor};
use betaclaw_core::world_model::driver::{PgPoolSettings, SqlxPgExecutor};
use betaclaw_core::world_model::migrations::{
    run_world_model_migrations_with_admin_pool, MigrationSettings,
};

/// The `connectionTimeoutMillis: 5_000` of the verify script.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a query waits for a pooled connection of the operations.
pub const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(30);

/// `process.env` as a map, for the `resolve_*` helpers that take one.
pub fn process_env() -> HashMap<String, String> {
    std::env::vars().collect()
}

/// `process.env[name]?.trim()` with an empty value counted as missing.
pub fn env_trimmed(env: &HashMap<String, String>, name: &str) -> Option<String> {
    env.get(name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The pool of `getWorldModelDb()`: built without a connection, so an unreachable
/// database is reported by the migration probe, as in the scripts.
pub fn connect_lazy_executor(config: &WorldModelConfig) -> Result<SqlxPgExecutor, PgError> {
    SqlxPgExecutor::connect_lazy(&PgPoolSettings::from_config(config), ACQUIRE_TIMEOUT)
}

/// `MESSAGES_DB_PATH || .local/messages.db` (`openMessagesDb` of the scripts).
pub fn messages_db_path() -> String {
    env_or("MESSAGES_DB_PATH", ".local/messages.db")
}

/// `DATABASE_PATH || mission-control.db` (`openMissionControlDb`).
pub fn mission_control_path() -> String {
    env_or("DATABASE_PATH", "mission-control.db")
}

/// `MASTER_DB_PATH || .local/master.db` (`openMasterDb`).
pub fn master_db_path() -> String {
    env_or("MASTER_DB_PATH", ".local/master.db")
}

/// A variable that counts as unset when empty (`process.env.X || fallback`).
pub fn env_or(name: &str, fallback: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// `getWorldModelConfig()` of the process environment.
pub fn load_config() -> WorldModelConfig {
    world_model_config_from_process_env()
}

/// Opens a pool on `database_url` and connects eagerly, so an unreachable database
/// fails here as `client.connect()` does in the scripts.
pub async fn connect_url(
    database_url: &str,
    pool_max: i64,
    pool_idle_timeout_ms: i64,
) -> Result<SqlxPgExecutor, PgError> {
    SqlxPgExecutor::connect(&PgPoolSettings {
        database_url: database_url.to_string(),
        pool_max,
        pool_idle_timeout_ms,
    })
    .await
}

/// `runWorldModelMigrations()` (`db.ts:168-202`), with the admin URL when it is set.
/// The operations run it first, as the scripts do.
pub async fn migrate(executor: &dyn PgExecutor) -> Result<Vec<String>, PgError> {
    run_world_model_migrations_with_admin_pool(executor, &MigrationSettings::from_env()).await
}

/// `--scope userId:personaId:workspaceId` (`parseScope` of the scripts). The
/// workspace may contain `:`, and an empty workspace is allowed.
pub fn parse_scope(value: &str) -> Result<NormalizedScope, String> {
    let parts: Vec<&str> = value.split(':').collect();
    let user_id = parts.first().copied().unwrap_or("");
    let persona_id = parts.get(1).copied().unwrap_or("");
    let workspace_id = parts.iter().skip(2).copied().collect::<Vec<_>>().join(":");
    if parts.len() < 3
        || !is_name(user_id)
        || !is_name(persona_id)
        || !(workspace_id.is_empty() || is_workspace(&workspace_id))
    {
        return Err(
            "--scope must be userId:personaId:workspaceId; workspaceId may contain :".to_string(),
        );
    }
    Ok(NormalizedScope {
        user_id: user_id.to_string(),
        persona_id: persona_id.to_string(),
        workspace_id,
    })
}

/// `/^[A-Za-z0-9._-]+$/`
fn is_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `/^[A-Za-z0-9._:-]+$/`
fn is_workspace(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

/// The `Date.now()` / `new Date().toISOString()` of the scripts: UTC with
/// milliseconds, `2026-10-31T12:34:56.789Z`.
pub fn iso_now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// A value of a result column as the scripts read it (`Number(row.count)`): `bigint`
/// columns may come as text or as numbers.
pub fn number_of(value: Option<&serde_json::Value>) -> i64 {
    match value {
        Some(serde_json::Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|float| float as i64))
            .unwrap_or(0),
        Some(serde_json::Value::String(text)) => {
            text.trim().parse::<f64>().map(|v| v as i64).unwrap_or(0)
        }
        _ => 0,
    }
}

/// A text column (`row.hash`), `None` when the column is missing or null.
pub fn text_of(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(text)) => Some(text.clone()),
        Some(serde_json::Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

/// `LEGACY_LOCAL_USER_ID` of `src/server/auth/constants.ts`, which the memory scripts
/// used. It is not the `local-user` of the Rust principal fallback.
pub const LEGACY_LOCAL_USER_ID: &str = "legacy-local-user";

/// `PERSONAS_DB_PATH || .local/personas.db` (`memory-reset.ts`, `memory-cleanup-noise.ts`).
pub fn personas_db_path() -> String {
    env_or("PERSONAS_DB_PATH", ".local/personas.db")
}

/// `hasTable(db, name)`: the lookup in `sqlite_master` the memory scripts run first.
pub fn has_table(connection: &rusqlite::Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .is_ok()
}

/// A SQLite column read the way `String(value || '')` reads it: NULL and empty text
/// give `""`, numbers are printed as JavaScript prints them for integers.
pub fn sql_text(value: rusqlite::types::Value) -> String {
    use rusqlite::types::Value;
    match value {
        Value::Null | Value::Blob(_) => String::new(),
        Value::Integer(number) => number.to_string(),
        Value::Real(number) => number.to_string(),
        Value::Text(text) => text,
    }
}

/// `String(value || '')` for a JSON value of a Mem0 record: `null` and `undefined`
/// give `""`, arrays are joined with `,` like JavaScript does.
pub fn js_string(value: Option<&serde_json::Value>) -> String {
    use serde_json::Value;
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_string(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// `process.argv[indexOf(name) + 1]`: the value after a flag, `None` when the flag is
/// absent or has no value. The arguments carry no program name.
pub fn flag_value(args: &[String], name: &str) -> Option<String> {
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).cloned()
}

/// `Number(value)` for a CLI value, `None` unless the result is finite: `""` is 0,
/// `0x` prefixes are hexadecimal, and `Infinity` or `NaN` are not numbers.
pub fn js_number(value: Option<&str>) -> Option<f64> {
    let text = value?.trim();
    if text.is_empty() {
        return Some(0.0);
    }
    let number = match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        Some(hex) => i64::from_str_radix(hex, 16).ok().map(|value| value as f64),
        None => text.parse::<f64>().ok(),
    }?;
    number.is_finite().then_some(number)
}

/// Appends `value` unless it is already listed: the insertion order of a JS `Set`.
pub fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

/// `createMem0ClientFromEnv(env, fetch)`: `None` when Mem0 is not the configured
/// provider, the error text of the factory otherwise.
pub fn mem0_client(env: &HashMap<String, String>) -> Result<Option<Mem0HttpClient>, String> {
    let transport: Arc<dyn HttpTransport> =
        Arc::new(crate::model_hub_transport::ReqwestTransport::new());
    create_mem0_client_from_env(env, transport).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_has_three_parts_and_the_workspace_may_contain_colons() {
        assert_eq!(
            parse_scope("user1:persona1:workspace1"),
            Ok(NormalizedScope {
                user_id: "user1".into(),
                persona_id: "persona1".into(),
                workspace_id: "workspace1".into(),
            })
        );
        assert_eq!(
            parse_scope("u:p:").map(|s| s.workspace_id),
            Ok(String::new())
        );
        assert_eq!(
            parse_scope("u:p:a:b").map(|s| s.workspace_id),
            Ok("a:b".into())
        );
    }

    #[test]
    fn a_bad_scope_is_refused_with_the_script_message() {
        let message = "--scope must be userId:personaId:workspaceId; workspaceId may contain :";
        assert_eq!(parse_scope("u:p").unwrap_err(), message);
        assert_eq!(parse_scope(":p:w").unwrap_err(), message);
        assert_eq!(parse_scope("u p:p:w").unwrap_err(), message);
        assert_eq!(parse_scope("u:p:w w").unwrap_err(), message);
    }

    #[test]
    fn numbers_and_text_are_read_like_number_and_string() {
        assert_eq!(number_of(Some(&serde_json::json!("12"))), 12);
        assert_eq!(number_of(Some(&serde_json::json!(7))), 7);
        assert_eq!(number_of(None), 0);
        assert_eq!(text_of(Some(&serde_json::json!("abc"))), Some("abc".into()));
        assert_eq!(text_of(Some(&serde_json::Value::Null)), None);
    }
}
