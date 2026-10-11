//! Port of `src/server/world-model/services/canonicalTaskService.ts:1-40`.

use crate::world_model::types::TaskStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskTransitionReason {
    NotFound,
    InvalidTransition,
    Ok,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskTransitionResult {
    pub allowed: bool,
    pub from: TaskStatus,
    pub to: TaskStatus,
    pub reason: TaskTransitionReason,
}

pub fn can_transition_task(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus::*;
    match from {
        Proposed => matches!(to, Planned | Cancelled | InProgress | Completed),
        Planned => matches!(to, InProgress | Waiting | Cancelled | Failed),
        InProgress => matches!(to, Completed | Failed | Waiting | Cancelled),
        Waiting => matches!(to, InProgress | Cancelled | Failed | Completed),
        Completed | Cancelled => false,
        Failed => matches!(to, InProgress | Planned),
    }
}

pub fn resolve_task_transition(from: Option<TaskStatus>, to: TaskStatus) -> TaskTransitionResult {
    let from = from.unwrap_or(TaskStatus::Proposed);
    let allowed = can_transition_task(from, to) || from == TaskStatus::Proposed;
    TaskTransitionResult {
        allowed,
        from,
        to,
        reason: if allowed {
            TaskTransitionReason::Ok
        } else {
            TaskTransitionReason::InvalidTransition
        },
    }
}

pub fn is_task_completion_allowed(current: Option<TaskStatus>) -> bool {
    current != Some(TaskStatus::Completed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use TaskStatus::*;

    #[test]
    fn transition_table_preserves_terminal_and_retry_states() {
        assert!(can_transition_task(Planned, Waiting));
        assert!(can_transition_task(Failed, Planned));
        assert!(!can_transition_task(Completed, InProgress));
        assert!(resolve_task_transition(None, Completed).allowed);
        assert!(!resolve_task_transition(Some(Completed), InProgress).allowed);
        assert!(!is_task_completion_allowed(Some(Completed)));
    }
}
