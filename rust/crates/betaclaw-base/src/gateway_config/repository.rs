//! Port of `src/server/config/gateway/gatewayConfig.ts`.
//!
//! [`GatewayConfigStore::load`] and [`GatewayConfigStore::save`] cover both
//! backends of the TypeScript module. The SQLite schema, the `id = 1` singleton
//! row and the upsert statement are unchanged so both implementations can share
//! `.local/gateway-config.db` over the `app-data` volume.
//!
//! The TypeScript functions are `async` because of `node:fs/promises`. The Rust
//! port is synchronous: the only blocking work is one small file read/write plus
//! one SQLite statement, so the gateway route should call it from
//! `spawn_blocking` if the shared reactor latency budget requires it.

use serde_json::Value;

use crate::db::{open, OpenOptions};

use super::constants::{GATEWAY_CONFIG_DB_ROW_ID, GATEWAY_CONFIG_DB_TABLE_SQL};
use super::normalize::{clone_default_config, normalize_gateway_config};
use super::paths::{ensure_parent_dir, ConfigBackend, PathResolver};
use super::revision::compute_revision;
use super::secrets::restore_redacted_secrets;
use super::types::{
    GatewayConfigError, GatewayConfigSource, GatewayConfigState, GatewayConfigWarning,
    NormalizeMode,
};

/// Fixed message used when the stored row cannot be parsed. Matches
/// `gatewayConfig.ts:70` and `:115`.
const INVALID_JSON_MESSAGE: &str = "Gateway config row contains invalid JSON.";

/// Return value of [`GatewayConfigStore::save`], matching the object literal
/// returned by `saveGatewayConfig`.
#[derive(Debug, Clone)]
pub struct GatewayConfigSaveResult {
    pub config: Value,
    pub path: String,
    pub source: GatewayConfigSource,
    pub warnings: Vec<GatewayConfigWarning>,
    pub revision: String,
}

/// Backend-independent gateway config store.
#[derive(Debug, Clone)]
pub struct GatewayConfigStore {
    backend: ConfigBackend,
    config_path: String,
    db_path: String,
}

impl GatewayConfigStore {
    /// Builds the store from the process environment via [`PathResolver::from_env`].
    pub fn from_env() -> Self {
        let resolver = PathResolver::from_env();
        Self::new(
            resolver.resolve_backend(),
            resolver.resolve_config_path(),
            resolver.resolve_config_db_path(),
        )
    }

    pub fn new(
        backend: ConfigBackend,
        config_path: impl Into<String>,
        db_path: impl Into<String>,
    ) -> Self {
        Self {
            backend,
            config_path: config_path.into(),
            db_path: db_path.into(),
        }
    }

    /// A store backed by `gateway-config.db`, used by tests and by the default
    /// production wiring.
    pub fn for_db(db_path: impl Into<String>) -> Self {
        Self::new(ConfigBackend::Db, String::new(), db_path)
    }

    pub fn backend(&self) -> ConfigBackend {
        self.backend
    }

    pub fn db_path(&self) -> &str {
        &self.db_path
    }

    pub fn config_path(&self) -> &str {
        &self.config_path
    }

    /// `loadGatewayConfig` from `gatewayConfig.ts:45-119`.
    pub fn load(&self) -> Result<GatewayConfigState, GatewayConfigError> {
        match self.backend {
            ConfigBackend::Db => self.load_from_db(),
            ConfigBackend::File => self.load_from_file(),
        }
    }

