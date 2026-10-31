//! Port of `src/server/master/learning.ts:1-34`.
//!
//! The daily learning loop: decide whether the cycle may run for the current
//! scope and hand the work to the capability understanding loop.
//!
//! # Time zones: the source mixes UTC and local time
//!
//! `isLearningWindow` delegates to `shouldRunLearningCycleAt`, which reads
//! `getUTCHours()`/`getUTCMinutes()`, while `runDailyLearningLoop` builds
//! `scheduledAt` from `getFullYear()`/`getMonth()`/`getDate()`, i.e. the *local*
//! date. The port keeps both: the instant travels as [`chrono::DateTime<Local>`]
//! so the wall-clock date matches `Date`, and the window test converts to UTC
//! before reading hours and minutes.
//!
//! # `capabilities/understandingLoop.ts` is package P5
//!
//! `learning.ts:3-6` imports [`runCapabilityUnderstandingCycle`] and
//! `shouldRunLearningCycleAt` from `master/capabilities/`, which is package P5
//! and not ported yet. Both are modelled as the
//! [`CapabilityUnderstandingCycle`] seam (see OP-S9-6) instead of being
//! duplicated here, so there stays exactly one implementation of the cycle.
//! The seam is synchronous: the only `await` in the source is inside the P5
//! cycle, and every S9 reader in this package is synchronous SQLite work.

use chrono::{DateTime, Datelike, Local, Utc};

use crate::master::repository::MasterRepository;
use crate::master::types::{MasterFeedbackPolicy, WorkspaceScope};

/// `LearningPolicyRecommendation` from `learning.ts:8`.
///
/// The union is `'safe' | 'balanced' | 'fast'`, spelled exactly like
/// `MasterFeedbackPolicy` (`shared/masterTypes.ts:58`), so the port reuses that
/// enum instead of declaring a second one with the same three literals.
pub type LearningPolicyRecommendation = MasterFeedbackPolicy;

/// `input` of `recommendLearningPolicy` — `learning.ts:10-13`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LearningPolicyInput {
    pub failure_rate: f64,
    pub verify_pass_rate: f64,
}

/// `recommendLearningPolicy` — `learning.ts:10-17`.
///
/// The order matters: a high failure rate wins over a high pass rate.
pub fn recommend_learning_policy(input: &LearningPolicyInput) -> LearningPolicyRecommendation {
    if input.failure_rate > 0.2 {
        return MasterFeedbackPolicy::Safe;
    }
    if input.verify_pass_rate > 0.9 {
        return MasterFeedbackPolicy::Fast;
    }
    MasterFeedbackPolicy::Balanced
}

/// `{ updated, executed }` — the return of `runCapabilityUnderstandingCycle`
/// (`understandingLoop.ts:92`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilityUnderstandingCycleOutcome {
    pub updated: usize,
    pub executed: bool,
}

/// Seam for `src/server/master/capabilities/understandingLoop.ts` (package P5).
///
/// The two functions `learning.ts` consumes. The cycle itself — the AI
/// confidence bump, the benchmark-summary rewrite and the
/// `upsertCapabilityScore` writes — belongs to P5; nothing of it is guessed
/// here.
pub trait CapabilityUnderstandingCycle: Send + Sync {
    /// `shouldRunLearningCycleAt` — `understandingLoop.ts:6-8`.
    ///
    /// `date.getUTCHours() === 3 && date.getUTCMinutes() === 0`.
    fn should_run_learning_cycle_at(&self, date: DateTime<Utc>) -> bool;

    /// `runCapabilityUnderstandingCycle` — `understandingLoop.ts:88-126`.
    fn run_capability_understanding_cycle(
        &self,
        repo: &dyn MasterRepository,
        scope: &WorkspaceScope,
        now: DateTime<Local>,
    ) -> rusqlite::Result<CapabilityUnderstandingCycleOutcome>;
}

/// `{ executed, updated, scheduledAt }` — `learning.ts:23`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyLearningLoopResult {
    pub executed: bool,
    pub updated: usize,
    pub scheduled_at: String,
}

/// `runDailyLearningLoop` — `learning.ts:19-30`.
///
/// `scheduledAt` is `${getFullYear()}-${MM}-${DD} 03:00` with the month and day
/// zero-padded to two digits and the year not padded, so the text is always
/// `"<year>-<MM>-<DD> 03:00"`.
pub fn run_daily_learning_loop(
    cycle: &dyn CapabilityUnderstandingCycle,
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    now: DateTime<Local>,
) -> rusqlite::Result<DailyLearningLoopResult> {
    let outcome = cycle.run_capability_understanding_cycle(repo, scope, now)?;
    Ok(DailyLearningLoopResult {
        executed: outcome.executed,
        updated: outcome.updated,
        scheduled_at: format!("{}-{:02}-{:02} 03:00", now.year(), now.month(), now.day()),
    })
}

