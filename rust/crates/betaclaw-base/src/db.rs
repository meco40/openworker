//! SQLite opener with the exact pragmas of the TypeScript backend.
//!
//! Ported from `src/server/db/sqlite.ts:41-77`. The pragmas are part of the
//! storage contract: WAL plus a 30 s busy timeout is what allows the web and
//! scheduler processes to share the same `.db` files over the `app-data` volume.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

/// `SqliteSynchronousMode` from `src/server/db/sqlite.ts:5`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SynchronousMode {
    Off,
    Normal,
    Full,
    Extra,
}

impl SynchronousMode {
    fn as_str(self) -> &'static str {
        match self {
            SynchronousMode::Off => "OFF",
            SynchronousMode::Normal => "NORMAL",
            SynchronousMode::Full => "FULL",
            SynchronousMode::Extra => "EXTRA",
        }
    }
}

const DEFAULT_BUSY_TIMEOUT_MS: u32 = 30_000;

#[derive(Debug, Clone)]
pub struct OpenOptions {
    pub db_path: String,
    pub readonly: bool,
    pub busy_timeout_ms: u32,
    pub enable_wal: bool,
    pub enable_foreign_keys: bool,
    pub synchronous: SynchronousMode,
    pub additional_pragmas: Vec<String>,
}

impl OpenOptions {
    pub fn new(db_path: impl Into<String>) -> Self {
        Self {
            db_path: db_path.into(),
            readonly: false,
            busy_timeout_ms: DEFAULT_BUSY_TIMEOUT_MS,
            enable_wal: true,
            enable_foreign_keys: true,
            synchronous: SynchronousMode::Normal,
            additional_pragmas: Vec::new(),
        }
    }
}

/// True for `:memory:`, `file::memory:` and any URI containing `mode=memory`.
pub fn is_in_memory_path(db_path: &str) -> bool {
    let normalized = db_path.trim().to_ascii_lowercase();
    normalized == ":memory:"
        || normalized.starts_with("file::memory:")
        || normalized.contains("mode=memory")
}

fn resolve_db_path(db_path: &str, readonly: bool) -> PathBuf {
    if is_in_memory_path(db_path) {
        return PathBuf::from(db_path);
    }
    let path = PathBuf::from(db_path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !readonly {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    path
}

/// Applies the pragma set in the same order as `applySqlitePragmas`.
pub fn open(options: OpenOptions) -> rusqlite::Result<Connection> {
    let in_memory = is_in_memory_path(&options.db_path);
    let resolved = resolve_db_path(&options.db_path, options.readonly);

    let connection = if options.readonly {
        Connection::open_with_flags(
            &resolved,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?
    } else {
        Connection::open_with_flags(
            &resolved,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?
    };

    apply_pragmas(&connection, &options, in_memory)?;
    Ok(connection)
}

fn apply_pragmas(
    connection: &Connection,
    options: &OpenOptions,
    in_memory: bool,
) -> rusqlite::Result<()> {
    let busy_timeout = options.busy_timeout_ms.max(1);
    connection.execute_batch(&format!("PRAGMA busy_timeout = {busy_timeout};"))?;

    if options.enable_foreign_keys {
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    }

    // Page cache: 16 MB per connection, memory-mapped I/O: 128 MB.
    connection.execute_batch("PRAGMA cache_size = -16000;")?;
    connection.execute_batch("PRAGMA mmap_size = 134217728;")?;

    if !options.readonly {
        connection.execute_batch(&format!(
            "PRAGMA synchronous = {};",
            options.synchronous.as_str()
        ))?;
        connection.execute_batch("PRAGMA temp_store = MEMORY;")?;
        if options.enable_wal && !in_memory {
            connection.execute_batch("PRAGMA journal_mode = WAL;")?;
        }
    }

    for pragma in &options.additional_pragmas {
        let trimmed = pragma.trim();
        if !trimmed.is_empty() {
            connection.execute_batch(trimmed)?;
        }
    }

    Ok(())
}

/// Convenience helper for repositories that live in the shared `.local` volume.
pub fn default_db_path(file_name: &str) -> String {
    let base = std::env::var("WORKSPACE_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| ".".to_string());
    Path::new(&base)
        .join(".local")
        .join(file_name)
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_memory_paths() {
        assert!(is_in_memory_path(":memory:"));
        assert!(is_in_memory_path("file::memory:"));
        assert!(is_in_memory_path("file:x?mode=memory"));
        assert!(!is_in_memory_path(".local/logs.db"));
    }

    #[test]
    fn applies_wal_and_timeout() {
        let connection = open(OpenOptions::new(":memory:")).expect("open in-memory database");
        let busy_timeout: i64 = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(busy_timeout, DEFAULT_BUSY_TIMEOUT_MS as i64);
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn writes_and_reads_back() {
        let connection = open(OpenOptions::new(":memory:")).unwrap();
        connection
            .execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER);")
            .unwrap();
        connection
            .execute("INSERT INTO t VALUES ('a', 1)", [])
            .unwrap();
        let n: i64 = connection
            .query_row("SELECT n FROM t WHERE id = 'a'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
