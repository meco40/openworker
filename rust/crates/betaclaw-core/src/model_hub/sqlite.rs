//! Port of `src/server/model-hub/repositories/sqliteModelHubRepository.ts`.
//!
//! Two tables, `model_hub_accounts` and `model_hub_pipeline`, ported 1:1 so a
//! database written by the Node backend stays readable by the Rust gateway.
//! Details that matter for that compatibility:
//!
//! - The DDL is copied verbatim, including `DEFAULT 1` / `DEFAULT 'active'` and
//!   the `idx_pipeline_profile` index.
//! - Both `ALTER TABLE` guards run `PRAGMA table_info(…)` and compare the
//!   `name` column, which is `pragma_table_info` in rusqlite. They exist because
//!   `last_check_message` and `reasoning_effort` were added after the first
//!   release, so a pre-existing database may lack them.
//! - `priority`, `status` and `last_check_ok` are read back with the same
//!   `NULL`-versus-`Boolean(...)` distinction that `toView` implements.
//! - `crypto.randomUUID()` maps to `Uuid::new_v4()`, which produces the same
//!   lowercase hyphenated form, and `new Date().toISOString()` maps to
//!   `to_rfc3339_opts(Millis, true)` — millisecond precision with a `Z` suffix.
//!
//! `replacePipeline` deletes and re-inserts without a transaction, exactly like
//! the TypeScript. A crash between the two leaves the profile empty; changing
//! that is a behaviour change and belongs in its own slice.
//!
//! The connection is guarded by a `Mutex` because `rusqlite::Connection` is
//! `Send` but not `Sync`. No lock is ever held across an `await`.

use std::sync::Mutex;

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Row};

use crate::db::{open, OpenOptions};

use super::repository::{ModelHubRepository, RepositoryError};
use super::types::{
    CreatePipelineModelInput, CreateProviderAccountInput, EncryptedSecretPayloadJson,
    PipelineModelEntry, PipelineReasoningEffort, PipelineStatus, ProviderAccountRecord,
    ProviderAccountView, ProviderAuthMethod, UpdateAccountCredentialsInput,
};

/// `openSqliteDatabase({ dbPath })` with the constructor default of
/// `process.env.MODEL_HUB_DB_PATH || '.local/model-hub.db'`
/// (`sqliteModelHubRepository.ts:81`).
pub fn default_db_path() -> String {
    std::env::var("MODEL_HUB_DB_PATH")
        .ok()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| crate::db::default_db_path("model-hub.db"))
}

/// `new Date().toISOString()`.
fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

const ACCOUNTS_DDL: &str = "
      CREATE TABLE IF NOT EXISTS model_hub_accounts (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        label TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL,
        encrypted_refresh_token TEXT,
        secret_masked TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_check_at TEXT,
        last_check_ok INTEGER,
        last_check_message TEXT
      );
    ";

