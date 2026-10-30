//! Port of `src/server/skills/runtimeConfig.ts`.
//!
//! Table `skill_runtime_config`, same DDL as TypeScript. A value saved in the store wins
//! over the environment. Secrets are masked with `model_hub::crypto::mask_secret`, the
//! port of `maskSecret`. Text values show their first and last four characters when they
//! are longer than eight.
//!
//! Deviations:
//! - No process-wide singleton (`getSkillRuntimeConfigStore`). The store is an argument.
//! - The environment is passed as a map. TypeScript reads `process.env`.
//! - Text masking counts Unicode scalar values. TypeScript counts UTF-16 code units, so
//!   the two differ only for characters outside the Basic Multilingual Plane.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};

use super::store::sql_error;
use super::types::{js_trim, lock_unpoisoned, SkillError};
use crate::db::{self, OpenOptions};
use crate::model_hub::crypto::mask_secret;
use crate::stats::util::now_iso;

/// `ConfigValueKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigValueKind {
    Secret,
    Text,
}

/// Where the effective value comes from. `None` in a status means nothing is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigSource {
    Store,
    Env,
}

/// `SkillRuntimeConfigField`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRuntimeConfigField {
    pub id: &'static str,
    pub skill_id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub kind: ConfigValueKind,
    pub required: bool,
    /// Checked in order; the first non-blank value wins.
    pub env_vars: &'static [&'static str],
}

/// `SKILL_RUNTIME_CONFIG_FIELDS`.
pub const SKILL_RUNTIME_CONFIG_FIELDS: &[SkillRuntimeConfigField] = &[
    SkillRuntimeConfigField {
        id: "vision.gemini_api_key",
        skill_id: "vision",
        label: "Vision (Gemini) API Key",
        description: "Required for image analysis in the Vision skill.",
        kind: ConfigValueKind::Secret,
        required: true,
        env_vars: &["GEMINI_API_KEY", "API_KEY"],
    },
    SkillRuntimeConfigField {
        id: "github-manager.github_token",
        skill_id: "github-manager",
        label: "GitHub Token",
        description: "Optional. Increases API limits and allows private repository access.",
        kind: ConfigValueKind::Secret,
        required: false,
        env_vars: &["GITHUB_TOKEN"],
    },
    SkillRuntimeConfigField {
        id: "sql-bridge.sqlite_db_path",
        skill_id: "sql-bridge",
        label: "SQLite Database Path",
        description: "Required for SQL Bridge queries (workspace-relative path).",
        kind: ConfigValueKind::Text,
        required: true,
        env_vars: &["SQLITE_DB_PATH"],
    },
];

/// `SkillRuntimeConfigStatus`: the field plus what is configured for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRuntimeConfigStatus {
    pub field: &'static SkillRuntimeConfigField,
    pub configured: bool,
    pub source: Option<ConfigSource>,
    pub masked_value: Option<String>,
    /// Set only when the value comes from the store.
    pub updated_at: Option<String>,
}

/// A row of `skill_runtime_config`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredConfigValue {
    pub id: String,
    pub value: String,
    pub updated_at: String,
}

fn field_by_id(id: &str) -> Result<&'static SkillRuntimeConfigField, SkillError> {
    SKILL_RUNTIME_CONFIG_FIELDS
        .iter()
        .find(|field| field.id == id)
        .ok_or_else(|| SkillError(format!("Unsupported runtime config id: {id}")))
}

fn trimmed(value: Option<String>) -> String {
    js_trim(&value.unwrap_or_default()).to_string()
}

fn mask_value(kind: ConfigValueKind, value: &str) -> String {
    match kind {
        ConfigValueKind::Secret => mask_secret(value),
        ConfigValueKind::Text => {
            let chars: Vec<char> = value.chars().collect();
            if chars.len() <= 8 {
                value.to_string()
            } else {
                let head: String = chars[..4].iter().collect();
                let tail: String = chars[chars.len() - 4..].iter().collect();
                format!("{head}...{tail}")
            }
        }
    }
}

