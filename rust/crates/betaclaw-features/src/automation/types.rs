//! Port of `src/server/automation/types.ts`.
//!
//! Output structs serialise with camelCase keys, the shape the TypeScript objects have
//! in the UI. Input structs use `Option<Option<T>>` where TypeScript separates
//! `undefined` (leave the column alone) from `null` (store NULL).

use serde::Serialize;

use super::flow_types::FlowGraph;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomationTriggerSource {
    Cron,
    Manual,
}

impl AutomationTriggerSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cron => "cron",
            Self::Manual => "manual",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "cron" => Some(Self::Cron),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    DeadLetter,
    Skipped,
}

impl AutomationRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::DeadLetter => "dead_letter",
            Self::Skipped => "skipped",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "dead_letter" => Some(Self::DeadLetter),
            "skipped" => Some(Self::Skipped),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRule {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub cron_expression: String,
    pub timezone: String,
    pub prompt: String,
    pub enabled: bool,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub consecutive_failures: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub flow_graph: Option<FlowGraph>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub rule_id: String,
    pub user_id: String,
    pub trigger_source: AutomationTriggerSource,
    pub scheduled_for: String,
    pub run_key: String,
    pub status: AutomationRunStatus,
    pub attempt: i64,
    pub next_attempt_at: Option<String>,
    pub error_message: Option<String>,
    pub result_summary: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDeadLetter {
    pub id: String,
    pub run_id: String,
    pub rule_id: String,
    pub reason: String,
    pub payload: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerLeaseState {
    pub singleton_key: String,
    pub instance_id: String,
    pub heartbeat_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CreateAutomationRuleInput {
    pub user_id: String,
    pub name: String,
    pub cron_expression: String,
    pub timezone: String,
    pub prompt: String,
    pub enabled: bool,
    /// `None` lets the service compute it; `Some(None)` stores NULL.
    pub next_run_at: Option<Option<String>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UpdateAutomationRuleInput {
    pub name: Option<String>,
    pub cron_expression: Option<String>,
    pub timezone: Option<String>,
    pub prompt: Option<String>,
    pub enabled: Option<bool>,
    pub next_run_at: Option<Option<String>>,
    pub last_run_at: Option<Option<String>>,
    pub consecutive_failures: Option<i64>,
    pub last_error: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CreateAutomationRunInput {
    pub rule_id: String,
    pub user_id: String,
    pub trigger_source: AutomationTriggerSource,
    pub scheduled_for: String,
    pub run_key: String,
    pub attempt: i64,
    /// `None` (or blank) means "now" in the repository.
    pub next_attempt_at: Option<String>,
}