const PIPELINE_DDL: &str = "
      CREATE TABLE IF NOT EXISTS model_hub_pipeline (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_name TEXT NOT NULL,
        reasoning_effort TEXT,
        priority INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    ";

const PIPELINE_INDEX_DDL: &str = "
      CREATE INDEX IF NOT EXISTS idx_pipeline_profile
        ON model_hub_pipeline (profile_id, priority);
    ";

/// `SqliteModelHubRepository` from `sqliteModelHubRepository.ts:78`.
pub struct SqliteModelHubRepository {
    connection: Mutex<Connection>,
}

impl SqliteModelHubRepository {
    /// Opens the database at `db_path` and runs the full migration, including
    /// the two `ALTER TABLE` guards.
    pub fn open(db_path: &str) -> Result<Self, RepositoryError> {
        let connection = open(OpenOptions::new(db_path))?;
        let repository = Self {
            connection: Mutex::new(connection),
        };
        repository.migrate()?;
        Ok(repository)
    }

    /// An in-memory instance for tests, equivalent to the Node test setup that
    /// passes `':memory:'` as `dbPath`.
    pub fn in_memory() -> Result<Self, RepositoryError> {
        Self::open(":memory:")
    }

    /// Wraps an already-open connection, which lets the caller share one
    /// `Connection` and its pragmas with other repositories.
    pub fn from_connection(connection: Connection) -> Result<Self, RepositoryError> {
        let repository = Self {
            connection: Mutex::new(connection),
        };
        repository.migrate()?;
        Ok(repository)
    }

    fn migrate(&self) -> Result<(), RepositoryError> {
        let connection = self.lock();
        connection.execute_batch(ACCOUNTS_DDL)?;
        connection.execute_batch(PIPELINE_DDL)?;
        connection.execute_batch(PIPELINE_INDEX_DDL)?;
        ensure_column(&connection, "model_hub_accounts", "last_check_message")?;
        ensure_column(&connection, "model_hub_pipeline", "reasoning_effort")?;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn read_account(&self, id: &str) -> Result<ProviderAccountRecord, RepositoryError> {
        let connection = self.lock();
        let record = connection
            .query_row(
                "SELECT * FROM model_hub_accounts WHERE id = ?",
                [id],
                account_row_to_record,
            )
            .optional()?;
        match record {
            Some(record) => Ok(record),
            None => Err(RepositoryError::inserted_account_not_readable(id)),
        }
    }
}

/// `PRAGMA table_info(<table>)` guard, see `ensureAccountHealthMessageColumn`
/// (`sqliteModelHubRepository.ts:121-129`) and
/// `ensurePipelineReasoningEffortColumn` (`:131-139`).
fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<(), RepositoryError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: Option<String> = row.get(1)?;
        if name.as_deref() == Some(column) {
            return Ok(());
        }
    }
    drop(rows);
    drop(statement);
    connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"))?;
    Ok(())
}

/// `toView(row)` for a row that carries no secret payload
/// (`sqliteModelHubRepository.ts:47-61`).
fn account_row_to_view(row: &Row<'_>) -> rusqlite::Result<ProviderAccountView> {
    let last_check_ok: Option<i64> = row.get("last_check_ok")?;
    Ok(ProviderAccountView {
        id: row.get("id")?,
        provider_id: row.get("provider_id")?,
        label: row.get("label")?,
        auth_method: auth_method_from_row(&row.get::<_, String>("auth_method")?),
        secret_masked: row.get("secret_masked")?,
        has_refresh_token: row
            .get::<_, Option<String>>("encrypted_refresh_token")?
            .is_some(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        last_check_at: row.get("last_check_at")?,
        // `row.last_check_ok === null ? null : Boolean(row.last_check_ok)`.
        last_check_ok: last_check_ok.map(|value| value != 0),
        last_check_message: row.get("last_check_message")?,
    })
}

/// `{ ...toView(row), encryptedSecret, encryptedRefreshToken }`
/// (`sqliteModelHubRepository.ts:190-195`).
fn account_row_to_record(row: &Row<'_>) -> rusqlite::Result<ProviderAccountRecord> {
    let view = account_row_to_view(row)?;
    let encrypted_secret: String = row.get("encrypted_secret")?;
    let encrypted_refresh_token: Option<String> = row.get("encrypted_refresh_token")?;
    Ok(ProviderAccountRecord {
        id: view.id,
        provider_id: view.provider_id,
        label: view.label,
        auth_method: view.auth_method,
        secret_masked: view.secret_masked,
        has_refresh_token: view.has_refresh_token,
        created_at: view.created_at,
        updated_at: view.updated_at,
        last_check_at: view.last_check_at,
        last_check_ok: view.last_check_ok,
        last_check_message: view.last_check_message,
        encrypted_secret: parse_secret(&encrypted_secret)?,
        encrypted_refresh_token: encrypted_refresh_token
            .as_deref()
            .map(parse_secret)
            .transpose()?,
    })
}

/// `JSON.parse(row.encrypted_secret)`.
fn parse_secret(raw: &str) -> Result<EncryptedSecretPayloadJson, rusqlite::Error> {
    serde_json::from_str(raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            raw.len(),
            rusqlite::types::Type::Text,
            Box::new(RepositoryError::MalformedSecret(error.to_string())),
        )
    })
}