/// `readEnvValue`: the first trimmed, non-empty variable of the field.
fn read_env_value(
    field: &SkillRuntimeConfigField,
    env: &HashMap<String, String>,
) -> Option<String> {
    field
        .env_vars
        .iter()
        .filter_map(|key| env.get(*key))
        .map(|value| js_trim(value))
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

/// `SkillRuntimeConfigStore`.
pub struct SkillRuntimeConfigStore {
    connection: Mutex<Connection>,
}

impl SkillRuntimeConfigStore {
    /// Opens or creates the database at `db_path`. The skills store may share the file.
    pub fn open(db_path: &str) -> Result<Self, SkillError> {
        let connection = db::open(OpenOptions::new(db_path)).map_err(sql_error)?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS skill_runtime_config (
                   id TEXT PRIMARY KEY,
                   value TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );",
            )
            .map_err(sql_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// A private in-memory database, for tests.
    pub fn in_memory() -> Result<Self, SkillError> {
        Self::open(":memory:")
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        lock_unpoisoned(&self.connection)
    }

    /// `setValue`. The value is trimmed; a blank value is refused.
    pub fn set_value(&self, id: &str, value: &str) -> Result<(), SkillError> {
        field_by_id(id)?;
        let normalized = js_trim(value);
        if normalized.is_empty() {
            return Err(SkillError(
                "Runtime config value cannot be empty.".to_string(),
            ));
        }
        self.lock()
            .execute(
                "INSERT INTO skill_runtime_config (id, value, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![id, normalized, now_iso()],
            )
            .map_err(sql_error)?;
        Ok(())
    }

    /// `deleteValue`.
    pub fn delete_value(&self, id: &str) -> Result<(), SkillError> {
        field_by_id(id)?;
        self.lock()
            .execute("DELETE FROM skill_runtime_config WHERE id = ?", params![id])
            .map_err(sql_error)?;
        Ok(())
    }

    /// `getValue`. The stored text as written, or `None`.
    pub fn get_value(&self, id: &str) -> Result<Option<String>, SkillError> {
        field_by_id(id)?;
        self.lock()
            .query_row(
                "SELECT value FROM skill_runtime_config WHERE id = ?",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sql_error)
    }

    /// `getUpdatedAt`.
    pub fn get_updated_at(&self, id: &str) -> Result<Option<String>, SkillError> {
        field_by_id(id)?;
        self.lock()
            .query_row(
                "SELECT updated_at FROM skill_runtime_config WHERE id = ?",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sql_error)
    }

    /// `list`, ordered by id.
    pub fn list(&self) -> Result<Vec<StoredConfigValue>, SkillError> {
        let connection = self.lock();
        let mut statement = connection
            .prepare("SELECT id, value, updated_at FROM skill_runtime_config ORDER BY id")
            .map_err(sql_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(StoredConfigValue {
                    id: row.get(0)?,
                    value: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })
            .map_err(sql_error)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)
    }
}

/// `getRuntimeConfigValue`: the stored value when it is non-blank, else the environment.
pub fn get_runtime_config_value(
    store: &SkillRuntimeConfigStore,
    env: &HashMap<String, String>,
    id: &str,
) -> Result<Option<String>, SkillError> {
    let field = field_by_id(id)?;
    let stored = trimmed(store.get_value(field.id)?);
    if !stored.is_empty() {
        return Ok(Some(stored));
    }
    Ok(read_env_value(field, env))
}

/// `resolveSkillRuntimeConfigStatus`, one entry per known field.
pub fn resolve_skill_runtime_config_status(
    store: &SkillRuntimeConfigStore,
    env: &HashMap<String, String>,
) -> Result<Vec<SkillRuntimeConfigStatus>, SkillError> {
    SKILL_RUNTIME_CONFIG_FIELDS
        .iter()
        .map(|field| -> Result<SkillRuntimeConfigStatus, SkillError> {
            let stored = trimmed(store.get_value(field.id)?);
            let env_value = read_env_value(field, env);
            let (source, effective) = if !stored.is_empty() {
                (Some(ConfigSource::Store), stored)
            } else if let Some(value) = env_value {
                (Some(ConfigSource::Env), value)
            } else {
                (None, String::new())
            };
            let updated_at = match source {
                Some(ConfigSource::Store) => store.get_updated_at(field.id)?,
                _ => None,
            };
            let configured = !effective.is_empty();
            Ok(SkillRuntimeConfigStatus {
                field,
                configured,
                source,
                masked_value: configured.then(|| mask_value(field.kind, &effective)),
                updated_at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SkillRuntimeConfigStore {
        SkillRuntimeConfigStore::in_memory().expect("open in-memory store")
    }

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn status_of<'a>(
        statuses: &'a [SkillRuntimeConfigStatus],
        id: &str,
    ) -> &'a SkillRuntimeConfigStatus {
        statuses
            .iter()
            .find(|status| status.field.id == id)
            .expect("known field")
    }

    #[test]
    fn set_trims_and_refuses_blank_values() {
        let store = store();
        store
            .set_value("sql-bridge.sqlite_db_path", "  data/app.db  ")
            .expect("set");
        assert_eq!(
            store
                .get_value("sql-bridge.sqlite_db_path")
                .expect("get")
                .as_deref(),
            Some("data/app.db")
        );
        let error = store
            .set_value("sql-bridge.sqlite_db_path", "   ")
            .expect_err("blank");
        assert_eq!(error.0, "Runtime config value cannot be empty.");
    }

    #[test]
    fn unknown_ids_are_refused() {
        let store = store();
        let error = store.get_value("nope").expect_err("unknown");
        assert_eq!(error.0, "Unsupported runtime config id: nope");
        assert!(store.set_value("nope", "x").is_err());
        assert!(store.delete_value("nope").is_err());
    }

    #[test]
    fn stored_value_wins_over_the_environment() {
        let store = store();
        store
            .set_value("github-manager.github_token", "ghp_stored")
            .expect("set");
        let value = get_runtime_config_value(
            &store,
            &env(&[("GITHUB_TOKEN", "ghp_env")]),
            "github-manager.github_token",
        )
        .expect("resolve");
        assert_eq!(value.as_deref(), Some("ghp_stored"));
    }

    #[test]
    fn environment_is_the_fallback_and_blank_variables_are_skipped() {
        let store = store();
        let vars = env(&[("GEMINI_API_KEY", "   "), ("API_KEY", " key-from-api ")]);
        let value = get_runtime_config_value(&store, &vars, "vision.gemini_api_key").expect("ok");
        assert_eq!(value.as_deref(), Some("key-from-api"));

        let none =
            get_runtime_config_value(&store, &HashMap::new(), "vision.gemini_api_key").expect("ok");
        assert_eq!(none, None);
    }

    #[test]
    fn blank_stored_value_falls_back_to_the_environment() {
        let store = store();
        store
            .lock()
            .execute(
                "INSERT INTO skill_runtime_config (id, value, updated_at)
                 VALUES ('github-manager.github_token', '   ', 'x')",
                [],
            )
            .expect("insert blank");
        let value = get_runtime_config_value(
            &store,
            &env(&[("GITHUB_TOKEN", "ghp_env")]),
            "github-manager.github_token",
        )
        .expect("resolve");
        assert_eq!(value.as_deref(), Some("ghp_env"));
    }

    #[test]
    fn status_masks_secrets_and_partially_shows_text() {
        let store = store();
        store
            .set_value("vision.gemini_api_key", "sk-1234567890")
            .expect("set secret");
        store
            .set_value("sql-bridge.sqlite_db_path", "/data/app.sqlite")
            .expect("set text");

        let statuses =
            resolve_skill_runtime_config_status(&store, &HashMap::new()).expect("status");
        assert_eq!(statuses.len(), 3);

        let vision = status_of(&statuses, "vision.gemini_api_key");
        assert!(vision.configured);
        assert_eq!(vision.source, Some(ConfigSource::Store));
        assert_eq!(vision.masked_value.as_deref(), Some("*********7890"));
        assert!(vision.updated_at.is_some());

        let sql = status_of(&statuses, "sql-bridge.sqlite_db_path");
        assert_eq!(sql.masked_value.as_deref(), Some("/dat...lite"));

        let github = status_of(&statuses, "github-manager.github_token");
        assert!(!github.configured);
        assert_eq!(github.source, None);
        assert_eq!(github.masked_value, None);
        assert_eq!(github.updated_at, None);
    }

    #[test]
    fn secret_status_never_contains_the_clear_value() {
        let store = store();
        store
            .set_value("github-manager.github_token", "ghp_abcdef1234567890")
            .expect("set");
        let statuses =
            resolve_skill_runtime_config_status(&store, &HashMap::new()).expect("status");
        let masked = status_of(&statuses, "github-manager.github_token")
            .masked_value
            .clone()
            .expect("masked");
        // 20 characters: length minus four stars, then the last four characters.
        assert_eq!(masked, format!("{}7890", "*".repeat(16)));
        assert!(!masked.contains("abcdef"));
    }

    #[test]
    fn environment_source_has_no_update_time_and_short_text_is_shown_whole() {
        let store = store();
        let statuses =
            resolve_skill_runtime_config_status(&store, &env(&[("SQLITE_DB_PATH", "x.db")]))
                .expect("status");
        let sql = status_of(&statuses, "sql-bridge.sqlite_db_path");
        assert_eq!(sql.source, Some(ConfigSource::Env));
        assert_eq!(sql.masked_value.as_deref(), Some("x.db"));
        assert_eq!(sql.updated_at, None);
    }
}
