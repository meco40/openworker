//! Port of `src/server/clawhub/clawhubRepository.ts`.
//!
//! Table `clawhub_skills`, same DDL and column names as the TypeScript, so
//! `.local/clawhub.db` stays readable by both sides. The process-wide singleton
//! is not ported.

use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};

use super::errors::ClawHubError;
use super::types::{SkillRow, SkillStatus, UpsertSkillInput};
use crate::db::OpenOptions;
use crate::stats::util::now_iso;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS clawhub_skills (
      slug TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      local_path TEXT NOT NULL,
      installed_at TEXT,
      last_action_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
";

/// `process.env.CLAWHUB_DB_PATH || '.local/clawhub.db'`.
pub fn default_db_path() -> String {
    std::env::var("CLAWHUB_DB_PATH")
        .ok()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| crate::db::default_db_path("clawhub.db"))
}

fn to_row(row: &Row<'_>) -> rusqlite::Result<SkillRow> {
    let status: String = row.get("status")?;
    let status = SkillStatus::parse(&status).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown skill status {status}"),
            )),
        )
    })?;
    let enabled: i64 = row.get("enabled")?;
    Ok(SkillRow {
        slug: row.get("slug")?,
        version: row.get("version")?,
        title: row.get("title")?,
        status,
        enabled: enabled != 0,
        local_path: row.get("local_path")?,
        installed_at: non_empty(row.get("installed_at")?),
        last_action_at: non_empty(row.get("last_action_at")?),
        last_error: non_empty(row.get("last_error")?),
        updated_at: row.get("updated_at")?,
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

pub struct ClawHubRepository {
    connection: Mutex<Connection>,
}

impl ClawHubRepository {
    pub fn open(db_path: &str) -> Result<Self, ClawHubError> {
        let connection = crate::db::open(OpenOptions::new(db_path))?;
        connection.execute_batch(SCHEMA)?;
        let repository = Self {
            connection: Mutex::new(connection),
        };
        repository.ensure_enabled_column()?;
        Ok(repository)
    }

    pub fn in_memory() -> Result<Self, ClawHubError> {
        Self::open(":memory:")
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `ensureColumnExists('enabled', …)`: databases from before the flag existed.
    fn ensure_enabled_column(&self) -> Result<(), ClawHubError> {
        let connection = self.lock();
        let mut statement = connection.prepare("PRAGMA table_info(clawhub_skills)")?;
        let mut rows = statement.query([])?;
        let mut present = false;
        while let Some(row) = rows.next()? {
            let name: String = row.get("name")?;
            if name == "enabled" {
                present = true;
                break;
            }
        }
        if !present {
            connection.execute_batch(
                "ALTER TABLE clawhub_skills ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0",
            )?;
        }
        Ok(())
    }

    /// `upsertSkill`. Returns the stored row.
    pub fn upsert_skill(&self, input: &UpsertSkillInput) -> Result<SkillRow, ClawHubError> {
        let now = now_iso();
        let last_action_at = input.last_action_at.clone().unwrap_or_else(|| now.clone());
        let connection = self.lock();
        match input.enabled {
            Some(enabled) => {
                connection.execute(
                    "INSERT INTO clawhub_skills (
                       slug, version, title, status, enabled, local_path,
                       installed_at, last_action_at, last_error, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(slug) DO UPDATE SET
                       version = excluded.version,
                       title = excluded.title,
                       status = excluded.status,
                       enabled = excluded.enabled,
                       local_path = excluded.local_path,
                       installed_at = excluded.installed_at,
                       last_action_at = excluded.last_action_at,
                       last_error = excluded.last_error,
                       updated_at = excluded.updated_at",
                    params![
                        input.slug,
                        input.version,
                        input.title,
                        input.status.as_str(),
                        i64::from(enabled),
                        input.local_path,
                        input.installed_at,
                        last_action_at,
                        input.last_error,
                        now,
                    ],
                )?;
            }
            None => {
                connection.execute(
                    "INSERT INTO clawhub_skills (
                       slug, version, title, status, local_path,
                       installed_at, last_action_at, last_error, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(slug) DO UPDATE SET
                       version = excluded.version,
                       title = excluded.title,
                       status = excluded.status,
                       local_path = excluded.local_path,
                       installed_at = excluded.installed_at,
                       last_action_at = excluded.last_action_at,
                       last_error = excluded.last_error,
                       updated_at = excluded.updated_at",
                    params![
                        input.slug,
                        input.version,
                        input.title,
                        input.status.as_str(),
                        input.local_path,
                        input.installed_at,
                        last_action_at,
                        input.last_error,
                        now,
                    ],
                )?;
            }
        }
        let row = connection.query_row(
            "SELECT * FROM clawhub_skills WHERE slug = ?",
            [&input.slug],
            to_row,
        )?;
        Ok(row)
    }

    fn query_rows(&self, sql: &str) -> Result<Vec<SkillRow>, ClawHubError> {
        let connection = self.lock();
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map([], to_row)?;
        let skills: Vec<SkillRow> = rows.collect::<Result<_, _>>()?;
        Ok(skills)
    }

    pub fn list_skills(&self) -> Result<Vec<SkillRow>, ClawHubError> {
        self.query_rows("SELECT * FROM clawhub_skills ORDER BY updated_at DESC, slug ASC")
    }

    pub fn list_enabled_skills(&self) -> Result<Vec<SkillRow>, ClawHubError> {
        self.query_rows(
            "SELECT * FROM clawhub_skills WHERE enabled = 1 ORDER BY updated_at DESC, slug ASC",
        )
    }

    pub fn get_skill(&self, slug: &str) -> Result<Option<SkillRow>, ClawHubError> {
        let connection = self.lock();
        let row = connection
            .query_row(
                "SELECT * FROM clawhub_skills WHERE slug = ?",
                [slug],
                to_row,
            )
            .optional()?;
        Ok(row)
    }

    /// `deleteSkill`: `true` when a row was removed.
    pub fn delete_skill(&self, slug: &str) -> Result<bool, ClawHubError> {
        let connection = self.lock();
        let changes = connection.execute("DELETE FROM clawhub_skills WHERE slug = ?", [slug])?;
        Ok(changes > 0)
    }

    /// `setEnabled`: `true` when the row exists.
    pub fn set_enabled(&self, slug: &str, enabled: bool) -> Result<bool, ClawHubError> {
        let now = now_iso();
        let connection = self.lock();
        let changes = connection.execute(
            "UPDATE clawhub_skills SET enabled = ?, updated_at = ? WHERE slug = ?",
            params![i64::from(enabled), now, slug],
        )?;
        Ok(changes > 0)
    }

    /// `deleteNotIn`. An empty list deletes every row, as in the TypeScript.
    pub fn delete_not_in(&self, slugs: &[String]) -> Result<usize, ClawHubError> {
        let connection = self.lock();
        if slugs.is_empty() {
            return Ok(connection.execute("DELETE FROM clawhub_skills", [])?);
        }
        let placeholders = vec!["?"; slugs.len()].join(", ");
        let sql = format!("DELETE FROM clawhub_skills WHERE slug NOT IN ({placeholders})");
        Ok(connection.execute(&sql, params_from_iter(slugs.iter()))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(slug: &str, enabled: Option<bool>) -> UpsertSkillInput {
        UpsertSkillInput {
            slug: slug.into(),
            version: "1.0.0".into(),
            title: format!("{slug} title"),
            status: SkillStatus::Installed,
            enabled,
            local_path: format!("skills/{slug}"),
            installed_at: None,
            last_action_at: None,
            last_error: None,
        }
    }

    #[test]
    fn upsert_keeps_the_enabled_flag_when_it_is_not_given() {
        let repository = ClawHubRepository::in_memory().expect("open");
        repository
            .upsert_skill(&input("alpha", Some(true)))
            .expect("insert");
        let updated = repository
            .upsert_skill(&input("alpha", None))
            .expect("update");
        assert!(updated.enabled, "the flag survives an upsert without it");
        assert_eq!(updated.status, SkillStatus::Installed);
    }

    #[test]
    fn enable_list_and_delete() {
        let repository = ClawHubRepository::in_memory().expect("open");
        repository
            .upsert_skill(&input("alpha", None))
            .expect("alpha");
        repository.upsert_skill(&input("beta", None)).expect("beta");

        assert!(repository.set_enabled("beta", true).expect("enable"));
        assert!(!repository
            .set_enabled("missing", true)
            .expect("enable missing"));
        let enabled = repository.list_enabled_skills().expect("enabled");
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].slug, "beta");

        assert!(repository.delete_skill("alpha").expect("delete"));
        assert!(!repository.delete_skill("alpha").expect("delete again"));
        assert!(repository.get_skill("alpha").expect("get").is_none());
    }

    #[test]
    fn delete_not_in_with_an_empty_list_removes_everything() {
        let repository = ClawHubRepository::in_memory().expect("open");
        repository
            .upsert_skill(&input("alpha", None))
            .expect("alpha");
        repository.upsert_skill(&input("beta", None)).expect("beta");
        assert_eq!(
            repository
                .delete_not_in(&["beta".to_string()])
                .expect("keep beta"),
            1
        );
        assert_eq!(repository.delete_not_in(&[]).expect("clear"), 1);
        assert!(repository.list_skills().expect("list").is_empty());
    }

    #[test]
    fn a_legacy_table_gains_the_enabled_column() {
        let connection = Connection::open_in_memory().expect("open");
        connection
            .execute_batch(
                "CREATE TABLE clawhub_skills (
                   slug TEXT PRIMARY KEY, version TEXT NOT NULL, title TEXT NOT NULL,
                   status TEXT NOT NULL, local_path TEXT NOT NULL, installed_at TEXT,
                   last_action_at TEXT, last_error TEXT, updated_at TEXT NOT NULL
                 );",
            )
            .expect("legacy table");
        let repository = ClawHubRepository {
            connection: Mutex::new(connection),
        };
        repository.ensure_enabled_column().expect("migrate");
        repository
            .upsert_skill(&input("alpha", Some(true)))
            .expect("insert");
        assert!(
            repository
                .get_skill("alpha")
                .expect("get")
                .expect("row")
                .enabled
        );
    }
}
