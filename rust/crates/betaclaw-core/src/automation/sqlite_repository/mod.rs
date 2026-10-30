//! Port of `src/server/automation/sqliteAutomationRepository.ts` and its SQL modules
//! (`lease`, `migration`, `rules`, `runs`).
//!
//! The TypeScript `AutomationRepository` interface is not ported as a trait: this struct is
//! the only store, and tests use `:memory:`. The process-wide singleton is not ported.
//! `close()` is replaced by `Drop`, which closes the connection.

pub mod lease;
pub mod migration;
pub mod rules;
pub mod runs;

use std::sync::{Mutex, MutexGuard, PoisonError};

use rusqlite::Connection;

use crate::automation::error::AutomationError;
use crate::automation::flow_types::FlowGraph;
use crate::automation::types::{
    AutomationDeadLetter, AutomationRule, AutomationRun, AutomationRunStatus,
    CreateAutomationRuleInput, CreateAutomationRunInput, SchedulerLeaseState,
    UpdateAutomationRuleInput,
};
use crate::db::OpenOptions;

pub struct SqliteAutomationRepository {
    connection: Mutex<Connection>,
}

impl SqliteAutomationRepository {
    /// `new SqliteAutomationRepository(dbPath)`: the shared opener sets WAL, the 30 s busy
    /// timeout and foreign keys, then the schema is migrated.
    pub fn open(db_path: &str) -> Result<Self, AutomationError> {
        let connection = crate::db::open(OpenOptions::new(db_path))?;
        migration::migrate_automation_schema(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn in_memory() -> Result<Self, AutomationError> {
        Self::open(":memory:")
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub fn create_rule(
        &self,
        input: &CreateAutomationRuleInput,
    ) -> Result<AutomationRule, AutomationError> {
        let connection = self.lock();
        let id = rules::create_rule(&connection, input)?;
        rules::get_rule(&connection, &id, &input.user_id)?.ok_or(AutomationError::CreateFailed)
    }

    /// `updateRule`: `None` when the rule does not exist for this user.
    pub fn update_rule(
        &self,
        rule_id: &str,
        user_id: &str,
        patch: &UpdateAutomationRuleInput,
    ) -> Result<Option<AutomationRule>, AutomationError> {
        let connection = self.lock();
        if rules::get_rule(&connection, rule_id, user_id)?.is_none() {
            return Ok(None);
        }
        rules::update_rule(&connection, rule_id, user_id, patch)?;
        Ok(rules::get_rule(&connection, rule_id, user_id)?)
    }

    pub fn delete_rule(&self, rule_id: &str, user_id: &str) -> Result<bool, AutomationError> {
        let connection = self.lock();
        if rules::get_rule(&connection, rule_id, user_id)?.is_none() {
            return Ok(false);
        }
        rules::delete_rule(&connection, rule_id)?;
        Ok(true)
    }

    pub fn get_rule(
        &self,
        rule_id: &str,
        user_id: &str,
    ) -> Result<Option<AutomationRule>, AutomationError> {
        Ok(rules::get_rule(&self.lock(), rule_id, user_id)?)
    }

    pub fn get_rule_by_id(&self, rule_id: &str) -> Result<Option<AutomationRule>, AutomationError> {
        Ok(rules::get_rule_by_id(&self.lock(), rule_id)?)
    }

    pub fn list_rules(&self, user_id: &str) -> Result<Vec<AutomationRule>, AutomationError> {
        Ok(rules::list_rules(&self.lock(), user_id)?)
    }

    pub fn list_due_rules(
        &self,
        now_iso: &str,
        limit: i64,
    ) -> Result<Vec<AutomationRule>, AutomationError> {
        Ok(rules::list_due_rules(&self.lock(), now_iso, limit)?)
    }

    /// `saveFlowGraph`: `None` when the rule does not exist for this user.
    pub fn save_flow_graph(
        &self,
        rule_id: &str,
        user_id: &str,
        graph: &FlowGraph,
    ) -> Result<Option<AutomationRule>, AutomationError> {
        let connection = self.lock();
        if rules::get_rule(&connection, rule_id, user_id)?.is_none() {
            return Ok(None);
        }
        rules::save_flow_graph(&connection, rule_id, user_id, graph)?;
        Ok(rules::get_rule(&connection, rule_id, user_id)?)
    }

    pub fn create_or_get_run(
        &self,
        input: &CreateAutomationRunInput,
    ) -> Result<AutomationRun, AutomationError> {
        Ok(runs::create_or_get_run(&self.lock(), input)?)
    }

    pub fn get_run(&self, run_id: &str) -> Result<Option<AutomationRun>, AutomationError> {
        Ok(runs::get_run(&self.lock(), run_id)?)
    }

    pub fn list_runs(
        &self,
        rule_id: &str,
        user_id: &str,
        limit: i64,
    ) -> Result<Vec<AutomationRun>, AutomationError> {
        Ok(runs::list_runs(&self.lock(), rule_id, user_id, limit)?)
    }

    pub fn list_queued_runs_due(
        &self,
        now_iso: &str,
        limit: i64,
    ) -> Result<Vec<AutomationRun>, AutomationError> {
        Ok(runs::list_queued_runs_due(&self.lock(), now_iso, limit)?)
    }

    pub fn mark_run_running(
        &self,
        run_id: &str,
        started_at: &str,
    ) -> Result<Option<AutomationRun>, AutomationError> {
        let connection = self.lock();
        runs::mark_run_running(&connection, run_id, started_at)?;
        Ok(runs::get_run(&connection, run_id)?)
    }

    pub fn mark_run_succeeded(
        &self,
        run_id: &str,
        finished_at: &str,
        summary: Option<&str>,
    ) -> Result<Option<AutomationRun>, AutomationError> {
        let connection = self.lock();
        runs::mark_run_succeeded(&connection, run_id, finished_at, summary)?;
        Ok(runs::get_run(&connection, run_id)?)
    }

    pub fn mark_run_for_retry(
        &self,
        run_id: &str,
        attempt: i64,
        error_message: &str,
        next_attempt_at: &str,
    ) -> Result<Option<AutomationRun>, AutomationError> {
        let connection = self.lock();
        runs::mark_run_for_retry(&connection, run_id, attempt, error_message, next_attempt_at)?;
        Ok(runs::get_run(&connection, run_id)?)
    }

    pub fn mark_run_dead_letter(
        &self,
        run_id: &str,
        error_message: &str,
        finished_at: &str,
    ) -> Result<Option<AutomationRun>, AutomationError> {
        let connection = self.lock();
        runs::mark_run_dead_letter(&connection, run_id, error_message, finished_at)?;
        Ok(runs::get_run(&connection, run_id)?)
    }

    pub fn record_dead_letter(
        &self,
        run_id: &str,
        rule_id: &str,
        reason: &str,
        payload: Option<&str>,
    ) -> Result<AutomationDeadLetter, AutomationError> {
        Ok(runs::record_dead_letter(
            &self.lock(),
            run_id,
            rule_id,
            reason,
            payload,
        )?)
    }

    pub fn count_active_rules(&self) -> Result<i64, AutomationError> {
        Ok(runs::count_active_rules(&self.lock())?)
    }

    pub fn count_runs_by_status(
        &self,
        status: AutomationRunStatus,
    ) -> Result<i64, AutomationError> {
        Ok(runs::count_runs_by_status(&self.lock(), status)?)
    }

    pub fn acquire_lease(
        &self,
        instance_id: &str,
        ttl_ms: i64,
        now_iso: &str,
    ) -> Result<bool, AutomationError> {
        Ok(lease::acquire_lease(
            &self.lock(),
            instance_id,
            ttl_ms,
            now_iso,
        )?)
    }

    pub fn release_lease(&self, instance_id: &str) -> Result<(), AutomationError> {
        Ok(lease::release_lease(&self.lock(), instance_id)?)
    }

    pub fn get_lease_state(&self) -> Result<Option<SchedulerLeaseState>, AutomationError> {
        Ok(lease::get_lease_state(&self.lock())?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::types::AutomationTriggerSource;

    fn repo() -> SqliteAutomationRepository {
        SqliteAutomationRepository::in_memory().expect("in-memory repository")
    }

    fn rule_input(user_id: &str) -> CreateAutomationRuleInput {
        CreateAutomationRuleInput {
            user_id: user_id.to_string(),
            name: "Daily".to_string(),
            cron_expression: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
            prompt: "Brief me".to_string(),
            enabled: true,
            next_run_at: Some(Some("2026-10-12T09:00:00.000Z".to_string())),
        }
    }

    #[test]
    fn rules_are_scoped_to_their_user_and_found_when_due() {
        let repo = repo();
        let rule = repo.create_rule(&rule_input("u1")).unwrap();
        assert_eq!(repo.list_rules("u1").unwrap().len(), 1);
        assert!(repo.get_rule(&rule.id, "u2").unwrap().is_none());

        let renamed = repo
            .update_rule(
                &rule.id,
                "u1",
                &UpdateAutomationRuleInput {
                    name: Some("Renamed".to_string()),
                    ..Default::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(renamed.name, "Renamed");

        assert_eq!(
            repo.list_due_rules("2026-10-12T10:00:00.000Z", 10)
                .unwrap()
                .len(),
            1
        );
        assert!(repo.delete_rule(&rule.id, "u1").unwrap());
        assert!(repo.get_rule_by_id(&rule.id).unwrap().is_none());
    }

    #[test]
    fn a_scheduled_occurrence_creates_exactly_one_run() {
        let repo = repo();
        let rule = repo.create_rule(&rule_input("u1")).unwrap();
        let input = CreateAutomationRunInput {
            rule_id: rule.id.clone(),
            user_id: "u1".to_string(),
            trigger_source: AutomationTriggerSource::Cron,
            scheduled_for: "2026-10-12T09:00:00.000Z".to_string(),
            run_key: format!("{}:2026-10-12T09:00:00.000Z", rule.id),
            attempt: 0,
            next_attempt_at: None,
        };
        let first = repo.create_or_get_run(&input).unwrap();
        let second = repo.create_or_get_run(&input).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(repo.list_runs(&rule.id, "u1", 10).unwrap().len(), 1);
    }

    #[test]
    fn the_scheduler_lease_is_held_until_its_ttl_runs_out() {
        let repo = repo();
        assert!(repo
            .acquire_lease("a", 30_000, "2026-10-11T10:00:00.000Z")
            .unwrap());
        assert!(!repo
            .acquire_lease("b", 30_000, "2026-10-11T10:00:05.000Z")
            .unwrap());
        // The holder renews its own lease.
        assert!(repo
            .acquire_lease("a", 30_000, "2026-10-11T10:00:06.000Z")
            .unwrap());
        // 10:00:06 + 30 s has passed by 10:00:40, so another instance may take over.
        assert!(repo
            .acquire_lease("b", 30_000, "2026-10-11T10:00:40.000Z")
            .unwrap());
        assert_eq!(repo.get_lease_state().unwrap().unwrap().instance_id, "b");
        repo.release_lease("b").unwrap();
        assert!(repo.get_lease_state().unwrap().is_none());
    }
}
