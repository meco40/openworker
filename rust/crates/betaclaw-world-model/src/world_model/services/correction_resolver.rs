//! Port of `src/server/world-model/services/correctionResolver.ts:1-46`.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `CorrectionResolution` (`:3-7`) | [`CorrectionResolution`] |
//! | `resolveCorrection` (`:19-37`) | [`resolve_correction`] |
//! | `applyCancellationForReplacement` (`:43-49`) | [`apply_cancellation_for_replacement`] |
//!
//! The source reads the event by id and then updates its status. The port keeps the
//! same two repository calls on the ambient scope, passed as an argument.

use crate::world_model::db::{PgError, PgExecutor};
use crate::world_model::repositories::event_repository::{get_event_by_id, update_event_status};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::EventStatus;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CorrectionAction {
    None,
    CancelOld,
    Replace,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrectionResolution {
    pub action: CorrectionAction,
    pub replaced_event_id: Option<String>,
    pub reason: Option<String>,
}

pub fn resolve_correction(
    old_status: &str,
    old_event_id: &str,
    new_event_proposed: bool,
    kind: &str,
) -> CorrectionResolution {
    if kind == "cancellation" {
        return CorrectionResolution {
            action: CorrectionAction::CancelOld,
            replaced_event_id: Some(old_event_id.into()),
            reason: Some("user cancelled".into()),
        };
    }
    if kind == "change" && new_event_proposed && old_status == "planned" {
        return CorrectionResolution {
            action: CorrectionAction::Replace,
            replaced_event_id: Some(old_event_id.into()),
            reason: Some("replaced by a new plan".into()),
        };
    }
    CorrectionResolution {
        action: CorrectionAction::None,
        replaced_event_id: None,
        reason: None,
    }
}

/// `applyCancellationForReplacement(eventId)` — `correctionResolver.ts:43-49`.
///
/// `Ok(true)` when the event exists and is now `cancelled`; `Ok(false)` when it does
/// not exist or is already cancelled, in which case nothing is written.
pub async fn apply_cancellation_for_replacement<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    event_id: &str,
) -> Result<bool, E> {
    let Some(event) = get_event_by_id::<E>(executor, scope, event_id, None).await? else {
        return Ok(false);
    };
    if event.status == EventStatus::Cancelled {
        return Ok(false);
    }
    update_event_status::<E>(executor, scope, event_id, EventStatus::Cancelled, None).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{PgQueryResult, PgRow};
    use serde_json::json;

    fn event_row(status: &str) -> PgRow {
        json!({ "id": "e1", "status": status })
            .as_object()
            .unwrap()
            .clone()
    }

    #[test]
    fn a_replacement_links_only_a_planned_event() {
        assert_eq!(
            resolve_correction("planned", "e1", true, "change").action,
            CorrectionAction::Replace
        );
        assert_eq!(
            resolve_correction("completed", "e1", true, "change").action,
            CorrectionAction::None
        );
        assert_eq!(
            resolve_correction("cancelled", "e1", false, "cancellation")
                .reason
                .as_deref(),
            Some("user cancelled")
        );
    }

    #[test]
    fn a_missing_event_is_not_cancelled() {
        let recorder = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let cancelled = drive_sync(apply_cancellation_for_replacement::<PgError>(
            &recorder, None, "e1",
        ))
        .expect("bridge")
        .expect("lookup");
        assert!(!cancelled);
        assert_eq!(recorder.calls().len(), 1);
    }

    #[test]
    fn an_already_cancelled_event_is_not_written_again() {
        let recorder = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![event_row(
            "cancelled",
        )]))]);
        let cancelled = drive_sync(apply_cancellation_for_replacement::<PgError>(
            &recorder, None, "e1",
        ))
        .expect("bridge")
        .expect("lookup");
        assert!(!cancelled);
        assert_eq!(recorder.calls().len(), 1);
    }

    #[test]
    fn an_open_event_is_cancelled_with_one_update() {
        let recorder = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![event_row("planned")])),
            Ok(PgQueryResult::affected(1)),
        ]);
        let cancelled = drive_sync(apply_cancellation_for_replacement::<PgError>(
            &recorder, None, "e1",
        ))
        .expect("bridge")
        .expect("cancel");
        assert!(cancelled);
        let calls = recorder.calls();
        assert_eq!(calls.len(), 2);
        match &calls[1] {
            Recorded::Statement(statement) => {
                assert_eq!(
                    statement.params[1],
                    crate::world_model::db::PgValue::text("cancelled")
                )
            }
            Recorded::Release => panic!("the status update issues no release"),
        }
    }
}
