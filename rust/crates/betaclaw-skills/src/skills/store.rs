//! Port of `src/server/skills/skillRepository.ts`.
//!
//! Table `skills`, with the same DDL and column names as the TypeScript, so
//! `.local/skills.db` stays readable by both sides. The table is created with
//! `CREATE TABLE IF NOT EXISTS`, as in TypeScript. The `_migrations` bookkeeping of
//! `src/lib/db/migrations.ts` is not used by this store.
//!
//! Not ported: the lazy singleton `getSkillRepository` (it belongs in `state.rs`) and
//! `SKILLS_DB_PATH`. The path is a constructor argument.
//!
//! `source` and the install input's `source` stay strings. TypeScript narrows them to
//! unions at compile time only, and the repository never checks them at run time.

use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::builtin_skills::BuiltInSkillSeed;
use super::types::{lock_unpoisoned, SkillError};
use crate::db::{self, OpenOptions};
use crate::safe_error_message;
use crate::stats::util::now_iso;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      version TEXT NOT NULL,
      installed INTEGER NOT NULL DEFAULT 0,
      function_name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'built-in',
      source_url TEXT,
      tool_definition TEXT NOT NULL,
      handler_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
";

/// Seed insert. Existing ids are left alone, so the user's toggle survives a restart.
const SEED_INSERT: &str = "
    INSERT OR IGNORE INTO skills (
      id, name, description, category, version,
      installed, function_name, source, source_url,
      tool_definition, handler_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'built-in', NULL, ?, NULL, ?, ?)
";

/// Seed sync. Only built-in rows are refreshed from the seed.
const SEED_SYNC: &str = "
    UPDATE skills
    SET
      name = ?,
      description = ?,
      category = ?,
      version = ?,
      function_name = ?,
      tool_definition = ?,
      updated_at = ?
    WHERE id = ? AND source = 'built-in'
";

