//! Log repository.
//!
//! Ports `src/logging/logRepository.ts`. The SQLite schema, pragmas and query
//! semantics are unchanged so the TypeScript and Rust processes can share
//! `.local/logs.db` over the `app-data` volume.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, ToSql};
use serde::Serialize;
use serde_json::Value;

use crate::db::{open, OpenOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "debug" => Some(LogLevel::Debug),
            "info" => Some(LogLevel::Info),
            "warn" => Some(LogLevel::Warn),
            "error" => Some(LogLevel::Error),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogCategory {
    System,
    Security,
    Channel,
    Tooling,
    Memory,
    Worker,
    Diagnostics,
    Integration,
}

impl LogCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            LogCategory::System => "system",
            LogCategory::Security => "security",
            LogCategory::Channel => "channel",
            LogCategory::Tooling => "tooling",
            LogCategory::Memory => "memory",
            LogCategory::Worker => "worker",
            LogCategory::Diagnostics => "diagnostics",
            LogCategory::Integration => "integration",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "system" => Some(LogCategory::System),
            "security" => Some(LogCategory::Security),
            "channel" => Some(LogCategory::Channel),
            "tooling" => Some(LogCategory::Tooling),
            "memory" => Some(LogCategory::Memory),
            "worker" => Some(LogCategory::Worker),
            "diagnostics" => Some(LogCategory::Diagnostics),
            "integration" => Some(LogCategory::Integration),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: String,
    pub level: LogLevel,
    pub source: String,
    pub category: LogCategory,
    pub message: String,
    pub metadata: Option<Value>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct LogFilter {
    pub level: Option<LogLevel>,
    pub source: Option<String>,
    pub category: Option<LogCategory>,
    pub search: Option<String>,
    pub limit: Option<usize>,
    pub before: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum LogRepositoryError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("row data could not be decoded: {0}")]
    Corrupt(String),
}

const DEFAULT_LIMIT: usize = 200;

pub struct LogRepository {
    connection: Connection,
}

impl LogRepository {
    /// Opens the repository and applies the DDL from `migrate()` in the
    /// TypeScript class, including the additive `category` column upgrade.
    pub fn open(db_path: &str) -> Result<Self, LogRepositoryError> {
        let connection = open(OpenOptions::new(db_path))?;
        let repository = Self { connection };
        repository.migrate()?;
        Ok(repository)
    }

    fn has_column(&self, table: &str, column: &str) -> Result<bool, LogRepositoryError> {
        let mut statement = self
            .connection
            .prepare(&format!("PRAGMA table_info({table})"))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let name: Option<String> = row.get(1)?;
            if name.as_deref() == Some(column) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn migrate(&self) -> Result<(), LogRepositoryError> {
        self.connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS system_logs (
              id TEXT PRIMARY KEY,
              timestamp TEXT NOT NULL,
              level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
              source TEXT NOT NULL,
              category TEXT NOT NULL DEFAULT 'system',
              message TEXT NOT NULL,
              metadata TEXT,
              created_at TEXT NOT NULL
            );
            "#,
        )?;

        if !self.has_column("system_logs", "category")? {
            self.connection.execute_batch(
                "ALTER TABLE system_logs ADD COLUMN category TEXT NOT NULL DEFAULT 'system';",
            )?;
            self.connection.execute_batch(
                "UPDATE system_logs SET category = 'system' WHERE category IS NULL OR category = '';",
            )?;
        }

        self.connection.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON system_logs (created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_level ON system_logs (level);
            CREATE INDEX IF NOT EXISTS idx_logs_source ON system_logs (source);
            CREATE INDEX IF NOT EXISTS idx_logs_category ON system_logs (category);
            "#,
        )?;
        Ok(())
    }

    pub fn insert_log(
        &self,
        level: LogLevel,
        source: &str,
        message: &str,
        metadata: Option<&Value>,
        category: LogCategory,
    ) -> Result<LogEntry, LogRepositoryError> {
        let id = format!(
            "log-{}-{}",
            now_ms(),
            uuid::Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        );
        let now = now_iso();
        let metadata_json = metadata.map(|value| value.to_string());

        self.connection.execute(
            "INSERT INTO system_logs (id, timestamp, level, source, category, message, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                now,
                level.as_str(),
                source,
                category.as_str(),
                message,
                metadata_json,
                now
            ],
        )?;

