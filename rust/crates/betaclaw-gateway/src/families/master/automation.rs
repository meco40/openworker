//! Port of the scheduler side of `src/server/master/cronBridge.ts` (`MasterCronBridge`)
//! over `getAutomationService()` (`src/server/automation/runtime.ts`).
//!
//! [`AutomationRuntimePort`] is the seam to the automation service. The core
//! [`AutomationService`] implements it, so the gateway hands the same service to
//! every family that needs the scheduler. The prompt runner stays unwired (S8,
//! OP-S10-2): rules are written here, but a due rule cannot run its prompt yet.
//!
//! [`CronBridge`] implements [`ReminderSchedulerBridge`]. The core trait returns
//! nothing, so a failed rule write is recorded and the reminder route answers
//! `400` with it, like the TypeScript `try/catch`. The TypeScript stops at the
//! failing call. Here the reminder service still writes its audit row and event,
//! because the core trait cannot abort it.

use std::sync::{Arc, Mutex};

use betaclaw_core::automation::error::AutomationError;
use betaclaw_core::automation::service::{
    AutomationService, PromptRunInput, PromptRunOutput, PromptRunner,
};
use betaclaw_core::automation::sqlite_repository::SqliteAutomationRepository;
use betaclaw_core::automation::types::{
    AutomationRule, CreateAutomationRuleInput, UpdateAutomationRuleInput,
};
use betaclaw_core::master::reminders::ReminderSchedulerBridge;
use betaclaw_core::master::types::{MasterReminder, WorkspaceScope};

/// The prompt runner of the master automation service. The chat dispatch behind it
/// is S8 (OP-S10-2), so a due rule fails with this message until it lands.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnwiredPromptRunner;

impl PromptRunner for UnwiredPromptRunner {
    async fn run_prompt(&self, _input: PromptRunInput) -> Result<PromptRunOutput, String> {
        Err("The automation prompt runner is not wired (S8).".to_string())
    }
}

/// The automation calls `cronBridge.ts` makes, with errors as text.
pub trait AutomationRuntimePort: Send + Sync {
    fn list_rules(&self, user_id: &str) -> Result<Vec<AutomationRule>, String>;
    fn create_rule(&self, input: &CreateAutomationRuleInput) -> Result<AutomationRule, String>;
    fn update_rule(
        &self,
        rule_id: &str,
        user_id: &str,
        patch: &UpdateAutomationRuleInput,
    ) -> Result<Option<AutomationRule>, String>;
    fn delete_rule(&self, rule_id: &str, user_id: &str) -> Result<bool, String>;
}

impl<R: PromptRunner> AutomationRuntimePort for AutomationService<R> {
    fn list_rules(&self, user_id: &str) -> Result<Vec<AutomationRule>, String> {
        AutomationService::list_rules(self, user_id).map_err(|error| error.to_string())
    }

    fn create_rule(&self, input: &CreateAutomationRuleInput) -> Result<AutomationRule, String> {
        AutomationService::create_rule(self, input).map_err(|error| error.to_string())
    }

    fn update_rule(
        &self,
        rule_id: &str,
        user_id: &str,
        patch: &UpdateAutomationRuleInput,
    ) -> Result<Option<AutomationRule>, String> {
        AutomationService::update_rule(self, rule_id, user_id, patch)
            .map_err(|error| error.to_string())
    }

    fn delete_rule(&self, rule_id: &str, user_id: &str) -> Result<bool, String> {
        AutomationService::delete_rule(self, rule_id, user_id).map_err(|error| error.to_string())
    }
}

/// Opens the automation service on `db_path` with the prompt runner unwired.
pub fn open_automation_port(
    db_path: &str,
) -> Result<Arc<dyn AutomationRuntimePort>, AutomationError> {
    open_automation_port_with_runner(db_path, UnwiredPromptRunner)
}

/// Opens the automation service on `db_path` with the given prompt runner.
pub fn open_automation_port_with_runner<R: PromptRunner + 'static>(
    db_path: &str,
    runner: R,
) -> Result<Arc<dyn AutomationRuntimePort>, AutomationError> {
    let repository = SqliteAutomationRepository::open(db_path)?;
    Ok(Arc::new(AutomationService::new(repository, runner)))
}

/// `master-reminder:${workspaceId}:${reminderId}` — `cronBridge.ts:15-17`.
fn rule_name(scope: &WorkspaceScope, reminder_id: &str) -> String {
    format!("master-reminder:{}:{reminder_id}", scope.workspace_id)
}

/// One request's scheduler bridge over the automation port.
pub struct CronBridge<'a> {
    port: &'a dyn AutomationRuntimePort,
    failure: Mutex<Option<String>>,
}