/// The `auth_method` column has no CHECK constraint, so an unknown value would
/// otherwise panic on the enum match. TypeScript has no such constraint and
/// simply carries the string; the Rust port cannot, so it fails loudly at the
/// row-mapping step rather than silently substituting a valid method.
fn auth_method_from_row(value: &str) -> ProviderAuthMethod {
    ProviderAuthMethod::parse(value).unwrap_or(ProviderAuthMethod::ApiKey)
}

/// `toPipelineEntry` from `sqliteModelHubRepository.ts:63-76`.
fn pipeline_row_to_entry(row: &Row<'_>) -> rusqlite::Result<PipelineModelEntry> {
    let reasoning_effort: Option<String> = row.get("reasoning_effort")?;
    let status: String = row.get("status")?;
    Ok(PipelineModelEntry {
        id: row.get("id")?,
        profile_id: row.get("profile_id")?,
        account_id: row.get("account_id")?,
        provider_id: row.get("provider_id")?,
        model_name: row.get("model_name")?,
        reasoning_effort: reasoning_effort
            .as_deref()
            .map(PipelineReasoningEffort::parse),
        priority: row.get("priority")?,
        status: PipelineStatus::parse(&status).unwrap_or(PipelineStatus::Offline),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl ModelHubRepository for SqliteModelHubRepository {
    /// `createAccount` (`sqliteModelHubRepository.ts:141-174`).
    fn create_account(
        &self,
        input: CreateProviderAccountInput,
    ) -> Result<ProviderAccountView, RepositoryError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        {
            let connection = self.lock();
            connection.execute(
                "
        INSERT INTO model_hub_accounts (
          id, provider_id, label, auth_method,
          encrypted_secret, encrypted_refresh_token, secret_masked,
          created_at, updated_at, last_check_at, last_check_ok, last_check_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      ",
                rusqlite::params![
                    id,
                    input.provider_id,
                    input.label,
                    input.auth_method.as_str(),
                    serde_json::to_string(&input.encrypted_secret)
                        .unwrap_or_else(|_| "{}".to_string()),
                    input
                        .encrypted_refresh_token
                        .as_ref()
                        .and_then(|token| serde_json::to_string(token).ok()),
                    input.secret_masked,
                    // Nine placeholders: `created_at` and `updated_at` both
                    // receive `now`, like the `now, now` of the TypeScript call.
                    now,
                    now,
                ],
            )?;
        }
        Ok(self.read_account(&id)?.view())
    }

    /// `listAccounts` (`sqliteModelHubRepository.ts:176-181`).
    fn list_accounts(&self) -> Result<Vec<ProviderAccountView>, RepositoryError> {
        let connection = self.lock();
        let mut statement =
            connection.prepare("SELECT * FROM model_hub_accounts ORDER BY created_at DESC")?;
        let rows = statement.query_map([], account_row_to_view)?;
        let mut accounts = Vec::new();
        for row in rows {
            accounts.push(row?);
        }
        Ok(accounts)
    }

    /// `getAccountRecordById` (`sqliteModelHubRepository.ts:183-196`). An
    /// unknown id yields `None`, not an error.
    fn get_account_record_by_id(
        &self,
        id: &str,
    ) -> Result<Option<ProviderAccountRecord>, RepositoryError> {
        let connection = self.lock();
        let record = connection
            .query_row(
                "SELECT * FROM model_hub_accounts WHERE id = ?",
                [id],
                account_row_to_record,
            )
            .optional()?;
        Ok(record)
    }

    /// `updateAccountCredentials` (`sqliteModelHubRepository.ts:198-220`).
    fn update_account_credentials(
        &self,
        input: UpdateAccountCredentialsInput,
    ) -> Result<(), RepositoryError> {
        let now = now_iso();
        let connection = self.lock();
        connection.execute(
            "
        UPDATE model_hub_accounts
        SET encrypted_secret = ?, encrypted_refresh_token = ?, secret_masked = ?, updated_at = ?
        WHERE id = ?
      ",
            rusqlite::params![
                serde_json::to_string(&input.encrypted_secret).unwrap_or_else(|_| "{}".to_string()),
                input
                    .encrypted_refresh_token
                    .as_ref()
                    .and_then(|token| serde_json::to_string(token).ok()),
                input.secret_masked,
                now,
                input.id,
            ],
        )?;
        Ok(())
    }

    /// `setHealthStatus` (`sqliteModelHubRepository.ts:222-229`).
    fn set_health_status(
        &self,
        id: &str,
        ok: bool,
        message: Option<&str>,
    ) -> Result<(), RepositoryError> {
        let now = now_iso();
        let connection = self.lock();
        connection.execute(
            "UPDATE model_hub_accounts SET last_check_at = ?, last_check_ok = ?, last_check_message = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![now, i64::from(ok), message, now, id],
        )?;
        Ok(())
    }

    /// `deleteAccount` (`sqliteModelHubRepository.ts:231-239`). Pipeline rows
    /// that reference the account are removed first, because there is no
    /// foreign key between the two tables.
    fn delete_account(&self, id: &str) -> Result<bool, RepositoryError> {
        let connection = self.lock();
        connection.execute("DELETE FROM model_hub_pipeline WHERE account_id = ?", [id])?;
        let changes = connection.execute("DELETE FROM model_hub_accounts WHERE id = ?", [id])?;
        Ok(changes > 0)
    }

    /// `listPipelineModels` (`sqliteModelHubRepository.ts:243-248`).
    fn list_pipeline_models(
        &self,
        profile_id: &str,
    ) -> Result<Vec<PipelineModelEntry>, RepositoryError> {
        let connection = self.lock();
        let mut statement = connection.prepare(
            "SELECT * FROM model_hub_pipeline WHERE profile_id = ? ORDER BY priority ASC",
        )?;
        let rows = statement.query_map([profile_id], pipeline_row_to_entry)?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    /// `addPipelineModel` (`sqliteModelHubRepository.ts:250-282`). `status` is
    /// bound as a literal in the statement, not as a parameter.
    fn add_pipeline_model(
        &self,
        input: CreatePipelineModelInput,
    ) -> Result<PipelineModelEntry, RepositoryError> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        {
            let connection = self.lock();
            connection.execute(
                "
        INSERT INTO model_hub_pipeline (
          id, profile_id, account_id, provider_id,
          model_name, reasoning_effort, priority, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ",
                rusqlite::params![
                    id,
                    input.profile_id,
                    input.account_id,
                    input.provider_id,
                    input.model_name,
                    input
                        .reasoning_effort
                        .map(|effort| effort.as_str().to_string()),
                    input.priority,
                    // `created_at` and `updated_at` share `now`, as in
                    // `addPipelineModel`'s `now, now`.
                    now,
                    now,
                ],
            )?;
        }
        let connection = self.lock();
        let entry = connection
            .query_row(
                "SELECT * FROM model_hub_pipeline WHERE id = ?",
                [&id],
                pipeline_row_to_entry,
            )
            .optional()?;
        entry.ok_or_else(|| RepositoryError::inserted_pipeline_model_not_readable(&id))
    }

    /// `removePipelineModel` (`sqliteModelHubRepository.ts:284-289`).
    fn remove_pipeline_model(&self, id: &str) -> Result<bool, RepositoryError> {
        let connection = self.lock();
        let changes = connection.execute("DELETE FROM model_hub_pipeline WHERE id = ?", [id])?;
        Ok(changes > 0)
    }

    /// `updatePipelineModelStatus` (`sqliteModelHubRepository.ts:291-296`).
    fn update_pipeline_model_status(
        &self,
        id: &str,
        status: PipelineStatus,
    ) -> Result<(), RepositoryError> {
        let now = now_iso();
        let connection = self.lock();
        connection.execute(
            "UPDATE model_hub_pipeline SET status = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![status.as_str(), now, id],
        )?;
        Ok(())
    }

    /// `updatePipelineModelPriority` (`sqliteModelHubRepository.ts:298-303`).
    fn update_pipeline_model_priority(
        &self,
        id: &str,
        priority: i64,
    ) -> Result<(), RepositoryError> {
        let now = now_iso();
        let connection = self.lock();
        connection.execute(
            "UPDATE model_hub_pipeline SET priority = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![priority, now, id],
        )?;
        Ok(())
    }

    /// `replacePipeline` (`sqliteModelHubRepository.ts:305-313`).
    ///
    /// Not transactional, on purpose — see the module docs. The incoming
    /// `profile_id` overrides the value on every input, which is what the
    /// TypeScript `{ ...input, profileId }` spread does.
    fn replace_pipeline(
        &self,
        profile_id: &str,
        models: &[CreatePipelineModelInput],
    ) -> Result<Vec<PipelineModelEntry>, RepositoryError> {
        {
            let connection = self.lock();
            connection.execute(
                "DELETE FROM model_hub_pipeline WHERE profile_id = ?",
                [profile_id],
            )?;
        }
        let mut entries = Vec::with_capacity(models.len());
        for input in models {
            entries.push(self.add_pipeline_model(CreatePipelineModelInput {
                profile_id: profile_id.to_string(),
                ..input.clone()
            })?);
        }
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::repository::encrypted_secret_input;

    fn secret_input(provider_id: &str, auth: ProviderAuthMethod) -> CreateProviderAccountInput {
        CreateProviderAccountInput {
            provider_id: provider_id.to_string(),
            label: provider_id.to_string(),
            auth_method: auth,
            encrypted_secret: encrypted_secret_input(
                "aes-256-gcm",
                "default",
                "iv",
                "cipher",
                "tag",
            ),
            encrypted_refresh_token: if auth == ProviderAuthMethod::Oauth {
                Some(encrypted_secret_input(
                    "aes-256-gcm",
                    "default",
                    "iv-r",
                    "cipher-r",
                    "tag-r",
                ))
            } else {
                None
            },
            secret_masked: "****".to_string(),
        }
    }

    fn pipeline_input(
        profile_id: &str,
        model_name: &str,
        priority: i64,
    ) -> CreatePipelineModelInput {
        CreatePipelineModelInput {
            profile_id: profile_id.to_string(),
            account_id: "acc-1".to_string(),
            provider_id: "openai".to_string(),
            model_name: model_name.to_string(),
            reasoning_effort: None,
            priority,
        }
    }

    #[test]
    fn creates_and_reads_back_an_account() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        let view = repository
            .create_account(secret_input("openrouter", ProviderAuthMethod::Oauth))
            .expect("create account");

        assert_eq!(view.provider_id, "openrouter");
        assert!(view.has_refresh_token);
        assert_eq!(view.last_check_at, None);
        assert_eq!(view.last_check_ok, None);

        let record = repository
            .get_account_record_by_id(&view.id)
            .expect("read account")
            .expect("account exists");
        assert_eq!(record.encrypted_secret.key_id, "default");
        assert_eq!(
            record
                .encrypted_refresh_token
                .as_ref()
                .expect("refresh token")
                .iv,
            "iv-r"
        );
        assert_eq!(record.view(), view);
    }

    /// The stored JSON must keep the exact key order of `JSON.stringify`.
    #[test]
    fn stores_the_secret_with_the_typescript_key_order() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        let view = repository
            .create_account(secret_input("openai", ProviderAuthMethod::ApiKey))
            .expect("create account");
        let connection = repository.lock();
        let raw: String = connection
            .query_row(
                "SELECT encrypted_secret FROM model_hub_accounts WHERE id = ?",
                [&view.id],
                |row| row.get(0),
            )
            .expect("read raw secret");
        assert_eq!(
            raw,
            r#"{"alg":"aes-256-gcm","keyId":"default","iv":"iv","ciphertext":"cipher","tag":"tag"}"#
        );
    }

    #[test]
    fn timestamps_use_iso_millis_with_a_z_suffix() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        let view = repository
            .create_account(secret_input("openai", ProviderAuthMethod::ApiKey))
            .expect("create account");
        assert_eq!(view.created_at, view.updated_at);
        assert!(view.created_at.ends_with('Z'), "{}", view.created_at);
        assert_eq!(view.created_at.len(), 24, "{}", view.created_at);
    }

    #[test]
    fn unknown_account_id_is_none() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        assert!(repository
            .get_account_record_by_id("missing")
            .expect("query")
            .is_none());
    }

    /// `last_check_ok` is stored as INTEGER and read back as `boolean | null`.
    #[test]
    fn health_status_round_trips_the_null_and_boolean_states() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        let view = repository
            .create_account(secret_input("openai", ProviderAuthMethod::ApiKey))
            .expect("create account");

        repository
            .set_health_status(&view.id, true, Some("reachable"))
            .expect("set health");
        let record = repository
            .get_account_record_by_id(&view.id)
            .expect("read")
            .expect("exists");
        assert_eq!(record.last_check_ok, Some(true));
        assert_eq!(record.last_check_message.as_deref(), Some("reachable"));

        repository
            .set_health_status(&view.id, false, None)
            .expect("set health");
        let record = repository
            .get_account_record_by_id(&view.id)
            .expect("read")
            .expect("exists");
        assert_eq!(record.last_check_ok, Some(false));
        assert_eq!(record.last_check_message, None);
    }

    /// `listAccounts` orders by `created_at DESC`.
    #[test]
    fn list_accounts_is_newest_first() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        repository
            .create_account(secret_input("openai", ProviderAuthMethod::ApiKey))
            .expect("first");
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = repository
            .create_account(secret_input("kimi", ProviderAuthMethod::ApiKey))
            .expect("second");

        let accounts = repository.list_accounts().expect("list");
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].id, second.id);
    }

    /// `deleteAccount` removes the pipeline rows first because there is no
    /// foreign key on `account_id`.
    #[test]
    fn delete_account_cascades_to_the_pipeline() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        let view = repository
            .create_account(secret_input("openai", ProviderAuthMethod::ApiKey))
            .expect("create account");
        // The pipeline row must reference *this* account, otherwise the cascade
        // under test has nothing to delete.
        let mut input = pipeline_input("p1", "gpt-4.1", 1);
        input.account_id = view.id.clone();
        repository
            .add_pipeline_model(input)
            .expect("add pipeline model");

        assert!(repository.delete_account(&view.id).expect("delete"));
        assert!(!repository.delete_account(&view.id).expect("delete again"));
        assert!(repository
            .list_pipeline_models("p1")
            .expect("list")
            .is_empty());
    }

    #[test]
    fn add_pipeline_model_defaults_to_active() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        let entry = repository
            .add_pipeline_model(pipeline_input("p1", "gpt-4.1", 3))
            .expect("add pipeline model");
        assert_eq!(entry.status, PipelineStatus::Active);
        assert_eq!(entry.priority, 3);
        assert_eq!(entry.reasoning_effort, None);

        repository
            .update_pipeline_model_status(&entry.id, PipelineStatus::RateLimited)
            .expect("update status");
        repository
            .update_pipeline_model_priority(&entry.id, 7)
            .expect("update priority");
        let entries = repository.list_pipeline_models("p1").expect("list");
        assert_eq!(entries[0].status, PipelineStatus::RateLimited);
        assert_eq!(entries[0].priority, 7);
    }

    #[test]
    fn pipeline_entries_are_ordered_by_priority() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        repository
            .add_pipeline_model(pipeline_input("p1", "third", 3))
            .expect("third");
        repository
            .add_pipeline_model(pipeline_input("p1", "first", 1))
            .expect("first");
        repository
            .add_pipeline_model(pipeline_input("p1", "second", 2))
            .expect("second");
        let names: Vec<String> = repository
            .list_pipeline_models("p1")
            .expect("list")
            .into_iter()
            .map(|entry| entry.model_name)
            .collect();
        assert_eq!(names, vec!["first", "second", "third"]);
    }

    #[test]
    fn replace_pipeline_overrides_the_profile_id() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        repository
            .add_pipeline_model(pipeline_input("other", "stale", 1))
            .expect("seed other profile");

        let entries = repository
            .replace_pipeline(
                "p1",
                &[
                    pipeline_input("ignored", "a", 1),
                    pipeline_input("ignored", "b", 2),
                ],
            )
            .expect("replace");
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| entry.profile_id == "p1"));
        assert_eq!(
            repository.list_pipeline_models("p1").expect("list").len(),
            2
        );
        assert_eq!(
            repository
                .list_pipeline_models("other")
                .expect("list")
                .len(),
            1,
            "another profile is untouched"
        );
    }

    /// The two `PRAGMA table_info` guards must add their column to a database
    /// created before those columns existed, and stay quiet afterwards.
    #[test]
    fn migration_adds_the_missing_columns_to_a_legacy_database() {
        let connection = open(OpenOptions::new(":memory:")).expect("open legacy database");
        connection
            .execute_batch(
                "CREATE TABLE model_hub_accounts (
                   id TEXT PRIMARY KEY,
                   provider_id TEXT NOT NULL,
                   label TEXT NOT NULL,
                   auth_method TEXT NOT NULL,
                   encrypted_secret TEXT NOT NULL,
                   encrypted_refresh_token TEXT,
                   secret_masked TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   last_check_at TEXT,
                   last_check_ok INTEGER
                 );
                 CREATE TABLE model_hub_pipeline (
                   id TEXT PRIMARY KEY,
                   profile_id TEXT NOT NULL,
                   account_id TEXT NOT NULL,
                   provider_id TEXT NOT NULL,
                   model_name TEXT NOT NULL,
                   priority INTEGER NOT NULL DEFAULT 1,
                   status TEXT NOT NULL DEFAULT 'active',
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );",
            )
            .expect("create legacy schema");

        let repository =
            SqliteModelHubRepository::from_connection(connection).expect("migrate legacy database");

        let columns = |table: &str| -> Vec<String> {
            let connection = repository.lock();
            let mut statement = connection
                .prepare(&format!("PRAGMA table_info({table})"))
                .expect("pragma");
            let rows = statement
                .query_map([], |row| row.get::<_, String>(1))
                .expect("query pragma");
            rows.map(|row| row.expect("row")).collect()
        };
        assert!(columns("model_hub_accounts").contains(&"last_check_message".to_string()));
        assert!(columns("model_hub_pipeline").contains(&"reasoning_effort".to_string()));

        // Re-opening must be a no-op, not a duplicate-column error.
        let view = repository
            .create_account(secret_input("openai", ProviderAuthMethod::ApiKey))
            .expect("create account on migrated database");
        assert_eq!(view.provider_id, "openai");
        assert!(repository.migrate().is_ok());
    }

    #[test]
    fn reasoning_effort_round_trips_including_unknown_values() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        let mut input = pipeline_input("p1", "gpt-5.6", 1);
        input.reasoning_effort = Some(PipelineReasoningEffort::Xhigh);
        let entry = repository.add_pipeline_model(input).expect("add");
        let stored = repository.list_pipeline_models("p1").expect("list");
        assert_eq!(
            stored[0].reasoning_effort,
            Some(PipelineReasoningEffort::Xhigh)
        );

        {
            let connection = repository.lock();
            connection
                .execute(
                    "UPDATE model_hub_pipeline SET reasoning_effort = ? WHERE id = ?",
                    rusqlite::params!["turbo", entry.id],
                )
                .expect("force an unknown effort");
        }
        let stored = repository.list_pipeline_models("p1").expect("list");
        assert_eq!(
            stored[0].reasoning_effort,
            Some(PipelineReasoningEffort::Other("turbo".to_string()))
        );
    }

    #[test]
    fn a_malformed_stored_secret_is_reported_not_ignored() {
        let repository = SqliteModelHubRepository::in_memory().expect("open in-memory database");
        let view = repository
            .create_account(secret_input("openai", ProviderAuthMethod::ApiKey))
            .expect("create account");
        {
            let connection = repository.lock();
            connection
                .execute(
                    "UPDATE model_hub_accounts SET encrypted_secret = ? WHERE id = ?",
                    rusqlite::params!["not json", view.id],
                )
                .expect("corrupt the row");
        }
        // The view projection does not read the secret and therefore still works.
        assert_eq!(repository.list_accounts().expect("list").len(), 1);
        let error = repository
            .get_account_record_by_id(&view.id)
            .expect_err("record read must fail");
        assert!(
            error
                .to_string()
                .contains("stored secret is not valid JSON"),
            "{error}"
        );
    }
}
