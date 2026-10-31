//! Port of `src/server/master/lifecycle.ts:1-47`.
//!
//! The run state machine. [`TRANSITIONS`] is the `TRANSITIONS` record of
//! `lifecycle.ts:3-15` transcribed one arm per status, and the three functions
//! below keep the source's order of decisions — `nextLifecycleStatus` checks
//! `failed`, then `cancelled`, then `needsApproval` *before* it looks at the
//! current status, so a failing run becomes `FAILED` from any state.
//!
//! # `assertTransition` throws, so the port returns
//!
//! `assertTransition` signals an invalid edge by throwing, and the only caller
//! is `MasterOrchestrator.advanceRun`. Rust has no exceptions, so the port
//! returns [`MasterLifecycleError::InvalidTransition`] with the exact
//! TypeScript message (`lifecycle.ts:23`) and the orchestrator propagates it.

use crate::master::types::MasterRunStatus;

/// `TRANSITIONS` from `lifecycle.ts:3-15`.
///
/// `COMPLETED`, `CANCELLED` and `FAILED` are terminal: the record lists an empty
/// array for them, which `canTransition` turns into "never".
pub const TRANSITIONS: &[(MasterRunStatus, &[MasterRunStatus])] = &[
    (
        MasterRunStatus::Idle,
        &[MasterRunStatus::Analyzing, MasterRunStatus::Cancelled],
    ),
    (
        MasterRunStatus::Analyzing,
        &[
            MasterRunStatus::Planning,
            MasterRunStatus::Failed,
            MasterRunStatus::Cancelled,
        ],
    ),
    (
        MasterRunStatus::Planning,
        &[
            MasterRunStatus::Delegating,
            MasterRunStatus::Executing,
            MasterRunStatus::Failed,
            MasterRunStatus::Cancelled,
        ],
    ),
    (
        MasterRunStatus::Delegating,
        &[
            MasterRunStatus::Executing,
            MasterRunStatus::Verifying,
            MasterRunStatus::Failed,
            MasterRunStatus::Cancelled,
        ],
    ),
    (
        MasterRunStatus::Executing,
        &[
            MasterRunStatus::Verifying,
            MasterRunStatus::Refining,
            MasterRunStatus::AwaitingApproval,
            MasterRunStatus::Failed,
            MasterRunStatus::Cancelled,
        ],
    ),
    (
        MasterRunStatus::Verifying,
        &[
            MasterRunStatus::Completed,
            MasterRunStatus::Refining,
            MasterRunStatus::Failed,
            MasterRunStatus::Cancelled,
        ],
    ),
    (
        MasterRunStatus::Refining,
        &[
            MasterRunStatus::Planning,
            MasterRunStatus::Executing,
            MasterRunStatus::Failed,
            MasterRunStatus::Cancelled,
        ],
    ),
    (
        MasterRunStatus::AwaitingApproval,
        &[
            MasterRunStatus::Executing,
            MasterRunStatus::Refining,
            MasterRunStatus::Failed,
            MasterRunStatus::Cancelled,
        ],
    ),
    (MasterRunStatus::Completed, &[]),
    (MasterRunStatus::Cancelled, &[]),
    (MasterRunStatus::Failed, &[]),
];

/// The successor list of one status — `TRANSITIONS[from]`.
pub fn transitions(from: MasterRunStatus) -> &'static [MasterRunStatus] {
    TRANSITIONS
        .iter()
        .find(|(status, _)| *status == from)
        .map(|(_, successors)| *successors)
        .unwrap_or(&[])
}

/// `Invalid master run transition: ${from} -> ${to}` — `lifecycle.ts:23`.
#[derive(Debug, thiserror::Error)]
pub enum MasterLifecycleError {
    #[error("Invalid master run transition: {from} -> {to}")]
    InvalidTransition {
        from: MasterRunStatus,
        to: MasterRunStatus,
    },
}

