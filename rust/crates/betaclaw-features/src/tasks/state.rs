//! Port of the status rules inside `updateTask` (`src/server/tasks/taskService.ts:237-318`)
//! and of the completion decision in `finalizeDispatch` (`dispatch/finalizeDispatch.ts:30-112`).
//!
//! Pure functions without SQL. The repositories read the rows, call these rules
//! and apply the result in the order of the source.

use super::non_empty;

/// The approval gate of `updateTask` (`taskService.ts:237`). The gate applies only
/// when the request names an updating agent.
pub fn approval_requested(
    existing_status: &str,
    requested_status: Option<&str>,
    updated_by_agent_id: Option<&str>,
) -> bool {
    requested_status == Some("done")
        && existing_status == "review"
        && non_empty(updated_by_agent_id).is_some()
}

/// Only a master agent may approve. An unknown agent is refused as well.
pub fn approval_allowed(updater_is_master: Option<bool>) -> bool {
    updater_is_master == Some(true)
}

/// What a status change writes and triggers in `updateTask`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatusChangePlan {
    /// `task_completed` for `done`, `task_status_changed` otherwise.
    pub event_type: &'static str,
    /// `shouldDispatch` when the task is set to `assigned` and already has an assignee.
    pub dispatch: bool,
    /// `shouldAutoTest` when the task is set to `testing`.
    pub auto_test: bool,
}

/// `None` when the requested status is absent or equals the stored one, which
/// means that `updateTask` writes no status event.
pub fn plan_status_change(
    existing_status: &str,
    existing_assigned_agent_id: Option<&str>,
    requested_status: Option<&str>,
) -> Option<StatusChangePlan> {
    let requested = requested_status?;
    if requested == existing_status {
        return None;
    }
    Some(StatusChangePlan {
        event_type: if requested == "done" {
            "task_completed"
        } else {
            "task_status_changed"
        },
        dispatch: requested == "assigned" && non_empty(existing_assigned_agent_id).is_some(),
        auto_test: requested == "testing",
    })
}

/// `shouldDispatch` of the assignment branch (`taskService.ts:313`): a new assignee
/// while the task is `assigned` now or is being set to `assigned`.
pub fn assignment_dispatch(existing_status: &str, requested_status: Option<&str>) -> bool {
    existing_status == "assigned" || requested_status == Some("assigned")
}

/// The effects of `finalizeDispatch` on the task status after a completion report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompletionPlan {
    /// The status is moved to `testing`.
    pub set_testing: bool,
    /// The deliverables are registered and the automated test is requested.
    pub auto_test: bool,
}

pub fn completion_plan(task_status: &str) -> CompletionPlan {
    CompletionPlan {
        set_testing: !matches!(task_status, "testing" | "review" | "done"),
        auto_test: !matches!(task_status, "review" | "done"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_gate_applies_only_to_review_to_done_with_an_updater() {
        assert!(approval_requested("review", Some("done"), Some("agent-1")));
        assert!(!approval_requested("review", Some("done"), None));
        assert!(!approval_requested("review", Some("done"), Some("")));
        assert!(!approval_requested(
            "assigned",
            Some("done"),
            Some("agent-1")
        ));
        assert!(!approval_requested(
            "review",
            Some("testing"),
            Some("agent-1")
        ));
    }

    #[test]
    fn only_a_known_master_passes_the_approval_gate() {
        assert!(approval_allowed(Some(true)));
        assert!(!approval_allowed(Some(false)));
        assert!(!approval_allowed(None));
    }

    #[test]
    fn same_status_writes_no_status_event() {
        assert_eq!(plan_status_change("inbox", None, Some("inbox")), None);
        assert_eq!(plan_status_change("inbox", None, None), None);
    }

    #[test]
    fn done_is_a_completion_event_and_others_are_status_changes() {
        let done = plan_status_change("review", None, Some("done")).unwrap();
        assert_eq!(done.event_type, "task_completed");
        let inbox = plan_status_change("done", None, Some("inbox")).unwrap();
        assert_eq!(inbox.event_type, "task_status_changed");
    }

    #[test]
    fn assigned_dispatches_only_with_an_existing_assignee() {
        assert!(
            plan_status_change("inbox", Some("agent-1"), Some("assigned"))
                .unwrap()
                .dispatch
        );
        assert!(
            !plan_status_change("inbox", None, Some("assigned"))
                .unwrap()
                .dispatch
        );
        assert!(
            !plan_status_change("inbox", Some(""), Some("assigned"))
                .unwrap()
                .dispatch
        );
    }

    #[test]
    fn testing_requests_the_automated_test() {
        assert!(
            plan_status_change("in_progress", None, Some("testing"))
                .unwrap()
                .auto_test
        );
        assert!(
            !plan_status_change("in_progress", None, Some("review"))
                .unwrap()
                .auto_test
        );
    }

    #[test]
    fn assignment_dispatches_when_the_task_is_or_becomes_assigned() {
        assert!(assignment_dispatch("assigned", None));
        assert!(assignment_dispatch("inbox", Some("assigned")));
        assert!(!assignment_dispatch("inbox", Some("inbox")));
    }

    #[test]
    fn completion_moves_active_tasks_to_testing_and_tests_them() {
        assert_eq!(
            completion_plan("in_progress"),
            CompletionPlan {
                set_testing: true,
                auto_test: true
            }
        );
        assert_eq!(
            completion_plan("testing"),
            CompletionPlan {
                set_testing: false,
                auto_test: true
            }
        );
        assert_eq!(
            completion_plan("review"),
            CompletionPlan {
                set_testing: false,
                auto_test: false
            }
        );
        assert_eq!(completion_plan("done"), completion_plan("review"));
    }
}
