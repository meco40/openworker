//! Port of `src/server/channels/messages/service/subagent/actions/kill.ts`.

use serde_json::json;

use super::super::registry::{SubagentRegistry, SubagentRunStatus};
use super::super::types::{ActionResult, SubagentTargetResult};
use super::super::utils::{object, short_id};

const STOPPED_BY_REQUESTER: &str = "Subagent run was stopped by requester.";

/// `executeKillAllAction(conversationId)`.
pub fn execute_kill_all_action(
    registry: &dyn SubagentRegistry,
    conversation_id: &str,
) -> ActionResult {
    let active = registry.list_active_runs(conversation_id);
    let mut killed = 0usize;
    for run in &active {
        let was_running = registry.abort_run(&run.run_id, STOPPED_BY_REQUESTER);
        if was_running || run.status == SubagentRunStatus::Running {
            killed += 1;
        }
    }
    let text = if killed > 0 {
        let noun = if killed == 1 { "subagent" } else { "subagents" };
        format!("Killed {killed} {noun}.")
    } else {
        "No running subagents.".to_string()
    };
    ActionResult {
        text,
        payload: object(json!({
            "status": "ok",
            "action": "kill",
            "target": "all",
            "killed": killed,
        })),
    }
}

/// `executeKillTargetAction(target, resolved)`.
pub fn execute_kill_target_action(
    registry: &dyn SubagentRegistry,
    target: &str,
    resolved: &SubagentTargetResult,
) -> ActionResult {
    let Some(run) = &resolved.run else {
        let error = resolved
            .error
            .clone()
            .unwrap_or_else(|| "Unknown subagent target.".to_string());
        return ActionResult {
            text: error.clone(),
            payload: object(json!({
                "status": "error",
                "action": "kill",
                "target": target,
                "error": error,
            })),
        };
    };

    let was_running = registry.abort_run(&run.run_id, STOPPED_BY_REQUESTER);
    if !was_running {
        registry.mark_run_killed(&run.run_id, STOPPED_BY_REQUESTER);
    }
    ActionResult {
        text: format!("Killed {} ({}).", run.agent_id, short_id(&run.run_id)),
        payload: object(json!({
            "status": "ok",
            "action": "kill",
            "target": target,
            "runId": run.run_id,
        })),
    }
}

/// `formatKillMissingTargetError()`.
pub fn format_kill_missing_target_error() -> ActionResult {
    ActionResult {
        text: "Usage: /subagents kill <id|#|all>".to_string(),
        payload: object(json!({
            "status": "error",
            "action": "kill",
            "error": "Missing target.",
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::execution::test_doubles::{run_record, FakeRegistry};
    use crate::channels::messages::service::subagent::registry::SubagentRunStatus;

    #[test]
    fn kill_all_stops_running_runs_and_counts_them() {
        let registry = FakeRegistry::default();
        registry.seed(run_record(
            "subagent-one",
            "conv",
            SubagentRunStatus::Running,
        ));
        registry.seed(run_record(
            "subagent-two",
            "conv",
            SubagentRunStatus::Completed,
        ));

        let result = execute_kill_all_action(&registry, "conv");
        assert_eq!(result.text, "Killed 1 subagent.");
        assert_eq!(result.payload["killed"], json!(1));
        assert_eq!(
            registry.get("subagent-one").status,
            SubagentRunStatus::Killed
        );
        assert_eq!(
            registry.get("subagent-two").status,
            SubagentRunStatus::Completed
        );
    }

    #[test]
    fn kill_unknown_target_returns_the_resolver_error() {
        let registry = FakeRegistry::default();
        let resolved = SubagentTargetResult {
            run: None,
            error: Some("Unknown target 9.".to_string()),
        };
        let result = execute_kill_target_action(&registry, "9", &resolved);
        assert_eq!(result.text, "Unknown target 9.");
        assert_eq!(result.payload["status"], json!("error"));
    }
}
