//! Port of `src/server/automation/service.ts`.
//!
//! Owns the rule and run lifecycle: enqueue due cron rules, run queued runs, retry with
//! backoff, dead-letter, and auto-pause. The prompt runner is injected ([`PromptRunner`]);
//! its chat dispatch is S8 (OP-S10-2). The scheduler loop (`runtime.ts`) and the workers it
//! starts (OP-S10-1) are not ported.

use std::future::Future;

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::cron_engine::{
    compute_next_run_at, parse_instant, to_iso_millis, validate_cron_expression, validate_timezone,
};
use super::error::AutomationError;
use super::executor::{execute_agent_run_action, AgentRunExecutionInput};
use super::flow_compiler::CompiledFlow;
use super::flow_types::{FlowGraph, FlowNodeType};
use super::sqlite_repository::SqliteAutomationRepository;
use super::types::{
    AutomationRule, AutomationRun, AutomationRunStatus, AutomationTriggerSource,
    CreateAutomationRuleInput, CreateAutomationRunInput, UpdateAutomationRuleInput,
};
use crate::stats::util::now_iso;

/// Timeout of one automation run (`executeAgentRunAction` call in `service.ts`).
pub const RUN_TIMEOUT_MS: u64 = 60_000;
/// Backoff used when the retry list is empty or holds a zero (`|| 1_000` in `service.ts`).
const FALLBACK_BACKOFF_MS: u64 = 1_000;
/// Rules and queued runs handled per tick.
const BATCH_SIZE: i64 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptRunInput {
    pub user_id: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PromptRunOutput {
    pub summary: Option<String>,
}

/// Runs one automation prompt. The chat dispatch behind it is S8 (OP-S10-2).
pub trait PromptRunner: Send + Sync {
    fn run_prompt(
        &self,
        input: PromptRunInput,
    ) -> impl Future<Output = Result<PromptRunOutput, String>> + Send;
}

#[derive(Debug, Clone)]
pub struct ProcessTickOptions {
    /// Tick time; `None` means the current time.
    pub now_iso: Option<String>,
    pub max_attempts: i64,
    pub retry_backoff_ms: Vec<u64>,
    pub auto_pause_failure_threshold: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationMetrics {
    pub active_rules: i64,
    pub queued_runs: i64,
    pub running_runs: i64,
    pub dead_letter_runs: i64,
    pub lease_age_seconds: Option<i64>,
}

pub struct AutomationService<R: PromptRunner> {
    repo: SqliteAutomationRepository,
    runner: R,
}

impl<R: PromptRunner> AutomationService<R> {
    pub fn new(repo: SqliteAutomationRepository, runner: R) -> Self {
        Self { repo, runner }
    }

    pub fn create_rule(
        &self,
        input: &CreateAutomationRuleInput,
    ) -> Result<AutomationRule, AutomationError> {
        if !validate_timezone(&input.timezone) {
            return Err(AutomationError::InvalidTimezone(input.timezone.clone()));
        }
        if !validate_cron_expression(&input.cron_expression, &input.timezone) {
            return Err(AutomationError::InvalidCronExpression);
        }
        let next_run_at = match &input.next_run_at {
            Some(explicit) => explicit.clone(),
            None if input.enabled => {
                computable_next_run(&input.cron_expression, &input.timezone, Utc::now())
            }
            None => None,
        };
        let stored = CreateAutomationRuleInput {
            next_run_at: Some(next_run_at),
            ..input.clone()
        };
        self.repo.create_rule(&stored)
    }

    pub fn update_rule(
        &self,
        rule_id: &str,
        user_id: &str,
        patch: &UpdateAutomationRuleInput,
    ) -> Result<Option<AutomationRule>, AutomationError> {
        let Some(existing) = self.repo.get_rule(rule_id, user_id)? else {
            return Ok(None);
        };

        let timezone = patch
            .timezone
            .clone()
            .unwrap_or_else(|| existing.timezone.clone());
        let cron_expression = patch
            .cron_expression
            .clone()
            .unwrap_or_else(|| existing.cron_expression.clone());

        if patch.timezone.is_some() && !validate_timezone(&timezone) {
            return Err(AutomationError::InvalidTimezone(timezone));
        }
        let schedule_changed = patch.cron_expression.is_some() || patch.timezone.is_some();
        if schedule_changed && !validate_cron_expression(&cron_expression, &timezone) {
            return Err(AutomationError::InvalidCronExpression);
        }

        let now = Utc::now();
        let mut next_run_at = patch.next_run_at.clone();
        if next_run_at.is_none() && schedule_changed {
            next_run_at = Some(if existing.enabled {
                computable_next_run(&cron_expression, &timezone, now)
            } else {
                None
            });
        }
        if let Some(enabled) = patch.enabled {
            next_run_at = Some(if enabled {
                // `nextRunAt ?? compute(...)`: an explicit value or a computed one.
                match next_run_at.clone().flatten() {
                    Some(value) => Some(value),
                    None => computable_next_run(&cron_expression, &timezone, now),
                }
            } else {
                None
            });
        }

        let last_error = if patch.enabled == Some(true) {
            Some(None)
        } else {
            patch.last_error.clone()
        };
        let stored = UpdateAutomationRuleInput {
            next_run_at,
            last_error,
            ..patch.clone()
        };
        self.repo.update_rule(rule_id, user_id, &stored)
    }

    pub fn delete_rule(&self, rule_id: &str, user_id: &str) -> Result<bool, AutomationError> {
        self.repo.delete_rule(rule_id, user_id)
    }

    pub fn get_rule(
        &self,
        rule_id: &str,
        user_id: &str,
    ) -> Result<Option<AutomationRule>, AutomationError> {
        self.repo.get_rule(rule_id, user_id)
    }

    pub fn list_rules(&self, user_id: &str) -> Result<Vec<AutomationRule>, AutomationError> {
        self.repo.list_rules(user_id)
    }

    /// `createManualRun`: a run queued for immediate execution.
    pub fn create_manual_run(
        &self,
        rule_id: &str,
        user_id: &str,
    ) -> Result<AutomationRun, AutomationError> {
        let rule = self
            .repo
            .get_rule(rule_id, user_id)?
            .ok_or(AutomationError::RuleNotFound)?;
        let scheduled_for = now_iso();
        self.repo.create_or_get_run(&CreateAutomationRunInput {
            rule_id: rule.id.clone(),
            user_id: rule.user_id.clone(),
            trigger_source: AutomationTriggerSource::Manual,
            run_key: format!("{}:{}:manual", rule.id, scheduled_for),
            attempt: 0,
            next_attempt_at: Some(scheduled_for.clone()),
            scheduled_for,
        })
    }

    pub fn list_runs(
        &self,
        rule_id: &str,
        user_id: &str,
        limit: i64,
    ) -> Result<Vec<AutomationRun>, AutomationError> {
        self.repo.list_runs(rule_id, user_id, limit)
    }

    pub fn get_flow_graph(
        &self,
        rule_id: &str,
        user_id: &str,
    ) -> Result<Option<FlowGraph>, AutomationError> {
        Ok(self
            .repo
            .get_rule(rule_id, user_id)?
            .and_then(|rule| rule.flow_graph))
    }

    /// `saveFlowGraph`: stores the graph, then the prompt and enabled flag from the compiled
    /// output. The schedule is only overwritten when the graph has a cron trigger.
    pub fn save_flow_graph(
        &self,
        rule_id: &str,
        user_id: &str,
        graph: &FlowGraph,
        compiled: &CompiledFlow,
    ) -> Result<Option<AutomationRule>, AutomationError> {
        if self
            .repo
            .save_flow_graph(rule_id, user_id, graph)?
            .is_none()
        {
            return Ok(None);
        }
        let has_cron_trigger = graph
            .nodes
            .iter()
            .any(|node| node.node_type == FlowNodeType::TriggerCron);
        let mut patch = UpdateAutomationRuleInput {
            prompt: Some(compiled.prompt.clone()),
            enabled: Some(compiled.enabled),
            ..Default::default()
        };
        if has_cron_trigger {
            patch.cron_expression = Some(compiled.cron_expression.clone());
            patch.timezone = Some(compiled.timezone.clone());
        }
        self.repo.update_rule(rule_id, user_id, &patch)
    }

    pub fn get_lease_state(
        &self,
    ) -> Result<Option<super::types::SchedulerLeaseState>, AutomationError> {
        self.repo.get_lease_state()
    }

    pub fn get_metrics(&self) -> Result<AutomationMetrics, AutomationError> {
        let lease_age_seconds = self.repo.get_lease_state()?.and_then(|lease| {
            let updated = DateTime::parse_from_rfc3339(&lease.updated_at).ok()?;
            let age_ms = Utc::now().timestamp_millis() - updated.timestamp_millis();
            Some(age_ms.div_euclid(1000))
        });
        Ok(AutomationMetrics {
            active_rules: self.repo.count_active_rules()?,
            queued_runs: self
                .repo
                .count_runs_by_status(AutomationRunStatus::Queued)?,
            running_runs: self
                .repo
                .count_runs_by_status(AutomationRunStatus::Running)?,
            dead_letter_runs: self
                .repo
                .count_runs_by_status(AutomationRunStatus::DeadLetter)?,
            lease_age_seconds,
        })
    }

    pub fn acquire_lease(
        &self,
        instance_id: &str,
        ttl_ms: i64,
        now_iso: &str,
    ) -> Result<bool, AutomationError> {
        self.repo.acquire_lease(instance_id, ttl_ms, now_iso)
    }

    pub fn release_lease(&self, instance_id: &str) -> Result<(), AutomationError> {
        self.repo.release_lease(instance_id)
    }

    /// `processTick`: enqueue due rules, then execute queued runs.
    pub async fn process_tick(&self, options: &ProcessTickOptions) -> Result<(), AutomationError> {
        let now = options.now_iso.clone().unwrap_or_else(now_iso);
        self.enqueue_due_rules(&now)?;
        self.execute_queued_runs(&now, options).await
    }

    fn enqueue_due_rules(&self, now: &str) -> Result<(), AutomationError> {
        for rule in self.repo.list_due_rules(now, BATCH_SIZE)? {
            let Some(scheduled_for) = rule.next_run_at.clone() else {
                continue;
            };
            self.repo.create_or_get_run(&CreateAutomationRunInput {
                rule_id: rule.id.clone(),
                user_id: rule.user_id.clone(),
                trigger_source: AutomationTriggerSource::Cron,
                run_key: format!("{}:{}", rule.id, scheduled_for),
                attempt: 0,
                next_attempt_at: Some(now.to_string()),
                scheduled_for,
            })?;

            // Misfire policy: at most one catch-up on restart, then schedule from "now". A rule
            // whose next run cannot be computed gets none, so it cannot stop the tick for the
            // other rules.
            let next =
                compute_next_run_at(&rule.cron_expression, &rule.timezone, parse_instant(now)?)
                    .ok();
            self.repo.update_rule(
                &rule.id,
                &rule.user_id,
                &UpdateAutomationRuleInput {
                    next_run_at: Some(next),
                    ..Default::default()
                },
            )?;
        }
        Ok(())
    }

    async fn execute_queued_runs(
        &self,
        now: &str,
        options: &ProcessTickOptions,
    ) -> Result<(), AutomationError> {
        for run in self.repo.list_queued_runs_due(now, BATCH_SIZE)? {
            let Some(rule) = self.repo.get_rule_by_id(&run.rule_id)? else {
                let finished_at = now_iso();
                self.repo
                    .mark_run_dead_letter(&run.id, "Rule no longer exists.", &finished_at)?;
                self.repo.record_dead_letter(
                    &run.id,
                    &run.rule_id,
                    "Rule no longer exists.",
                    None,
                )?;
                continue;
            };

            self.repo.mark_run_running(&run.id, &now_iso())?;

            // Mirrors the TypeScript try block: a storage error after a successful prompt is
            // handled like a failed run.
            let Err(error) = self.run_and_record_success(&rule, &run).await else {
                continue;
            };
            let message = error.to_string();
            let attempt = run.attempt + 1;

            if attempt >= options.max_attempts {
                let finished_at = now_iso();
                self.repo
                    .mark_run_dead_letter(&run.id, &message, &finished_at)?;
                self.repo
                    .record_dead_letter(&run.id, &run.rule_id, &message, None)?;

                let failures = rule.consecutive_failures + 1;
                let should_pause = failures >= options.auto_pause_failure_threshold;
                self.repo.update_rule(
                    &rule.id,
                    &rule.user_id,
                    &UpdateAutomationRuleInput {
                        consecutive_failures: Some(failures),
                        last_error: Some(Some(message)),
                        enabled: Some(if should_pause { false } else { rule.enabled }),
                        next_run_at: Some(if should_pause {
                            None
                        } else {
                            rule.next_run_at.clone()
                        }),
                        ..Default::default()
                    },
                )?;
                continue;
            }

            let next_attempt_at = backoff_instant(backoff_ms(&options.retry_backoff_ms, attempt));
            self.repo
                .mark_run_for_retry(&run.id, attempt, &message, &next_attempt_at)?;
        }
        Ok(())
    }

    async fn run_and_record_success(
        &self,
        rule: &AutomationRule,
        run: &AutomationRun,
    ) -> Result<(), AutomationError> {
        let result = execute_agent_run_action(
            AgentRunExecutionInput {
                user_id: rule.user_id.clone(),
                prompt: rule.prompt.clone(),
                timeout_ms: Some(RUN_TIMEOUT_MS),
            },
            &self.runner,
        )
        .await?;

        self.repo
            .mark_run_succeeded(&run.id, &now_iso(), Some(&result.summary))?;
        self.repo.update_rule(
            &rule.id,
            &rule.user_id,
            &UpdateAutomationRuleInput {
                consecutive_failures: Some(0),
                last_error: Some(None),
                last_run_at: Some(Some(run.scheduled_for.clone())),
                ..Default::default()
            },
        )?;
        Ok(())
    }
}

/// `retryBackoffMs[min(attempt - 1, len - 1)] || 1_000`.
fn backoff_ms(backoffs: &[u64], attempt: i64) -> u64 {
    if backoffs.is_empty() {
        return FALLBACK_BACKOFF_MS;
    }
    let index = (attempt - 1).clamp(0, backoffs.len() as i64 - 1) as usize;
    match backoffs[index] {
        0 => FALLBACK_BACKOFF_MS,
        value => value,
    }
}

/// `new Date(Date.now() + backoffMs).toISOString()`.
fn backoff_instant(backoff_ms: u64) -> String {
    let at = Utc::now().timestamp_millis() + backoff_ms as i64;
    DateTime::<Utc>::from_timestamp_millis(at).map_or_else(now_iso, to_iso_millis)
}

/// Next run of an enabled rule, or `None` when its schedule has none. Such a rule is stored
/// without a next run and the tick skips it, so it cannot stop the other rules.
fn computable_next_run(expression: &str, timezone: &str, from: DateTime<Utc>) -> Option<String> {
    compute_next_run_at(expression, timezone, from).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Returns the same outcome on every run.
    struct FakeRunner {
        outcome: Result<PromptRunOutput, String>,
    }

    impl PromptRunner for FakeRunner {
        async fn run_prompt(&self, _input: PromptRunInput) -> Result<PromptRunOutput, String> {
            self.outcome.clone()
        }
    }

    fn service(outcome: Result<PromptRunOutput, String>) -> AutomationService<FakeRunner> {
        AutomationService::new(
            SqliteAutomationRepository::in_memory().expect("in-memory repository"),
            FakeRunner { outcome },
        )
    }

    /// A rule that is due at 10:00 and runs every five minutes.
    fn due_rule(service: &AutomationService<FakeRunner>) -> AutomationRule {
        service
            .create_rule(&CreateAutomationRuleInput {
                user_id: "u1".to_string(),
                name: "Every five".to_string(),
                cron_expression: "*/5 * * * *".to_string(),
                timezone: "UTC".to_string(),
                prompt: "Check".to_string(),
                enabled: true,
                next_run_at: Some(Some("2026-10-11T10:00:00.000Z".to_string())),
            })
            .expect("rule is valid")
    }

    fn tick(now: &str) -> ProcessTickOptions {
        ProcessTickOptions {
            now_iso: Some(now.to_string()),
            max_attempts: 2,
            retry_backoff_ms: vec![30_000],
            auto_pause_failure_threshold: 1,
        }
    }

    #[tokio::test]
    async fn a_rule_without_a_next_run_does_not_stop_the_tick() {
        let service = service(Ok(PromptRunOutput { summary: None }));
        // Stored with a due time, so the tick computes its next run after firing and finds none.
        let stuck = service
            .repo
            .create_rule(&CreateAutomationRuleInput {
                user_id: "u1".to_string(),
                name: "Never".to_string(),
                cron_expression: "0 0 31 2,4,6,9,11 *".to_string(),
                timezone: "UTC".to_string(),
                prompt: "Check".to_string(),
                enabled: true,
                next_run_at: Some(Some("2026-10-11T10:00:00.000Z".to_string())),
            })
            .unwrap();
        let rule = due_rule(&service);

        service
            .process_tick(&tick("2026-10-11T10:00:05.000Z"))
            .await
            .unwrap();

        let rule = service.get_rule(&rule.id, "u1").unwrap().unwrap();
        assert_eq!(
            rule.next_run_at.as_deref(),
            Some("2026-10-11T10:05:00.000Z")
        );
        let stuck = service.get_rule(&stuck.id, "u1").unwrap().unwrap();
        assert_eq!(stuck.next_run_at, None);
    }

    #[tokio::test]
    async fn a_rule_created_without_a_computable_next_run_is_stored_and_skipped_by_the_tick() {
        let service = service(Ok(PromptRunOutput { summary: None }));
        // No 31st in these months, so no next run exists. The rule is still created.
        let stuck = service
            .create_rule(&CreateAutomationRuleInput {
                user_id: "u1".to_string(),
                name: "Never".to_string(),
                cron_expression: "0 0 31 2,4,6,9,11 *".to_string(),
                timezone: "UTC".to_string(),
                prompt: "Check".to_string(),
                enabled: true,
                next_run_at: None,
            })
            .expect("rule without a next run is stored");
        assert_eq!(stuck.next_run_at, None);
        let rule = due_rule(&service);

        service
            .process_tick(&tick("2026-10-11T10:00:05.000Z"))
            .await
            .unwrap();

        let rule = service.get_rule(&rule.id, "u1").unwrap().unwrap();
        assert_eq!(
            rule.next_run_at.as_deref(),
            Some("2026-10-11T10:05:00.000Z")
        );
        let stuck = service.get_rule(&stuck.id, "u1").unwrap().unwrap();
        assert_eq!(stuck.next_run_at, None);
        assert!(service.list_runs(&stuck.id, "u1", 10).unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_update_without_a_computable_next_run_is_stored_and_the_tick_continues() {
        let service = service(Ok(PromptRunOutput { summary: None }));
        let never = "0 0 31 2,4,6,9,11 *";
        let rule = due_rule(&service);

        // Enabled and due; its schedule is then changed to one without a next run.
        let changed = service
            .repo
            .create_rule(&CreateAutomationRuleInput {
                user_id: "u1".to_string(),
                name: "Changed".to_string(),
                cron_expression: "*/5 * * * *".to_string(),
                timezone: "UTC".to_string(),
                prompt: "Check".to_string(),
                enabled: true,
                next_run_at: Some(Some("2026-10-11T10:00:00.000Z".to_string())),
            })
            .unwrap();
        let changed = service
            .update_rule(
                &changed.id,
                "u1",
                &UpdateAutomationRuleInput {
                    cron_expression: Some(never.to_string()),
                    ..Default::default()
                },
            )
            .expect("update is stored")
            .expect("rule exists");
        assert_eq!(changed.next_run_at, None);

        // Disabled with the same schedule; activating it by update has no next run either.
        let activated = service
            .repo
            .create_rule(&CreateAutomationRuleInput {
                user_id: "u1".to_string(),
                name: "Activated".to_string(),
                cron_expression: never.to_string(),
                timezone: "UTC".to_string(),
                prompt: "Check".to_string(),
                enabled: false,
                next_run_at: Some(None),
            })
            .unwrap();
        let activated = service
            .update_rule(
                &activated.id,
                "u1",
                &UpdateAutomationRuleInput {
                    enabled: Some(true),
                    ..Default::default()
                },
            )
            .expect("update is stored")
            .expect("rule exists");
        assert!(activated.enabled);
        assert_eq!(activated.next_run_at, None);

        service
            .process_tick(&tick("2026-10-11T10:00:05.000Z"))
            .await
            .unwrap();

        let rule = service.get_rule(&rule.id, "u1").unwrap().unwrap();
        assert_eq!(
            rule.next_run_at.as_deref(),
            Some("2026-10-11T10:05:00.000Z")
        );
        assert!(service.list_runs(&changed.id, "u1", 10).unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_successful_run_is_recorded_and_the_next_run_is_scheduled() {
        let service = service(Ok(PromptRunOutput {
            summary: Some("done".to_string()),
        }));
        let rule = due_rule(&service);

        service
            .process_tick(&tick("2026-10-11T10:00:05.000Z"))
            .await
            .unwrap();

        let rule = service.get_rule(&rule.id, "u1").unwrap().unwrap();
        assert_eq!(
            rule.last_run_at.as_deref(),
            Some("2026-10-11T10:00:00.000Z")
        );
        assert_eq!(
            rule.next_run_at.as_deref(),
            Some("2026-10-11T10:05:00.000Z")
        );
        assert_eq!(rule.consecutive_failures, 0);

        let runs = service.list_runs(&rule.id, "u1", 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, AutomationRunStatus::Succeeded);
        assert_eq!(runs[0].result_summary.as_deref(), Some("done"));
    }

    #[tokio::test]
    async fn a_failing_run_is_retried_then_dead_lettered_and_the_rule_is_paused() {
        let service = service(Err("provider down".to_string()));
        let rule = due_rule(&service);

        service
            .process_tick(&tick("2026-10-11T10:00:05.000Z"))
            .await
            .unwrap();
        let first = service.list_runs(&rule.id, "u1", 10).unwrap().remove(0);
        assert_eq!(first.status, AutomationRunStatus::Queued);
        assert_eq!(first.attempt, 1);
        assert_eq!(first.error_message.as_deref(), Some("provider down"));

        // The retry is due after its backoff; a tick far in the future picks it up.
        service
            .process_tick(&tick("2099-01-01T00:00:00.000Z"))
            .await
            .unwrap();
        let dead = service.repo.get_run(&first.id).unwrap().unwrap();
        assert_eq!(dead.status, AutomationRunStatus::DeadLetter);

        let rule = service.get_rule(&rule.id, "u1").unwrap().unwrap();
        assert!(!rule.enabled);
        assert_eq!(rule.consecutive_failures, 1);
        assert_eq!(rule.last_error.as_deref(), Some("provider down"));
    }

    #[test]
    fn backoff_uses_the_last_entry_and_falls_back_on_zero_or_empty_lists() {
        assert_eq!(backoff_ms(&[30_000, 120_000], 1), 30_000);
        assert_eq!(backoff_ms(&[30_000, 120_000], 5), 120_000);
        assert_eq!(backoff_ms(&[0], 1), FALLBACK_BACKOFF_MS);
        assert_eq!(backoff_ms(&[], 1), FALLBACK_BACKOFF_MS);
    }
}
