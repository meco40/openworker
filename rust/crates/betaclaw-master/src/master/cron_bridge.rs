//! Port of `src/server/master/cronBridge.ts:1-132`.
//!
//! `MasterCronBridge` keeps one automation rule per cron reminder, named
//! `master-reminder:<workspace>:<reminder>`. The reminders scheduler seam
//! ([`ReminderSchedulerBridge`], `reminders.ts:5-10`) is implemented by
//! [`CronScheduler`], which syncs those rules on a reminder write.
//!
//! The automation service belongs to S10. The bridge reaches it through
//! [`AutomationRuntimePort`], which declares only the four calls that
//! `cronBridge.ts` makes (OP-S9-3). This crate provides no implementation.
//!
//! # Why the scheduler is a separate type
//!
//! `ReminderSchedulerBridge` requires `Send + Sync`. The scheduler holds only the
//! automation port, so it does not depend on the repository, and
//! [`MasterCronBridge`] holds the repository and a [`CronScheduler`].
//!
//! # Deviations
//!
//! * The scheduler seam returns nothing, so an automation failure during a
//!   reminder write is logged with `tracing::warn!`. The source throws, and the
//!   exception propagates to the caller. [`MasterCronBridge::list`] and
//!   [`MasterCronBridge::complete_reminder_run`] return their errors.

use std::collections::HashMap;

use crate::master::reminders::{
    FireReminderInput, FireReminderResult, MasterRemindersService, MasterRemindersServiceOptions,
    ReminderSchedulerBridge,
};
use crate::master::repository::MasterRepository;
use crate::master::types::{MasterReminder, WorkspaceScope};

/// The `listReminders(scope)` default of `repository.ts` (`limit = 100`).
const REMINDER_LIST_LIMIT: i64 = 100;

/// `CronJobDefinition` — `cronBridge.ts:6-13`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronJobDefinition {
    pub id: String,
    pub cron_expression: String,
    pub title: String,
    pub message: String,
    pub enabled: bool,
    pub automation_rule_id: Option<String>,
}

/// The fields of an S10 automation rule that the bridge reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationRuleRef {
    pub id: String,
    pub name: String,
    pub enabled: bool,
}

/// The `createRule` input — `cronBridge.ts:50-57`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateAutomationRule {
    pub user_id: String,
    pub name: String,
    pub cron_expression: String,
    pub timezone: String,
    pub prompt: String,
    pub enabled: bool,
}

/// The `updateRule` patch. `next_run_at: Some(None)` is `nextRunAt: null`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AutomationRulePatch {
    pub enabled: Option<bool>,
    pub next_run_at: Option<Option<String>>,
    pub cron_expression: Option<String>,
    pub prompt: Option<String>,
}

/// The S10 automation service, as the bridge calls it — `cronBridge.ts`
/// (`getAutomationService()` and its four calls).
pub trait AutomationRuntimePort: Send + Sync {
    fn list_rules(&self, user_id: &str) -> Result<Vec<AutomationRuleRef>, String>;
    fn create_rule(&self, input: &CreateAutomationRule) -> Result<(), String>;
    fn update_rule(
        &self,
        rule_id: &str,
        user_id: &str,
        patch: &AutomationRulePatch,
    ) -> Result<(), String>;
    fn delete_rule(&self, rule_id: &str, user_id: &str) -> Result<(), String>;
}

/// `completeReminderRun` input — `cronBridge.ts:111-114`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompleteReminderRunInput {
    pub automation_rule_id: String,
    pub fired_at: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum CronBridgeError {
    #[error("{0}")]
    Automation(String),
    #[error(transparent)]
    Repository(#[from] rusqlite::Error),
}

/// The rule-syncing half of `MasterCronBridge`, which is the reminders scheduler.
/// It holds only the automation port, so it is `Send + Sync`.
#[derive(Clone, Copy)]
pub struct CronScheduler<'a> {
    automation: &'a dyn AutomationRuntimePort,
}

