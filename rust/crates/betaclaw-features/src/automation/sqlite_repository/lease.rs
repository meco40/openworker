//! Port of `src/server/automation/sqlite-automation-repository/lease.ts`.
//!
//! One row (`scheduler-singleton`) in `automation_scheduler_lease` names the instance that
//! may run the scheduler tick. Another instance takes over only after `ttl_ms` without an
//! update.

use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension};

use crate::automation::row_mappers::to_lease;
use crate::automation::types::SchedulerLeaseState;

const LEASE_KEY: &str = "scheduler-singleton";

fn millis(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

/// `acquireLease`. An unreadable timestamp never satisfies the expiry check, as `NaN` does in
/// TypeScript.
pub fn acquire_lease(
    connection: &Connection,
    instance_id: &str,
    ttl_ms: i64,
    now_iso: &str,
) -> rusqlite::Result<bool> {
    let existing = connection
        .query_row(
            "SELECT * FROM automation_scheduler_lease WHERE singleton_key = ?1",
            params![LEASE_KEY],
            to_lease,
        )
        .optional()?;

    let Some(existing) = existing else {
        connection.execute(
            "INSERT INTO automation_scheduler_lease (singleton_key, instance_id, heartbeat_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![LEASE_KEY, instance_id, now_iso, now_iso],
        )?;
        return Ok(true);
    };

    let expired_at = millis(&existing.updated_at).map(|updated| updated + ttl_ms);
    let now = millis(now_iso);
    let expired = matches!((now, expired_at), (Some(now), Some(expired)) if now > expired);

    if existing.instance_id == instance_id || expired {
        connection.execute(
            "UPDATE automation_scheduler_lease
             SET instance_id = ?1, heartbeat_at = ?2, updated_at = ?3
             WHERE singleton_key = ?4",
            params![instance_id, now_iso, now_iso, LEASE_KEY],
        )?;
        return Ok(true);
    }

    Ok(false)
}

pub fn release_lease(connection: &Connection, instance_id: &str) -> rusqlite::Result<()> {
    connection.execute(
        "DELETE FROM automation_scheduler_lease WHERE singleton_key = ?1 AND instance_id = ?2",
        params![LEASE_KEY, instance_id],
    )?;
    Ok(())
}

pub fn get_lease_state(connection: &Connection) -> rusqlite::Result<Option<SchedulerLeaseState>> {
    connection
        .query_row(
            "SELECT * FROM automation_scheduler_lease WHERE singleton_key = ?1",
            params![LEASE_KEY],
            to_lease,
        )
        .optional()
}
