//! Family migrations_wire: runs the SQLite migration runner once at startup.
//!
//! The integrator calls [`build`] before any repository is opened. It migrates
//! every database and returns [`Services`], which keeps the resolved paths for
//! the rest of the process.

use betaclaw_core::migration_runner::{run_all, DbPaths, MigrationError};

/// Database paths of a process whose databases have been migrated.
pub struct Services {
    pub paths: DbPaths,
}

/// Migrates every database in startup order, then keeps the paths.
pub fn build(paths: DbPaths) -> Result<Services, MigrationError> {
    run_all(&paths)?;
    Ok(Services { paths })
}