impl CronScheduler<'_> {
    /// `syncReminder` — `cronBridge.ts:37-66`.
    fn sync(
        &self,
        scope: &WorkspaceScope,
        reminder: &MasterReminder,
    ) -> Result<(), CronBridgeError> {
        let existing = self.find_rule(scope, &reminder.id)?;
        let cron = reminder
            .cron_expression
            .as_deref()
            .filter(|cron| !cron.is_empty());
        let Some(cron) = cron else {
            if let Some(rule) = existing {
                self.update(
                    scope,
                    &rule.id,
                    &AutomationRulePatch {
                        enabled: Some(false),
                        next_run_at: Some(None),
                        ..Default::default()
                    },
                )?;
            }
            return Ok(());
        };

        let prompt = format!(
            "Master reminder ({}/{}): {}",
            scope.workspace_id, reminder.id, reminder.message
        );
        let enabled = is_active(&reminder.status);
        match existing {
            None => self
                .automation
                .create_rule(&CreateAutomationRule {
                    user_id: scope.user_id.clone(),
                    name: rule_name(scope, &reminder.id),
                    cron_expression: cron.to_string(),
                    timezone: "UTC".to_string(),
                    prompt,
                    enabled,
                })
                .map_err(CronBridgeError::Automation),
            Some(rule) => self.update(
                scope,
                &rule.id,
                &AutomationRulePatch {
                    cron_expression: Some(cron.to_string()),
                    prompt: Some(prompt),
                    enabled: Some(enabled),
                    ..Default::default()
                },
            ),
        }
    }

    /// `pauseReminder` and `resumeReminder` — `cronBridge.ts:68-81`. A missing
    /// rule is a no-op.
    fn set_enabled(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
        enabled: bool,
    ) -> Result<(), CronBridgeError> {
        let Some(rule) = self.find_rule(scope, reminder_id)? else {
            return Ok(());
        };
        let patch = if enabled {
            AutomationRulePatch {
                enabled: Some(true),
                ..Default::default()
            }
        } else {
            AutomationRulePatch {
                enabled: Some(false),
                next_run_at: Some(None),
                ..Default::default()
            }
        };
        self.update(scope, &rule.id, &patch)
    }

    /// `removeReminder` — `cronBridge.ts:83-88`.
    fn remove(&self, scope: &WorkspaceScope, reminder_id: &str) -> Result<(), CronBridgeError> {
        let Some(rule) = self.find_rule(scope, reminder_id)? else {
            return Ok(());
        };
        self.automation
            .delete_rule(&rule.id, &scope.user_id)
            .map_err(CronBridgeError::Automation)
    }

    fn rules(&self, scope: &WorkspaceScope) -> Result<Vec<AutomationRuleRef>, CronBridgeError> {
        self.automation
            .list_rules(&scope.user_id)
            .map_err(CronBridgeError::Automation)
    }

    /// `findRule` — `cronBridge.ts:30-35`.
    fn find_rule(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
    ) -> Result<Option<AutomationRuleRef>, CronBridgeError> {
        let name = rule_name(scope, reminder_id);
        Ok(self
            .rules(scope)?
            .into_iter()
            .find(|rule| rule.name == name))
    }

    fn update(
        &self,
        scope: &WorkspaceScope,
        rule_id: &str,
        patch: &AutomationRulePatch,
    ) -> Result<(), CronBridgeError> {
        self.automation
            .update_rule(rule_id, &scope.user_id, patch)
            .map_err(CronBridgeError::Automation)
    }
}

impl ReminderSchedulerBridge for CronScheduler<'_> {
    fn sync_reminder(&self, scope: &WorkspaceScope, reminder: &MasterReminder) {
        log_failure("syncReminder", self.sync(scope, reminder));
    }

    fn pause_reminder(&self, scope: &WorkspaceScope, reminder_id: &str) {
        log_failure("pauseReminder", self.set_enabled(scope, reminder_id, false));
    }

    fn resume_reminder(&self, scope: &WorkspaceScope, reminder_id: &str) {
        log_failure("resumeReminder", self.set_enabled(scope, reminder_id, true));
    }

    fn remove_reminder(&self, scope: &WorkspaceScope, reminder_id: &str) {
        log_failure("removeReminder", self.remove(scope, reminder_id));
    }
}

/// `MasterCronBridge` — `cronBridge.ts:27-132`.
pub struct MasterCronBridge<'a> {
    repo: &'a dyn MasterRepository,
    scheduler: CronScheduler<'a>,
}

impl<'a> MasterCronBridge<'a> {
    /// `constructor(private readonly repo)`. The automation service is injected
    /// instead of read from the S10 runtime singleton.
    pub fn new(repo: &'a dyn MasterRepository, automation: &'a dyn AutomationRuntimePort) -> Self {
        Self {
            repo,
            scheduler: CronScheduler { automation },
        }
    }

