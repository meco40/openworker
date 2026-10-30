//! Port of `src/server/world-model/services/actionService.ts:1-73`.

use std::future::Future;

use crate::world_model::db::{PgError, PgExecutor};
use crate::world_model::repositories::action_attempt_repository::{
    finish_action_attempt, start_action_attempt, ActionAttemptInput, ActionAttemptOutcome,
    ActionAttemptStatus, ToolActionResult,
};
use crate::world_model::scope::WorldModelScope;

#[derive(Debug, Clone)]
pub struct ExecuteActionInput {
    pub scope: WorldModelScope,
    pub task_id: Option<String>,
    pub action_type: String,
    pub idempotency_key: String,
    pub correlation_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActionRunResult {
    pub ok: bool,
    pub error: Option<String>,
    pub result: Option<ToolActionResult>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecuteActionResult {
    pub attempt_id: String,
    pub created: bool,
    pub succeeded: bool,
    pub error: Option<String>,
    pub result: Option<ToolActionResult>,
}

pub async fn execute_action<F, Fut>(
    executor: &dyn PgExecutor,
    input: &ExecuteActionInput,
    run: F,
) -> Result<ExecuteActionResult, PgError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<ActionRunResult, String>>,
{
    let started = start_action_attempt::<PgError>(
        executor,
        &input.scope,
        &ActionAttemptInput {
            task_id: input.task_id.clone(),
            action_type: input.action_type.clone(),
            idempotency_key: input.idempotency_key.clone(),
            correlation_id: input.correlation_id.clone(),
            result: None,
        },
    )
    .await?;
    if !started.created {
        let attempt = started.attempt;
        let failed = attempt.status == ActionAttemptStatus::Failed;
        return Ok(ExecuteActionResult {
            attempt_id: attempt.id,
            created: false,
            succeeded: attempt.status == ActionAttemptStatus::Succeeded,
            error: failed.then(|| "previous attempt failed".to_owned()),
            result: attempt.result,
        });
    }

    let result = run().await.unwrap_or_else(|error| ActionRunResult {
        ok: false,
        error: Some(error),
        result: None,
    });
    let succeeded = result.ok;
    finish_action_attempt::<PgError>(
        executor,
        Some(&input.scope),
        &started.attempt.id,
        if succeeded {
            ActionAttemptOutcome::Succeeded
        } else {
            ActionAttemptOutcome::Failed
        },
        result.result.as_ref(),
    )
    .await?;
    Ok(ExecuteActionResult {
        attempt_id: started.attempt.id,
        created: true,
        succeeded,
        error: result.error,
        result: result.result,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::RecordingExecutor;
    use crate::world_model::db::{drive_sync, PgQueryResult};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn scope() -> WorldModelScope {
        WorldModelScope::new("u1", "p1", Some("w1".to_owned()))
    }

    #[test]
    fn a_replayed_failed_attempt_does_not_run_the_side_effect_again() {
        let row = json!({
            "id": "attempt-1", "task_id": null, "user_id": "u1", "persona_id": "p1",
            "workspace_id": "w1", "action_type": "send", "status": "failed",
            "idempotency_key": "key", "correlation_id": null,
            "started_at": "2026-10-11T10:00:00.000Z", "finished_at": null,
            "output": {"result": {"providerId": "telegram"}}
        })
        .as_object()
        .expect("row")
        .clone();
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![row])),
        ]);
        let called = AtomicBool::new(false);
        let result = drive_sync(execute_action(
            &executor,
            &ExecuteActionInput {
                scope: scope(),
                task_id: None,
                action_type: "send".into(),
                idempotency_key: "key".into(),
                correlation_id: None,
            },
            || async {
                called.store(true, Ordering::SeqCst);
                Ok(ActionRunResult {
                    ok: true,
                    ..ActionRunResult::default()
                })
            },
        ))
        .expect("async bridge")
        .expect("action");
        assert!(!called.load(Ordering::SeqCst));
        assert!(!result.created);
        assert!(!result.succeeded);
        assert_eq!(result.error.as_deref(), Some("previous attempt failed"));
        assert_eq!(
            result.result.unwrap().provider_id.as_deref(),
            Some("telegram")
        );
    }
}