const INSTALL_INSERT: &str = "
    INSERT INTO skills (
      id, name, description, category, version,
      installed, function_name, source, source_url,
      tool_definition, handler_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
";

const SELECT_ALL: &str = "SELECT * FROM skills ORDER BY created_at ASC";
const SELECT_ONE: &str = "SELECT * FROM skills WHERE id = ?";

/// `SkillRow`.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub version: String,
    pub installed: bool,
    pub function_name: String,
    pub source: String,
    pub source_url: Option<String>,
    /// The stored `tool_definition` JSON. TypeScript casts it to `SkillToolDefinition`
    /// without checking, so the value is kept as parsed.
    pub tool_definition: Value,
    pub handler_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `InstallSkillInput`. An empty `id` gets a generated one, as `input.id || randomUUID()`.
#[derive(Debug, Clone, PartialEq)]
pub struct InstallSkillInput {
    pub id: Option<String>,
    pub name: String,
    pub description: String,
    pub category: String,
    pub version: String,
    pub function_name: String,
    pub source: String,
    pub source_url: Option<String>,
    pub tool_definition: Value,
    pub handler_path: Option<String>,
}

pub(crate) fn sql_error(error: rusqlite::Error) -> SkillError {
    SkillError(safe_error_message(&error))
}

fn json_text(value: &Value) -> Result<String, SkillError> {
    serde_json::to_string(value).map_err(|error| SkillError(safe_error_message(&error)))
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

fn to_row(row: &Row<'_>) -> rusqlite::Result<SkillRow> {
    let installed: i64 = row.get("installed")?;
    let tool_text: String = row.get("tool_definition")?;
    let tool_definition: Value = serde_json::from_str(&tool_text).map_err(|error| {
        let index = row.as_ref().column_index("tool_definition").unwrap_or(0);
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(SkillRow {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        category: row.get("category")?,
        version: row.get("version")?,
        installed: installed != 0,
        function_name: row.get("function_name")?,
        source: row.get("source")?,
        source_url: non_empty(row.get("source_url")?),
        tool_definition,
        handler_path: non_empty(row.get("handler_path")?),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn select_one(connection: &Connection, id: &str) -> Result<Option<SkillRow>, SkillError> {
    connection
        .query_row(SELECT_ONE, params![id], to_row)
        .optional()
        .map_err(sql_error)
}

/// `SkillRepository`. The connection sits behind a mutex, as in `clawhub/repository.rs`.
pub struct SkillRepository {
    connection: Mutex<Connection>,
}

impl SkillRepository {
    /// Opens or creates the database at `db_path` with the shared pragmas.
    pub fn open(db_path: &str) -> Result<Self, SkillError> {
        let connection = db::open(OpenOptions::new(db_path)).map_err(sql_error)?;
        connection.execute_batch(SCHEMA).map_err(sql_error)?;
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

    /// `seedBuiltIns`. Inserts missing built-in rows and refreshes the definition of
    /// existing built-in rows. The `installed` flag of an existing row is never changed.
    pub fn seed_built_ins(&self, seeds: &[BuiltInSkillSeed]) -> Result<(), SkillError> {
        let connection = self.lock();
        let now = now_iso();
        let mut insert = connection.prepare(SEED_INSERT).map_err(sql_error)?;
        let mut sync = connection.prepare(SEED_SYNC).map_err(sql_error)?;
        for seed in seeds {
            let manifest = &seed.manifest;
            let tool = json_text(&manifest.tool)?;
            insert
                .execute(params![
                    manifest.id,
                    manifest.name,
                    manifest.description,
                    manifest.category,
                    manifest.version,
                    i64::from(seed.installed_by_default),
                    manifest.function_name,
                    tool,
                    now,
                    now,
                ])
                .map_err(sql_error)?;
            sync.execute(params![
                manifest.name,
                manifest.description,
                manifest.category,
                manifest.version,
                manifest.function_name,
                tool,
                now,
                manifest.id,
            ])
            .map_err(sql_error)?;
        }
        Ok(())
    }

    /// `listSkills`, in creation order.
    pub fn list_skills(&self) -> Result<Vec<SkillRow>, SkillError> {
        let connection = self.lock();
        let mut statement = connection.prepare(SELECT_ALL).map_err(sql_error)?;
        let rows = statement.query_map([], to_row).map_err(sql_error)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_error)
    }

    /// `getSkill`.
    pub fn get_skill(&self, id: &str) -> Result<Option<SkillRow>, SkillError> {
        let connection = self.lock();
        select_one(&connection, id)
    }

    /// `setInstalled`. Returns false when no row has the id.
    pub fn set_installed(&self, id: &str, installed: bool) -> Result<bool, SkillError> {
        let connection = self.lock();
        let changes = connection
            .execute(
                "UPDATE skills SET installed = ?, updated_at = ? WHERE id = ?",
                params![i64::from(installed), now_iso(), id],
            )
            .map_err(sql_error)?;
        Ok(changes > 0)
    }

    /// `installSkill`. The row is stored as installed.
    pub fn install_skill(&self, input: &InstallSkillInput) -> Result<SkillRow, SkillError> {
        let id = input
            .id
            .as_deref()
            .filter(|id| !id.is_empty())
            .map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_string);
        let now = now_iso();
        let tool = json_text(&input.tool_definition)?;
        let connection = self.lock();
        connection
            .execute(
                INSTALL_INSERT,
                params![
                    id,
                    input.name,
                    input.description,
                    input.category,
                    input.version,
                    input.function_name,
                    input.source,
                    input.source_url,
                    tool,
                    input.handler_path,
                    now,
                    now,
                ],
            )
            .map_err(sql_error)?;
        select_one(&connection, &id)?
            .ok_or_else(|| SkillError("Installed skill row not found.".to_string()))
    }

    /// `removeSkill`. Returns false when no row has the id.
    pub fn remove_skill(&self, id: &str) -> Result<bool, SkillError> {
        let connection = self.lock();
        let changes = connection
            .execute("DELETE FROM skills WHERE id = ?", params![id])
            .map_err(sql_error)?;
        Ok(changes > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::builtin_skills::built_in_skills;
    use serde_json::json;

    fn repository() -> SkillRepository {
        let repository = SkillRepository::in_memory().expect("open in-memory store");
        repository
            .seed_built_ins(&built_in_skills())
            .expect("seed built-ins");
        repository
    }

    fn vendor_input(id: Option<&str>) -> InstallSkillInput {
        InstallSkillInput {
            id: id.map(str::to_string),
            name: "Vendor".to_string(),
            description: "Vendor tool".to_string(),
            category: "Custom".to_string(),
            version: "1.0.0".to_string(),
            function_name: "vendor_tool".to_string(),
            source: "github".to_string(),
            source_url: None,
            tool_definition: json!({ "name": "vendor_tool" }),
            handler_path: None,
        }
    }

    #[test]
    fn seed_inserts_every_built_in_with_its_default_install_state() {
        let repository = repository();
        assert_eq!(repository.list_skills().expect("list").len(), 34);

        let browser = repository
            .get_skill("browser")
            .expect("get")
            .expect("browser is seeded");
        assert!(browser.installed);
        assert_eq!(browser.source, "built-in");
        assert_eq!(browser.function_name, "browser_snapshot");
        assert_eq!(browser.source_url, None);
        assert_eq!(browser.handler_path, None);
        assert_eq!(browser.tool_definition["name"], "browser_snapshot");

        let github = repository
            .get_skill("github-manager")
            .expect("get")
            .expect("github is seeded");
        assert!(!github.installed);
    }

    #[test]
    fn reseeding_keeps_the_user_toggle() {
        let repository = repository();
        assert!(repository
            .set_installed("github-manager", true)
            .expect("toggle"));
        repository
            .seed_built_ins(&built_in_skills())
            .expect("reseed");
        let github = repository
            .get_skill("github-manager")
            .expect("get")
            .expect("row");
        assert!(github.installed);
    }

    #[test]
    fn reseeding_refreshes_built_in_rows_only() {
        let repository = repository();
        {
            let connection = repository.lock();
            connection
                .execute(
                    "UPDATE skills SET description = 'stale' WHERE id = 'browser'",
                    [],
                )
                .expect("stale built-in");
            connection
                .execute(
                    "UPDATE skills SET description = 'stale', source = 'manual' WHERE id = 'web-fetch'",
                    [],
                )
                .expect("stale manual");
        }
        repository
            .seed_built_ins(&built_in_skills())
            .expect("reseed");

        let browser = repository.get_skill("browser").expect("get").expect("row");
        assert_eq!(
            browser.description,
            built_in_skills()[0].manifest.description
        );
        let web_fetch = repository
            .get_skill("web-fetch")
            .expect("get")
            .expect("row");
        assert_eq!(web_fetch.description, "stale");
    }

    #[test]
    fn installed_skill_round_trips_and_removes() {
        let repository = repository();
        let row = repository
            .install_skill(&vendor_input(Some("")))
            .expect("install");
        assert!(row.installed);
        assert_eq!(row.id.len(), 36, "an empty id is replaced by a UUID");
        assert_eq!(row.source, "github");
        assert_eq!(row.tool_definition["name"], "vendor_tool");
        assert_eq!(
            repository.get_skill(&row.id).expect("get"),
            Some(row.clone())
        );

        assert!(repository.remove_skill(&row.id).expect("remove"));
        assert!(!repository.remove_skill(&row.id).expect("remove again"));
        assert!(!repository.set_installed("missing", true).expect("toggle"));
    }

    #[test]
    fn install_keeps_a_given_id() {
        let repository = repository();
        let row = repository
            .install_skill(&vendor_input(Some("vendor-1")))
            .expect("install");
        assert_eq!(row.id, "vendor-1");
    }
}