    /// The scheduler for `MasterRemindersService` (`{ scheduler: this }` in the
    /// source), so reminder writes sync the rules.
    pub fn scheduler(&self) -> &CronScheduler<'a> {
        &self.scheduler
    }

    /// `list(scope)` — `cronBridge.ts:89-109`.
    pub fn list(&self, scope: &WorkspaceScope) -> Result<Vec<CronJobDefinition>, CronBridgeError> {
        let rules: HashMap<String, AutomationRuleRef> = self
            .scheduler
            .rules(scope)?
            .into_iter()
            .map(|rule| (rule.name.clone(), rule))
            .collect();

        let reminders = self.repo.list_reminders(scope, REMINDER_LIST_LIMIT)?;
        Ok(reminders
            .into_iter()
            .filter(|entry| {
                entry
                    .cron_expression
                    .as_deref()
                    .is_some_and(|cron| !cron.is_empty())
            })
            .map(|entry| {
                let linked = rules.get(&rule_name(scope, &entry.id));
                CronJobDefinition {
                    cron_expression: entry.cron_expression.clone().unwrap_or_default(),
                    enabled: linked.map_or_else(|| is_active(&entry.status), |rule| rule.enabled),
                    automation_rule_id: linked.map(|rule| rule.id.clone()),
                    id: entry.id,
                    title: entry.title,
                    message: entry.message,
                }
            })
            .collect())
    }

    /// `completeReminderRun(scope, input)` — `cronBridge.ts:111-131`. `None` for
    /// an unknown rule or a rule name that does not belong to this workspace.
    pub fn complete_reminder_run(
        &self,
        scope: &WorkspaceScope,
        input: &CompleteReminderRunInput,
    ) -> Result<Option<FireReminderResult>, CronBridgeError> {
        let Some(rule) = self
            .scheduler
            .rules(scope)?
            .into_iter()
            .find(|entry| entry.id == input.automation_rule_id)
        else {
            return Ok(None);
        };
        let Some(reminder_id) = rule_reminder_id(scope, &rule.name) else {
            return Ok(None);
        };
        let service = MasterRemindersService::with_options(
            self.repo,
            MasterRemindersServiceOptions {
                scheduler: Some(&self.scheduler),
                ..Default::default()
            },
        );
        service
            .fire(
                scope,
                &reminder_id,
                &FireReminderInput {
                    fired_at: input.fired_at.clone(),
                    source: Some("cron".to_string()),
                    summary: input.summary.clone(),
                    automation_rule_id: Some(input.automation_rule_id.clone()),
                },
            )
            .map_err(CronBridgeError::Repository)
    }
}

fn log_failure(operation: &str, result: Result<(), CronBridgeError>) {
    if let Err(error) = result {
        tracing::warn!(%error, operation, "master cron bridge failed");
    }
}

/// `ruleName` — `cronBridge.ts:15-17`.
fn rule_name(scope: &WorkspaceScope, reminder_id: &str) -> String {
    format!("master-reminder:{}:{}", scope.workspace_id, reminder_id)
}

/// `ruleReminderId` — `cronBridge.ts:19-25`.
fn rule_reminder_id(scope: &WorkspaceScope, name: &str) -> Option<String> {
    let prefix = format!("master-reminder:{}:", scope.workspace_id);
    let reminder_id = name.strip_prefix(&prefix)?;
    if reminder_id.is_empty() {
        None
    } else {
        Some(reminder_id.to_string())
    }
}

