//! Port of `src/server/master/repository/db.ts:1-11`.
//!
//! `createMasterSqliteDb` opens the SQLite file with the shared pragma set
//! (`src/server/db/sqlite.ts`, mirrored by [`crate::db`]) and runs
//! [`run_master_migrations`]. The TypeScript type alias `MasterSqliteDb` is a
//! `better-sqlite3` `Database`; in Rust it is the `rusqlite::Connection` the
//! stores take.
//!
//! The default path `MASTER_DB_PATH || '.local/master.db'` used by
//! `sqliteMasterRepository.ts:98` is resolved by [`default_master_db_path`],
//! anchored at `WORKSPACE_ROOT/.local` through [`crate::db::default_db_path`] so
//! the gateway and the scheduler agree on the file from any working directory —
//! the same resolution the S1/S3 stores use.

use rusqlite::Connection;

use crate::db::{default_db_path, open, OpenOptions};
use crate::master::migrations::run_master_migrations;

/// `MasterSqliteDb` from `repository/db.ts:5`.
pub type MasterSqliteDb = Connection;

/// `createMasterSqliteDb` from `repository/db.ts:7-11`.
pub fn create_master_sqlite_db(db_path: &str) -> rusqlite::Result<MasterSqliteDb> {
    let connection = open(OpenOptions::new(db_path))?;
    run_master_migrations(&connection)?;
    Ok(connection)
}

/// `process.env.MASTER_DB_PATH || '.local/master.db'` from
/// `sqliteMasterRepository.ts:98`.
pub fn default_master_db_path() -> String {
    std::env::var("MASTER_DB_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_db_path("master.db"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::migrations::has_column;

    #[test]
    fn opens_and_migrates() {
        let connection = create_master_sqlite_db(":memory:").unwrap();
        assert!(has_column(&connection, "master_runs", "id").unwrap());
    }
}