    fn load_from_db(&self) -> Result<GatewayConfigState, GatewayConfigError> {
        let connection = open(OpenOptions::new(&self.db_path))?;
        connection.execute_batch(GATEWAY_CONFIG_DB_TABLE_SQL)?;

        let row: Option<String> = connection
            .query_row(
                "SELECT config_json FROM gateway_config_state WHERE id = ?1",
                [GATEWAY_CONFIG_DB_ROW_ID],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();

        match row.filter(|raw| !raw.is_empty()) {
            None => Ok(default_state(GatewayConfigSource::Default, &self.db_path)),
            Some(raw) => {
                let parsed: Value = serde_json::from_str(&raw)
                    .map_err(|_| GatewayConfigError::validation(INVALID_JSON_MESSAGE))?;
                let normalized = normalize_gateway_config(&parsed, NormalizeMode::Load)?;
                Ok(GatewayConfigState {
                    revision: compute_revision(&normalized.config),
                    config: normalized.config,
                    source: GatewayConfigSource::Db,
                    path: self.db_path.clone(),
                    warnings: normalized.warnings,
                })
            }
        }
    }

    fn load_from_file(&self) -> Result<GatewayConfigState, GatewayConfigError> {
        let raw = match std::fs::read_to_string(&self.config_path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(default_state(
                    GatewayConfigSource::Default,
                    &self.config_path,
                ));
            }
            Err(error) => return Err(GatewayConfigError::io(&self.config_path, error)),
        };

        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|_| GatewayConfigError::validation(INVALID_JSON_MESSAGE))?;
        let normalized = normalize_gateway_config(&parsed, NormalizeMode::Load)?;
        Ok(GatewayConfigState {
            revision: compute_revision(&normalized.config),
            config: normalized.config,
            source: GatewayConfigSource::File,
            path: self.config_path.clone(),
            warnings: normalized.warnings,
        })
    }

    /// `saveGatewayConfig` from `gatewayConfig.ts:121-208`.
    ///
    /// `expected_revision` is mandatory: an empty value raises
    /// [`GatewayConfigError::Conflict`], which is the stale-write guard the
    /// `app/api/config/route.ts` PUT handler relies on.
    pub fn save(
        &self,
        input: &Value,
        expected_revision: &str,
    ) -> Result<GatewayConfigSaveResult, GatewayConfigError> {
        match self.backend {
            ConfigBackend::Db => self.save_to_db(input, expected_revision),
            ConfigBackend::File => self.save_to_file(input, expected_revision),
        }
    }

    /// The revision a save would compare `expected_revision` against.
    pub fn current_revision(&self) -> Result<String, GatewayConfigError> {
        Ok(self.load()?.revision)
    }

    fn save_to_db(
        &self,
        input: &Value,
        expected_revision: &str,
    ) -> Result<GatewayConfigSaveResult, GatewayConfigError> {
        let connection = open(OpenOptions::new(&self.db_path))?;
        connection.execute_batch(GATEWAY_CONFIG_DB_TABLE_SQL)?;

        let row: Option<String> = connection
            .query_row(
                "SELECT config_json FROM gateway_config_state WHERE id = ?1",
                [GATEWAY_CONFIG_DB_ROW_ID],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();

        let current = match row.filter(|raw| !raw.is_empty()) {
            Some(raw) => {
                // Unlike `loadGatewayConfig`, the TypeScript source parses the
                // stored row here without a guard, so a JSON syntax error
                // surfaces as the raw parser message. The port keeps that.
                let parsed: Value = serde_json::from_str(&raw)
                    .map_err(|error| GatewayConfigError::validation(error.to_string()))?;
                normalize_gateway_config(&parsed, NormalizeMode::Load)?
            }
            None => normalize_gateway_config(&clone_default_config(), NormalizeMode::Load)?,
        };
        let current_revision = compute_revision(&current.config);

        let expected = expected_revision.trim();
        if expected.is_empty() || expected != current_revision {
            return Err(GatewayConfigError::conflict(current_revision));
        }

        let restored = restore_redacted_secrets(input, &current.config);
        let normalized = normalize_gateway_config(&restored, NormalizeMode::Save)?;
        let revision = compute_revision(&normalized.config);

        connection.execute(
            "INSERT INTO gateway_config_state (id, config_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
               config_json = excluded.config_json,
               updated_at = excluded.updated_at",
            rusqlite::params![
                GATEWAY_CONFIG_DB_ROW_ID,
                serde_json::to_string(&normalized.config)
                    .map_err(|error| GatewayConfigError::Json(error.to_string()))?,
                now_iso()
            ],
        )?;

        Ok(GatewayConfigSaveResult {
            config: normalized.config,
            path: self.db_path.clone(),
            source: GatewayConfigSource::Db,
            warnings: normalized.warnings,
            revision,
        })
    }

    fn save_to_file(
        &self,
        input: &Value,
        expected_revision: &str,
    ) -> Result<GatewayConfigSaveResult, GatewayConfigError> {
        let current = self.load_from_file()?;
        let expected = expected_revision.trim();
        if expected.is_empty() || expected != current.revision {
            return Err(GatewayConfigError::conflict(current.revision));
        }

        let restored = restore_redacted_secrets(input, &current.config);
        let normalized = normalize_gateway_config(&restored, NormalizeMode::Save)?;

        ensure_parent_dir(&self.config_path)
            .map_err(|error| GatewayConfigError::io(&self.config_path, error))?;
        create_backup_if_present(&self.config_path)?;

        let mut body = serde_json::to_string_pretty(&normalized.config)
            .map_err(|error| GatewayConfigError::Json(error.to_string()))?;
        body.push('\n');

        let temp_path = temp_path_for(&self.config_path);
        std::fs::write(&temp_path, body.as_bytes())
            .map_err(|error| GatewayConfigError::io(&temp_path, error))?;

        if let Err(error) = replace_file(&temp_path, &self.config_path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(GatewayConfigError::io(&self.config_path, error));
        }

        Ok(GatewayConfigSaveResult {
            revision: compute_revision(&normalized.config),
            config: normalized.config,
            path: self.config_path.clone(),
            source: GatewayConfigSource::File,
            warnings: normalized.warnings,
        })
    }
}