/// `status !== 'paused' && status !== 'cancelled'` (`cronBridge.ts:56`, `:64`).
fn is_active(status: &str) -> bool {
    status != "paused" && status != "cancelled"
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::master::repository::reminders_store::MasterReminderInput;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    /// An in-memory automation service that records what the bridge asks for.
    #[derive(Default)]
    struct FakeAutomation {
        rules: Mutex<Vec<AutomationRuleRef>>,
        created: Mutex<Vec<CreateAutomationRule>>,
        patches: Mutex<Vec<AutomationRulePatch>>,
    }

    impl AutomationRuntimePort for FakeAutomation {
        fn list_rules(&self, _user_id: &str) -> Result<Vec<AutomationRuleRef>, String> {
            Ok(self.rules.lock().unwrap().clone())
        }

        fn create_rule(&self, input: &CreateAutomationRule) -> Result<(), String> {
            let mut rules = self.rules.lock().unwrap();
            let id = format!("rule-{}", rules.len() + 1);
            rules.push(AutomationRuleRef {
                id,
                name: input.name.clone(),
                enabled: input.enabled,
            });
            self.created.lock().unwrap().push(input.clone());
            Ok(())
        }

        fn update_rule(
            &self,
            rule_id: &str,
            _user_id: &str,
            patch: &AutomationRulePatch,
        ) -> Result<(), String> {
            if let Some(enabled) = patch.enabled {
                for rule in self.rules.lock().unwrap().iter_mut() {
                    if rule.id == rule_id {
                        rule.enabled = enabled;
                    }
                }
            }
            self.patches.lock().unwrap().push(patch.clone());
            Ok(())
        }

        fn delete_rule(&self, rule_id: &str, _user_id: &str) -> Result<(), String> {
            self.rules.lock().unwrap().retain(|rule| rule.id != rule_id);
            Ok(())
        }
    }

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn reminder(repo: &SqliteMasterRepository, cron: Option<&str>) -> MasterReminder {
        repo.create_reminder(
            &scope(),
            &MasterReminderInput {
                title: "Stand-up".to_string(),
                message: "Write notes".to_string(),
                remind_at: "2030-01-01T09:00:00.000Z".to_string(),
                cron_expression: cron.map(str::to_string),
                status: "pending".to_string(),
            },
        )
        .unwrap()
    }

    #[test]
    fn a_cron_reminder_gets_one_rule_that_is_updated_afterwards() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let automation = FakeAutomation::default();
        let bridge = MasterCronBridge::new(&repo, &automation);
        let reminder = reminder(&repo, Some("0 9 * * *"));

        bridge.scheduler().sync_reminder(&scope(), &reminder);
        bridge.scheduler().sync_reminder(&scope(), &reminder);

        let created = automation.created.lock().unwrap();
        assert_eq!(
            created.len(),
            1,
            "the second sync updates, it does not create"
        );
        assert_eq!(
            created[0].name,
            format!("master-reminder:w1:{}", reminder.id)
        );
        assert_eq!(created[0].timezone, "UTC");
        assert_eq!(
            created[0].prompt,
            format!("Master reminder (w1/{}): Write notes", reminder.id)
        );
        assert_eq!(automation.patches.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_reminder_that_loses_its_cron_disables_the_rule() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let automation = FakeAutomation::default();
        let bridge = MasterCronBridge::new(&repo, &automation);
        let mut reminder = reminder(&repo, Some("0 9 * * *"));
        bridge.scheduler().sync_reminder(&scope(), &reminder);

        reminder.cron_expression = None;
        bridge.scheduler().sync_reminder(&scope(), &reminder);

        assert!(!automation.rules.lock().unwrap()[0].enabled);
    }

    #[test]
    fn list_joins_the_rules_to_cron_reminders_only() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let automation = FakeAutomation::default();
        let bridge = MasterCronBridge::new(&repo, &automation);
        let cron = reminder(&repo, Some("0 9 * * *"));
        let _plain = reminder(&repo, None);
        bridge.scheduler().sync_reminder(&scope(), &cron);

        let jobs = bridge.list(&scope()).unwrap();

        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, cron.id);
        assert!(jobs[0].enabled);
        assert_eq!(jobs[0].automation_rule_id.as_deref(), Some("rule-1"));
    }

    #[test]
    fn completing_a_cron_run_fires_its_reminder() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let automation = FakeAutomation::default();
        let bridge = MasterCronBridge::new(&repo, &automation);
        let cron = reminder(&repo, Some("0 9 * * *"));
        bridge.scheduler().sync_reminder(&scope(), &cron);
        let rule_id = automation.rules.lock().unwrap()[0].id.clone();

        let fired = bridge
            .complete_reminder_run(
                &scope(),
                &CompleteReminderRunInput {
                    automation_rule_id: rule_id,
                    fired_at: None,
                    summary: Some("done".to_string()),
                },
            )
            .unwrap()
            .expect("the rule maps to a reminder");
        assert_eq!(fired.reminder.id, cron.id);
        assert!(!fired.duplicate);

        let unknown = bridge
            .complete_reminder_run(
                &scope(),
                &CompleteReminderRunInput {
                    automation_rule_id: "missing".to_string(),
                    fired_at: None,
                    summary: None,
                },
            )
            .unwrap();
        assert!(unknown.is_none());
    }
}