/// `canTransition` — `lifecycle.ts:17-19`.
pub fn can_transition(from: MasterRunStatus, to: MasterRunStatus) -> bool {
    transitions(from).contains(&to)
}

/// `assertTransition` — `lifecycle.ts:21-25`.
pub fn assert_transition(
    from: MasterRunStatus,
    to: MasterRunStatus,
) -> Result<(), MasterLifecycleError> {
    if can_transition(from, to) {
        return Ok(());
    }
    Err(MasterLifecycleError::InvalidTransition { from, to })
}

/// `options` of `nextLifecycleStatus` — `lifecycle.ts:29-34`.
///
/// Every flag is optional in the source; `None` is the absent property. The
/// checks are truthiness tests on `boolean | undefined`, so `Some(false)` and
/// `None` behave identically and the private `flag` helper keeps that explicit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LifecycleOptions {
    pub verification_passed: Option<bool>,
    pub needs_approval: Option<bool>,
    pub failed: Option<bool>,
    pub cancelled: Option<bool>,
}

impl LifecycleOptions {
    /// `Boolean(value)` for an optional flag — `undefined`/`false` are falsy.
    fn flag(value: Option<bool>) -> bool {
        matches!(value, Some(true))
    }
}

/// `nextLifecycleStatus` — `lifecycle.ts:27-47`.
///
/// The order is the behaviour: the three overrides come first, then the
/// status-specific successor, and an unlisted status is returned unchanged.
pub fn next_lifecycle_status(
    status: MasterRunStatus,
    options: &LifecycleOptions,
) -> MasterRunStatus {
    if LifecycleOptions::flag(options.failed) {
        return MasterRunStatus::Failed;
    }
    if LifecycleOptions::flag(options.cancelled) {
        return MasterRunStatus::Cancelled;
    }
    if LifecycleOptions::flag(options.needs_approval) {
        return MasterRunStatus::AwaitingApproval;
    }
    match status {
        MasterRunStatus::Analyzing => MasterRunStatus::Planning,
        MasterRunStatus::Planning => MasterRunStatus::Delegating,
        MasterRunStatus::Delegating => MasterRunStatus::Executing,
        MasterRunStatus::Executing => MasterRunStatus::Verifying,
        MasterRunStatus::Verifying => {
            if LifecycleOptions::flag(options.verification_passed) {
                MasterRunStatus::Completed
            } else {
                MasterRunStatus::Refining
            }
        }
        MasterRunStatus::Refining => MasterRunStatus::Planning,
        MasterRunStatus::AwaitingApproval => MasterRunStatus::Executing,
        // `return status` covers IDLE and the three terminal states.
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use MasterRunStatus::*;

    fn names(statuses: &[MasterRunStatus]) -> Vec<&'static str> {
        statuses.iter().map(|status| status.as_str()).collect()
    }

    #[test]
    fn the_transition_table_matches_the_source() {
        assert_eq!(names(transitions(Idle)), vec!["ANALYZING", "CANCELLED"]);
        assert_eq!(
            names(transitions(Analyzing)),
            vec!["PLANNING", "FAILED", "CANCELLED"]
        );
        assert_eq!(
            names(transitions(Planning)),
            vec!["DELEGATING", "EXECUTING", "FAILED", "CANCELLED"]
        );
        assert_eq!(
            names(transitions(Delegating)),
            vec!["EXECUTING", "VERIFYING", "FAILED", "CANCELLED"]
        );
        assert_eq!(
            names(transitions(Executing)),
            vec![
                "VERIFYING",
                "REFINING",
                "AWAITING_APPROVAL",
                "FAILED",
                "CANCELLED"
            ]
        );
        assert_eq!(
            names(transitions(Verifying)),
            vec!["COMPLETED", "REFINING", "FAILED", "CANCELLED"]
        );
        assert_eq!(
            names(transitions(Refining)),
            vec!["PLANNING", "EXECUTING", "FAILED", "CANCELLED"]
        );
        assert_eq!(
            names(transitions(AwaitingApproval)),
            vec!["EXECUTING", "REFINING", "FAILED", "CANCELLED"]
        );
        for terminal in [Completed, Cancelled, Failed] {
            assert!(transitions(terminal).is_empty(), "{terminal}");
        }
        // Every status has exactly one arm, so no lookup falls through.
        assert_eq!(TRANSITIONS.len(), 11);
    }

    #[test]
    fn terminal_statuses_have_no_successor_and_others_do() {
        assert!(!can_transition(Completed, Cancelled));
        assert!(!can_transition(Completed, Analyzing));
        assert!(!can_transition(Cancelled, Idle));
        assert!(!can_transition(Failed, Executing));
        assert!(can_transition(Idle, Analyzing));
        // REFINING -> VERIFYING is not an edge; REFINING -> PLANNING is.
        assert!(!can_transition(Refining, Verifying));
        assert!(can_transition(Refining, Planning));
        assert!(!can_transition(AwaitingApproval, Verifying));
    }

    #[test]
    fn assert_transition_reports_the_source_message() {
        assert!(assert_transition(Idle, Analyzing).is_ok());
        let error = assert_transition(Completed, Executing).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid master run transition: COMPLETED -> EXECUTING"
        );
    }

    #[test]
    fn overrides_win_over_the_status_chain_and_are_checked_in_order() {
        // failed > cancelled > needsApproval.
        let options = LifecycleOptions {
            failed: Some(true),
            cancelled: Some(true),
            needs_approval: Some(true),
            verification_passed: Some(true),
        };
        assert_eq!(next_lifecycle_status(Analyzing, &options), Failed);

        let options = LifecycleOptions {
            cancelled: Some(true),
            needs_approval: Some(true),
            ..LifecycleOptions::default()
        };
        assert_eq!(next_lifecycle_status(Analyzing, &options), Cancelled);

        let options = LifecycleOptions {
            needs_approval: Some(true),
            ..LifecycleOptions::default()
        };
        assert_eq!(next_lifecycle_status(Executing, &options), AwaitingApproval);

        // A falsy flag is the same as an absent one.
        let absent = next_lifecycle_status(Executing, &LifecycleOptions::default());
        let falsy = next_lifecycle_status(
            Executing,
            &LifecycleOptions {
                cancelled: Some(false),
                failed: Some(false),
                ..LifecycleOptions::default()
            },
        );
        assert_eq!(absent, Verifying);
        assert_eq!(falsy, Verifying);
    }

    #[test]
    fn the_chain_walks_the_planned_path() {
        let default = LifecycleOptions::default();
        assert_eq!(next_lifecycle_status(Analyzing, &default), Planning);
        assert_eq!(next_lifecycle_status(Planning, &default), Delegating);
        assert_eq!(next_lifecycle_status(Delegating, &default), Executing);
        assert_eq!(next_lifecycle_status(Executing, &default), Verifying);
        assert_eq!(next_lifecycle_status(Refining, &default), Planning);
        assert_eq!(next_lifecycle_status(AwaitingApproval, &default), Executing);
    }

    #[test]
    fn verifying_depends_on_the_verification_flag() {
        assert_eq!(
            next_lifecycle_status(Verifying, &LifecycleOptions::default()),
            Refining
        );
        assert_eq!(
            next_lifecycle_status(
                Verifying,
                &LifecycleOptions {
                    verification_passed: Some(true),
                    ..LifecycleOptions::default()
                }
            ),
            Completed
        );
        assert_eq!(
            next_lifecycle_status(
                Verifying,
                &LifecycleOptions {
                    verification_passed: Some(false),
                    ..LifecycleOptions::default()
                }
            ),
            Refining
        );
    }

    #[test]
    fn unlisted_statuses_are_returned_unchanged() {
        let default = LifecycleOptions::default();
        for status in [Idle, Completed, Cancelled, Failed] {
            assert_eq!(next_lifecycle_status(status, &default), status);
        }
    }
}