impl<'a> CronBridge<'a> {
    pub fn new(port: &'a dyn AutomationRuntimePort) -> Self {
        Self {
            port,
            failure: Mutex::new(None),
        }
    }

    /// The first failed rule write of this bridge, taken once.
    pub fn take_failure(&self) -> Option<String> {
        self.failure.lock().ok().and_then(|mut slot| slot.take())
    }

    fn record(&self, result: Result<(), String>) {
        if let Err(error) = result {
            if let Ok(mut slot) = self.failure.lock() {
                slot.get_or_insert(error);
            }
        }
    }

    /// `findRule` — `cronBridge.ts:30-35`.
    fn find_rule(
        &self,
        scope: &WorkspaceScope,
        reminder_id: &str,
    ) -> Result<Option<AutomationRule>, String> {
        let name = rule_name(scope, reminder_id);
        Ok(self
            .port
            .list_rules(&scope.user_id)?
            .into_iter()
            .find(|rule| rule.name == name))
    }

    /// `syncReminder` — `cronBridge.ts:37-66`.
    fn sync(&self, scope: &WorkspaceScope, reminder: &MasterReminder) -> Result<(), String> {
        let existing = self.find_rule(scope, &reminder.id)?;
        let enabled = reminder.status != "paused" && reminder.status != "cancelled";
        let cron = match reminder
            .cron_expression
            .as_deref()
            .filter(|text| !text.is_empty())
        {
            Some(cron) => cron,
            None => {
                if let Some(rule) = existing {
                    self.port.update_rule(
                        &rule.id,
                        &scope.user_id,
                        &UpdateAutomationRuleInput {
                            enabled: Some(false),
                            next_run_at: Some(None),
                            ..UpdateAutomationRuleInput::default()
                        },
                    )?;
                }
                return Ok(());
            }
        };

        let prompt = format!(
            "Master reminder ({}/{}): {}",
            scope.workspace_id, reminder.id, reminder.message
        );
        match existing {
            None => {
                self.port.create_rule(&CreateAutomationRuleInput {
                    user_id: scope.user_id.clone(),
                    name: rule_name(scope, &reminder.id),
                    cron_expression: cron.to_string(),
                    timezone: "UTC".to_string(),
                    prompt,
                    enabled,
                    next_run_at: None,
                })?;
            }
            Some(rule) => {
                self.port.update_rule(
                    &rule.id,
                    &scope.user_id,
                    &UpdateAutomationRuleInput {
                        cron_expression: Some(cron.to_string()),
                        prompt: Some(prompt),
                        enabled: Some(enabled),
                        ..UpdateAutomationRuleInput::default()
                    },
                )?;
            }
        }
        Ok(())
    }

    /// `pauseReminder`: switches the linked rule off and clears its next run.
    fn disable(&self, scope: &WorkspaceScope, reminder_id: &str) -> Result<(), String> {
        let Some(rule) = self.find_rule(scope, reminder_id)? else {
            return Ok(());
        };
        self.port
            .update_rule(
                &rule.id,
                &scope.user_id,
                &UpdateAutomationRuleInput {
                    enabled: Some(false),
                    next_run_at: Some(None),
                    ..UpdateAutomationRuleInput::default()
                },
            )
            .map(|_| ())
    }
}

impl ReminderSchedulerBridge for CronBridge<'_> {
    fn sync_reminder(&self, scope: &WorkspaceScope, reminder: &MasterReminder) {
        self.record(self.sync(scope, reminder));
    }

    fn pause_reminder(&self, scope: &WorkspaceScope, reminder_id: &str) {
        self.record(self.disable(scope, reminder_id));
    }

    fn resume_reminder(&self, scope: &WorkspaceScope, reminder_id: &str) {
        let result = self
            .find_rule(scope, reminder_id)
            .and_then(|rule| match rule {
                Some(rule) => self
                    .port
                    .update_rule(
                        &rule.id,
                        &scope.user_id,
                        &UpdateAutomationRuleInput {
                            enabled: Some(true),
                            ..UpdateAutomationRuleInput::default()
                        },
                    )
                    .map(|_| ()),
                None => Ok(()),
            });
        self.record(result);
    }

    fn remove_reminder(&self, scope: &WorkspaceScope, reminder_id: &str) {
        let result = self
            .find_rule(scope, reminder_id)
            .and_then(|rule| match rule {
                Some(rule) => self.port.delete_rule(&rule.id, &scope.user_id).map(|_| ()),
                None => Ok(()),
            });
        self.record(result);
    }
}