        Ok(LogEntry {
            id,
            timestamp: now.clone(),
            level,
            source: source.to_string(),
            category,
            message: message.to_string(),
            metadata: metadata.cloned(),
            created_at: now,
        })
    }

    /// Lists logs newest-first, then reverses so the caller sees oldest-first
    /// within the returned page. Cursor pagination uses `created_at < before`.
    pub fn list_logs(&self, filter: &LogFilter) -> Result<Vec<LogEntry>, LogRepositoryError> {
        let (where_clause, mut params) = build_where(filter);
        let limit = filter.limit.unwrap_or(DEFAULT_LIMIT);
        let sql = format!(
            "SELECT * FROM system_logs {where_clause} ORDER BY rowid DESC LIMIT ?{}",
            params.len() + 1
        );

        let mut bound: Vec<Box<dyn ToSql>> = params
            .drain(..)
            .map(|value| Box::new(value) as Box<dyn ToSql>)
            .collect();
        bound.push(Box::new(limit as i64));

        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(bound.iter()), |row| Ok(map_row(row)))?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row??);
        }
        entries.reverse();
        Ok(entries)
    }

    pub fn get_log_count(&self, filter: &LogFilter) -> Result<i64, LogRepositoryError> {
        let (where_clause, params) = build_where(filter);
        let sql = format!("SELECT COUNT(*) as cnt FROM system_logs {where_clause}");
        let bound: Vec<Box<dyn ToSql>> = params
            .into_iter()
            .map(|value| Box::new(value) as Box<dyn ToSql>)
            .collect();
        let count = self
            .connection
            .query_row(&sql, params_from_iter(bound.iter()), |row| {
                row.get::<_, i64>(0)
            })?;
        Ok(count)
    }

    pub fn get_sources(&self) -> Result<Vec<String>, LogRepositoryError> {
        let mut statement = self
            .connection
            .prepare("SELECT DISTINCT source FROM system_logs ORDER BY source")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_categories(&self) -> Result<Vec<String>, LogRepositoryError> {
        let mut statement = self
            .connection
            .prepare("SELECT DISTINCT category FROM system_logs ORDER BY category")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn clear_logs(&self) -> Result<usize, LogRepositoryError> {
        let deleted = self.connection.execute("DELETE FROM system_logs", [])?;
        Ok(deleted)
    }
}

type ParamValue = Box<dyn ToSql>;

fn build_where(filter: &LogFilter) -> (String, Vec<ParamValue>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<ParamValue> = Vec::new();

    if let Some(level) = filter.level {
        conditions.push("level = ?".to_string());
        params.push(Box::new(level.as_str().to_string()));
    }
    if let Some(source) = &filter.source {
        conditions.push("source = ?".to_string());
        params.push(Box::new(source.clone()));
    }
    if let Some(category) = filter.category {
        conditions.push("category = ?".to_string());
        params.push(Box::new(category.as_str().to_string()));
    }
    if let Some(search) = &filter.search {
        conditions.push("message LIKE ?".to_string());
        params.push(Box::new(format!("%{search}%")));
    }
    if let Some(before) = &filter.before {
        conditions.push("created_at < ?".to_string());
        params.push(Box::new(before.clone()));
    }

    if conditions.is_empty() {
        (String::new(), params)
    } else {
        (format!("WHERE {}", conditions.join(" AND ")), params)
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> Result<LogEntry, rusqlite::Error> {
    let metadata_raw: Option<String> = row.get(6)?;
    let metadata = match metadata_raw {
        Some(raw) if !raw.is_empty() => serde_json::from_str(&raw).ok(),
        _ => None,
    };
    let category_raw: Option<String> = row.get(4)?;
    Ok(LogEntry {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        level: LogLevel::parse(&row.get::<_, String>(2)?).unwrap_or(LogLevel::Info),
        source: row.get(3)?,
        category: category_raw
            .as_deref()
            .and_then(LogCategory::parse)
            .unwrap_or(LogCategory::System),
        message: row.get(5)?,
        metadata,
        created_at: row.get(7)?,
    })
}

/// Reads the newest log entries matching a filter, ignoring count bookkeeping.
pub fn recent_logs(
    repo: &LogRepository,
    filter: &LogFilter,
) -> Result<Vec<LogEntry>, LogRepositoryError> {
    repo.list_logs(filter)
}

/// Reads the distinct sources without exposing the SQL layer.
pub fn sources(repo: &LogRepository) -> Result<Vec<String>, LogRepositoryError> {
    repo.get_sources()
}

/// Reads the distinct categories without exposing the SQL layer.
pub fn categories(repo: &LogRepository) -> Result<Vec<String>, LogRepositoryError> {
    repo.get_categories()
}

/// Fetches a single entry by id, used by tests and diagnostics.
pub fn find_by_id(repo: &LogRepository, id: &str) -> Result<Option<LogEntry>, LogRepositoryError> {
    let mut statement = repo
        .connection
        .prepare("SELECT * FROM system_logs WHERE id = ?1")?;
    let row = statement
        .query_row(params![id], |row| Ok(map_row(row)))
        .optional()?;
    match row {
        Some(Ok(entry)) => Ok(Some(entry)),
        Some(Err(error)) => Err(error.into()),
        None => Ok(None),
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn repo() -> LogRepository {
        LogRepository::open(":memory:").expect("open log repository")
    }

    #[test]
    fn inserts_and_reads_back() {
        let repo = repo();
        let entry = repo
            .insert_log(
                LogLevel::Warn,
                "SYS",
                "disk almost full",
                None,
                LogCategory::System,
            )
            .unwrap();
        assert_eq!(entry.level, LogLevel::Warn);
        assert_eq!(entry.source, "SYS");

        let logs = repo.list_logs(&LogFilter::default()).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].message, "disk almost full");
        assert!(logs[0].metadata.is_none());
    }

    #[test]
    fn filters_by_level_source_and_category() {
        let repo = repo();
        repo.insert_log(LogLevel::Info, "SYS", "boot", None, LogCategory::System)
            .unwrap();
        repo.insert_log(
            LogLevel::Error,
            "AUTH",
            "denied",
            None,
            LogCategory::Security,
        )
        .unwrap();

        assert_eq!(repo.get_log_count(&LogFilter::default()).unwrap(), 2);
        assert_eq!(
            repo.get_log_count(&LogFilter {
                level: Some(LogLevel::Error),
                ..Default::default()
            })
            .unwrap(),
            1
        );
        assert_eq!(
            repo.get_log_count(&LogFilter {
                source: Some("SYS".into()),
                ..Default::default()
            })
            .unwrap(),
            1
        );
        assert_eq!(
            repo.get_log_count(&LogFilter {
                category: Some(LogCategory::Security),
                ..Default::default()
            })
            .unwrap(),
            1
        );
    }

    #[test]
    fn search_matches_substring() {
        let repo = repo();
        repo.insert_log(
            LogLevel::Info,
            "SYS",
            "connection timeout",
            None,
            LogCategory::System,
        )
        .unwrap();
        repo.insert_log(LogLevel::Info, "SYS", "all good", None, LogCategory::System)
            .unwrap();

        let hits = repo
            .list_logs(&LogFilter {
                search: Some("timeout".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message, "connection timeout");
    }

    #[test]
    fn returns_oldest_first_within_page() {
        let repo = repo();
        for index in 0..3 {
            repo.insert_log(
                LogLevel::Info,
                "SYS",
                &format!("message-{index}"),
                None,
                LogCategory::System,
            )
            .unwrap();
        }
        let logs = repo.list_logs(&LogFilter::default()).unwrap();
        assert_eq!(logs[0].message, "message-0");
        assert_eq!(logs[2].message, "message-2");
    }

    #[test]
    fn respects_limit() {
        let repo = repo();
        for index in 0..5 {
            repo.insert_log(
                LogLevel::Info,
                "SYS",
                &format!("m{index}"),
                None,
                LogCategory::System,
            )
            .unwrap();
        }
        let logs = repo
            .list_logs(&LogFilter {
                limit: Some(2),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(logs.len(), 2);
    }

    #[test]
    fn cursor_excludes_older_entries() {
        let repo = repo();
        let first = repo
            .insert_log(LogLevel::Info, "SYS", "first", None, LogCategory::System)
            .unwrap();
        repo.insert_log(LogLevel::Info, "SYS", "second", None, LogCategory::System)
            .unwrap();

        let after = repo
            .list_logs(&LogFilter {
                before: Some(first.created_at.clone()),
                ..Default::default()
            })
            .unwrap();
        assert!(after.iter().all(|entry| entry.message != "first"));
    }

    #[test]
    fn metadata_round_trips_as_json() {
        let repo = repo();
        let entry = repo
            .insert_log(
                LogLevel::Info,
                "TOOL",
                "ran tool",
                Some(&json!({"tool": "shell", "code": 0})),
                LogCategory::Tooling,
            )
            .unwrap();
        let stored = find_by_id(&repo, &entry.id).unwrap().unwrap();
        assert_eq!(stored.metadata.unwrap()["tool"], "shell");
    }

    #[test]
    fn distinct_sources_and_categories() {
        let repo = repo();
        repo.insert_log(LogLevel::Info, "SYS", "a", None, LogCategory::System)
            .unwrap();
        repo.insert_log(LogLevel::Info, "AUTH", "b", None, LogCategory::Security)
            .unwrap();
        assert_eq!(repo.get_sources().unwrap(), vec!["AUTH", "SYS"]);
        assert_eq!(repo.get_categories().unwrap(), vec!["security", "system"]);
    }

    #[test]
    fn clear_reports_deleted_count() {
        let repo = repo();
        repo.insert_log(LogLevel::Info, "SYS", "a", None, LogCategory::System)
            .unwrap();
        repo.insert_log(LogLevel::Info, "SYS", "b", None, LogCategory::System)
            .unwrap();
        assert_eq!(repo.clear_logs().unwrap(), 2);
        assert_eq!(repo.get_log_count(&LogFilter::default()).unwrap(), 0);
    }

    #[test]
    fn rejects_unknown_level_at_insert_time() {
        let repo = repo();
        // The CHECK constraint is the guard; LogLevel has no invalid variant.
        let result = repo.connection.execute(
            "INSERT INTO system_logs (id, timestamp, level, source, category, message, created_at)
             VALUES ('x', 't', 'fatal', 'SYS', 'system', 'm', 't')",
            [],
        );
        assert!(result.is_err());
    }
}