/// `default_state` — the three fields every "no stored config" branch of the
/// TypeScript module returns.
fn default_state(source: GatewayConfigSource, path: &str) -> GatewayConfigState {
    let normalized = normalize_gateway_config(&clone_default_config(), NormalizeMode::Load)
        .expect("the built-in default config is always valid");
    GatewayConfigState {
        revision: compute_revision(&normalized.config),
        config: normalized.config,
        source,
        path: path.to_string(),
        warnings: Vec::new(),
    }
}

/// `createBackupIfPresent` from `gatewayConfig.ts:28-43`.
fn create_backup_if_present(config_path: &str) -> Result<(), GatewayConfigError> {
    let backup_path = format!("{config_path}.bak");
    match std::fs::read_to_string(config_path) {
        Ok(current) => std::fs::write(&backup_path, current.as_bytes())
            .map_err(|error| GatewayConfigError::io(&backup_path, error)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(GatewayConfigError::io(config_path, error)),
    }
}

/// `gatewayConfig.ts:189` builds `<path>.<pid>.<millis>.<random>.tmp`.
fn temp_path_for(config_path: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("{config_path}.{millis}.{}.tmp", &random[..8])
}

/// `fs.rename` with a Windows fallback: `rename` fails with `ERROR_ALREADY_EXISTS`
/// when the destination exists on some Windows filesystems, whereas Node's
/// `fs.rename` replaces the destination.
fn replace_file(temp_path: &str, config_path: &str) -> std::io::Result<()> {
    match std::fs::rename(temp_path, config_path) {
        Ok(()) => Ok(()),
        Err(error) => {
            if !std::path::Path::new(config_path).exists() {
                return Err(error);
            }
            std::fs::remove_file(config_path)?;
            std::fs::rename(temp_path, config_path)
        }
    }
}

/// `new Date().toISOString()` — millisecond precision, always UTC, `Z` suffix.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway_config::normalize::clone_default_config;
    use crate::gateway_config::secrets::redact_gateway_config_secrets;
    use serde_json::json;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-s2-{label}-{unique}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn join(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn db_store(dir: &TempDir) -> GatewayConfigStore {
        GatewayConfigStore::for_db(dir.join("gateway-config.db"))
    }

    fn file_store(dir: &TempDir) -> GatewayConfigStore {
        GatewayConfigStore::new(
            ConfigBackend::File,
            dir.join("betaclaw.json"),
            dir.join("unused.db"),
        )
    }

    fn sample_config() -> Value {
        json!({
            "gateway": { "port": 8080, "host": "0.0.0.0", "bind": "all", "logLevel": "info" },
            "provider": { "primary": "gemini-3-flash-preview" }
        })
    }

    #[test]
    fn missing_db_is_created_and_yields_the_default_config() {
        let dir = TempDir::new("missing-db");
        let store = db_store(&dir);

        let state = store.load().expect("load creates the database");
        assert_eq!(state.source, GatewayConfigSource::Default);
        assert!(state.warnings.is_empty());
        assert_eq!(state.config, clone_default_config());
        assert_eq!(state.revision.len(), 16);
        assert_eq!(state.path, store.db_path());
        assert!(
            std::path::Path::new(&store.db_path()).exists(),
            "openSqliteDatabase creates the file"
        );
    }

    #[test]
    fn missing_file_backend_yields_the_default_config() {
        let dir = TempDir::new("missing-file");
        let state = file_store(&dir).load().expect("ENOENT falls back");
        assert_eq!(state.source, GatewayConfigSource::Default);
        assert_eq!(state.config["gateway"]["port"], 8080);
    }

    #[test]
    fn db_store_round_trips_a_saved_config() {
        let dir = TempDir::new("db-round-trip");
        let store = db_store(&dir);

        let first = store.load().expect("initial load");
        let saved = store
            .save(&sample_config(), &first.revision)
            .expect("save with the current revision");

        assert_eq!(saved.source, GatewayConfigSource::Db);
        assert_eq!(
            saved.config["provider"]["primary"],
            "gemini-3-flash-preview"
        );
        assert_ne!(saved.revision, first.revision);

        let reloaded = store.load().expect("reload");
        assert_eq!(reloaded.source, GatewayConfigSource::Db);
        assert_eq!(reloaded.config, saved.config);
        assert_eq!(reloaded.revision, saved.revision);
    }

    #[test]
    fn file_store_round_trips_a_saved_config_and_writes_a_backup() {
        let dir = TempDir::new("file-round-trip");
        let store = file_store(&dir);

        let first = store.load().expect("initial load");
        let saved = store
            .save(&sample_config(), &first.revision)
            .expect("first save");

        let second = store.load().expect("reload after first save");
        assert_eq!(second.source, GatewayConfigSource::File);
        assert_eq!(second.revision, saved.revision);
        assert!(
            !std::path::Path::new(&format!("{}.bak", store.config_path())).exists(),
            "there was nothing to back up on the very first save"
        );

        let saved = store
            .save(&json!({ "gateway": { "port": 9090 } }), &second.revision)
            .expect("second save");
        assert!(
            std::path::Path::new(&format!("{}.bak", store.config_path())).exists(),
            "the second save backs up the file it is about to replace"
        );
        let third = store.load().expect("reload after second save");
        assert_eq!(third.config["gateway"]["port"], 9090);
        assert_eq!(third.revision, saved.revision);

        let body = std::fs::read_to_string(store.config_path()).expect("read file");
        assert!(
            body.ends_with('\n'),
            "the TypeScript writer appends a newline"
        );
        assert!(
            body.contains("\n  \"gateway\""),
            "written with 2-space indent"
        );
    }

    #[test]
    fn rejects_a_stale_revision_on_both_backends() {
        for label in ["db", "file"] {
            let dir = TempDir::new(&format!("stale-{label}"));
            let store = if label == "db" {
                db_store(&dir)
            } else {
                file_store(&dir)
            };
            let first = store.load().expect("initial load");
            let saved = store.save(&sample_config(), &first.revision).expect("save");

            // Replaying the pre-save revision must fail, and the error has to carry
            // the revision the caller must reload with.
            match store.save(&json!({ "gateway": { "port": 1 } }), &first.revision) {
                Err(GatewayConfigError::Conflict {
                    current_revision, ..
                }) => {
                    assert_eq!(current_revision, saved.revision, "backend {label}");
                }
                other => panic!("expected a conflict for {label}, got {other:?}"),
            }
        }
    }

    #[test]
    fn rejects_a_missing_expected_revision() {
        let dir = TempDir::new("no-revision");
        let store = db_store(&dir);
        match store.save(&sample_config(), "   ") {
            Err(GatewayConfigError::Conflict {
                current_revision, ..
            }) => {
                assert_eq!(current_revision.len(), 16);
            }
            other => panic!("expected a conflict, got {other:?}"),
        }
    }

    #[test]
    fn preserves_redacted_secrets_across_a_save() {
        let dir = TempDir::new("secrets");
        let store = db_store(&dir);

        let mut stored = clone_default_config();
        stored["channels"]["telegram"]["token"] = json!("super-secret");
        let first = store.load().expect("load defaults");
        let saved = store.save(&stored, &first.revision).expect("save secret");
        assert_eq!(
            saved.config["channels"]["telegram"]["token"],
            "super-secret"
        );

        let redacted = redact_gateway_config_secrets(&saved.config);
        assert_eq!(redacted["channels"]["telegram"]["token"], "__REDACTED__");

        let resaved = store
            .save(&redacted, &saved.revision)
            .expect("save redacted");
        assert_eq!(
            resaved.config["channels"]["telegram"]["token"], "super-secret",
            "the placeholder must not overwrite the stored token"
        );
    }

    #[test]
    fn rejects_an_invalid_stored_row_on_load() {
        let dir = TempDir::new("invalid-row");
        let store = db_store(&dir);
        {
            let connection = open(OpenOptions::new(store.db_path())).expect("open");
            connection
                .execute_batch(GATEWAY_CONFIG_DB_TABLE_SQL)
                .expect("create table");
            connection
                .execute(
                    "INSERT INTO gateway_config_state (id, config_json, updated_at) VALUES (1, '{oops', 't')",
                    [],
                )
                .expect("insert broken row");
        }
        match store.load() {
            Err(GatewayConfigError::Validation(message)) => {
                assert_eq!(message, INVALID_JSON_MESSAGE)
            }
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[test]
    fn rejects_an_invalid_config_file() {
        let dir = TempDir::new("invalid-file");
        let store = file_store(&dir);
        std::fs::write(store.config_path(), "{ not json").expect("write broken file");
        match store.load() {
            Err(GatewayConfigError::Validation(message)) => {
                assert_eq!(message, INVALID_JSON_MESSAGE)
            }
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[test]
    fn save_mode_rejects_values_that_load_mode_repairs() {
        let dir = TempDir::new("save-validation");
        let store = db_store(&dir);
        let first = store.load().expect("initial load");

        let invalid = json!({
            "gateway": { "port": 8080, "host": "0.0.0.0", "bind": "all", "logLevel": "info" },
            "ui": { "density": "cozy" }
        });
        assert!(matches!(
            store.save(&invalid, &first.revision),
            Err(GatewayConfigError::Validation(_))
        ));
    }

    #[test]
    fn migration_is_fresh_on_repeated_opens() {
        let dir = TempDir::new("migration");
        let store = db_store(&dir);
        store.load().expect("first open creates the table");

        let connection = open(OpenOptions::new(store.db_path())).expect("inspect");
        let tables: Vec<String> = connection
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .expect("prepare")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows");
        assert_eq!(tables, vec!["gateway_config_state"], "no bookkeeping table");
        let columns: Vec<String> = connection
            .prepare("PRAGMA table_info(gateway_config_state)")
            .expect("prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows");
        assert_eq!(columns, vec!["id", "config_json", "updated_at"]);

        // A second open must not fail and must not duplicate anything.
        let reopened = db_store(&dir);
        assert_eq!(
            reopened.load().expect("second open").source,
            GatewayConfigSource::Default
        );
        assert_eq!(reopened.current_revision().expect("revision").len(), 16);
    }

    #[test]
    fn wal_and_busy_timeout_come_from_the_shared_opener() {
        let dir = TempDir::new("pragmas");
        let store = db_store(&dir);
        store.load().expect("load");

        let connection = open(OpenOptions::new(store.db_path())).expect("reopen");
        let busy_timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy_timeout");
        assert_eq!(busy_timeout, 30_000);
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal_mode");
        assert_eq!(journal_mode, "wal");
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys");
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn updated_at_is_written_on_every_save() {
        let dir = TempDir::new("updated-at");
        let store = db_store(&dir);
        let first = store.load().expect("load");
        store.save(&sample_config(), &first.revision).expect("save");

        let connection = open(OpenOptions::new(store.db_path())).expect("open");
        let stamp: String = connection
            .query_row(
                "SELECT updated_at FROM gateway_config_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("row");
        assert_eq!(
            stamp.len(),
            24,
            "ISO-8601 with millis and a Z suffix: {stamp}"
        );
        assert!(stamp.ends_with('Z'));
    }

    #[test]
    fn a_second_save_overwrites_the_singleton_row() {
        let dir = TempDir::new("upsert");
        let store = db_store(&dir);
        let first = store.load().expect("load");
        let saved = store.save(&sample_config(), &first.revision).expect("save");
        store
            .save(
                &json!({ "gateway": { "port": 4242, "host": "127.0.0.1" } }),
                &saved.revision,
            )
            .expect("second save");

        let connection = open(OpenOptions::new(store.db_path())).expect("open");
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM gateway_config_state", [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(rows, 1, "ON CONFLICT must upsert, not append");
        assert_eq!(
            store.load().expect("reload").config["gateway"]["port"],
            4242
        );
    }
}