/// `isLearningWindow` — `learning.ts:32-34`.
pub fn is_learning_window(cycle: &dyn CapabilityUnderstandingCycle, date: DateTime<Local>) -> bool {
    cycle.should_run_learning_cycle_at(date.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use chrono::{TimeZone, Timelike};

    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;
    fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("unambiguous local timestamp")
    }

    /// Stands in for the P5 cycle: records the call and answers from a script.
    #[derive(Default)]
    struct FakeCycle {
        updated: usize,
        executed: bool,
        calls: Mutex<Vec<DateTime<Local>>>,
    }

    impl CapabilityUnderstandingCycle for FakeCycle {
        fn should_run_learning_cycle_at(&self, date: DateTime<Utc>) -> bool {
            // The literal rule of `understandingLoop.ts:6-8`.
            date.hour() == 3 && date.minute() == 0
        }

        fn run_capability_understanding_cycle(
            &self,
            repo: &dyn MasterRepository,
            scope: &WorkspaceScope,
            now: DateTime<Local>,
        ) -> rusqlite::Result<CapabilityUnderstandingCycleOutcome> {
            // Touch the repository so the seam is used the way the real cycle
            // will use it.
            repo.list_capability_scores(scope)?;
            self.calls.lock().unwrap().push(now);
            Ok(CapabilityUnderstandingCycleOutcome {
                updated: self.updated,
                executed: self.executed,
            })
        }
    }

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    #[test]
    fn the_policy_recommendation_checks_the_failure_rate_first() {
        let policy = |failure_rate, verify_pass_rate| {
            recommend_learning_policy(&LearningPolicyInput {
                failure_rate,
                verify_pass_rate,
            })
        };
        assert_eq!(policy(0.21, 0.0), MasterFeedbackPolicy::Safe);
        assert_eq!(policy(0.2, 0.0), MasterFeedbackPolicy::Balanced);
        assert_eq!(policy(0.05, 0.91), MasterFeedbackPolicy::Fast);
        assert_eq!(policy(0.05, 0.9), MasterFeedbackPolicy::Balanced);
        // A high failure rate beats a high pass rate.
        assert_eq!(policy(0.9, 1.0), MasterFeedbackPolicy::Safe);
    }

    #[test]
    fn the_recommendation_uses_the_source_literals() {
        assert_eq!(MasterFeedbackPolicy::Safe.as_str(), "safe");
        assert_eq!(MasterFeedbackPolicy::Balanced.as_str(), "balanced");
        assert_eq!(MasterFeedbackPolicy::Fast.as_str(), "fast");
    }

    #[test]
    fn the_daily_loop_reports_the_local_date_and_three_am() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let cycle = FakeCycle {
            updated: 3,
            executed: true,
            ..FakeCycle::default()
        };
        let now = at(2026, 3, 4, 5, 6);

        let result = run_daily_learning_loop(&cycle, &repo, &scope(), now).unwrap();
        assert!(result.executed);
        assert_eq!(result.updated, 3);
        assert_eq!(result.scheduled_at, "2026-03-04 03:00");
        // The cycle receives the same instant.
        assert_eq!(cycle.calls.lock().unwrap().as_slice(), &[now]);
    }

    #[test]
    fn the_daily_loop_pads_single_digit_months_and_days() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let cycle = FakeCycle::default();
        let result =
            run_daily_learning_loop(&cycle, &repo, &scope(), at(2026, 1, 9, 23, 59)).unwrap();
        assert_eq!(result.scheduled_at, "2026-01-09 03:00");
    }

    #[test]
    fn the_daily_loop_propagates_the_cycle_verdict() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let cycle = FakeCycle::default();
        let result =
            run_daily_learning_loop(&cycle, &repo, &scope(), at(2026, 6, 1, 0, 0)).unwrap();
        assert!(!result.executed);
        assert_eq!(result.updated, 0);
    }

    #[test]
    fn the_window_is_read_in_utc() {
        let cycle = FakeCycle::default();
        // The default implementation answers in UTC, so convert the expectation
        // through `Utc` rather than hard-coding a wall-clock hour.
        let local = at(2026, 3, 4, 12, 34);
        let utc = local.with_timezone(&Utc);
        assert_eq!(
            is_learning_window(&cycle, local),
            utc.hour() == 3 && utc.minute() == 0
        );
    }
}
