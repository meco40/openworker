//! Port of `src/server/world-model/runtime/heartbeatRuntime.ts:1-36`.

use crate::world_model::db::{PgError, PgExecutor};
use crate::world_model::repositories::prospective_repository::list_overdue_open_loops;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::OpenLoopRecord;

#[derive(Debug, Clone, Copy, Default)]
pub struct HeartbeatRuntimeOptions {
    pub max_open_loop_age_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HeartbeatScanResult {
    pub overdue_open_loops: Vec<OpenLoopRecord>,
    pub needs_reconcile: bool,
    pub scanned_at: String,
}

pub async fn scan_heartbeat(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    options: HeartbeatRuntimeOptions,
    now: Option<&str>,
) -> Result<HeartbeatScanResult, PgError> {
    let scanned_at = now
        .map(str::to_owned)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let overdue_open_loops = list_overdue_open_loops::<PgError>(
        executor,
        scope,
        options.max_open_loop_age_ms.unwrap_or(24 * 60 * 60 * 1000),
        &scanned_at,
        100,
    )
    .await?;
    Ok(HeartbeatScanResult {
        needs_reconcile: !overdue_open_loops.is_empty(),
        overdue_open_loops,
        scanned_at,
    })
}

pub fn heartbeat_needs_action(result: &HeartbeatScanResult) -> bool {
    result.needs_reconcile
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult};

    #[test]
    fn scan_uses_default_age_and_reports_no_reconciliation_for_empty_result() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let result = drive_sync(scan_heartbeat(
            &executor,
            None,
            HeartbeatRuntimeOptions::default(),
            Some("2026-10-11T12:00:00.000Z"),
        ))
        .expect("async bridge")
        .expect("scan");
        assert!(!heartbeat_needs_action(&result));
        assert_eq!(result.scanned_at, "2026-10-11T12:00:00.000Z");
        let calls = executor.calls();
        let call = calls.last().expect("query");
        assert!(call.sql().contains("updated_at <= $1"));
        let Recorded::Statement(statement) = call else {
            panic!("expected query statement")
        };
        assert_eq!(
            statement.params,
            &[
                crate::world_model::db::PgValue::text("2026-10-10T12:00:00.000Z"),
                crate::world_model::db::PgValue::int(100)
            ]
        );
    }
}
