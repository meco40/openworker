//! Port of `src/server/master/execution/runtime/types.ts:1-71`.
//!
//! The record shapes and string unions of the runtime. Each union keeps its
//! TypeScript spelling, like [`crate::master::types`]: the four closed sets are
//! `Capability`, `RuntimeMode`, `MasterRuntimeTool` and `riskProfile`, while
//! `ToolRunResult` is a tagged union modelled as a Rust enum so a reader can see
//! the three statuses directly.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::master::types::MasterRun;

/// `Capability` from `types.ts:4`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    WebSearch,
    CodeGeneration,
    Notes,
    Reminders,
    SystemOps,
}

impl Capability {
    /// The TypeScript literal.
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::WebSearch => "web_search",
            Capability::CodeGeneration => "code_generation",
            Capability::Notes => "notes",
            Capability::Reminders => "reminders",
            Capability::SystemOps => "system_ops",
        }
    }

    /// Parses the TypeScript literal, or `None` for an unknown value.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "web_search" => Some(Capability::WebSearch),
            "code_generation" => Some(Capability::CodeGeneration),
            "notes" => Some(Capability::Notes),
            "reminders" => Some(Capability::Reminders),
            "system_ops" => Some(Capability::SystemOps),
            _ => None,
        }
    }
}

/// `RuntimeMode` from `types.ts:5`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeMode {
    Model,
    Fallback,
}

impl RuntimeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeMode::Model => "model",
            RuntimeMode::Fallback => "fallback",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "model" => Some(RuntimeMode::Model),
            "fallback" => Some(RuntimeMode::Fallback),
            _ => None,
        }
    }
}

/// `MasterRuntimeTool` from `types.ts:6-12`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MasterRuntimeTool {
    Notes,
    Reminders,
    ShellExecute,
    WebSearch,
    Write,
    Read,
}

impl MasterRuntimeTool {
    pub fn as_str(self) -> &'static str {
        match self {
            MasterRuntimeTool::Notes => "notes",
            MasterRuntimeTool::Reminders => "reminders",
            MasterRuntimeTool::ShellExecute => "shell_execute",
            MasterRuntimeTool::WebSearch => "web_search",
            MasterRuntimeTool::Write => "write",
            MasterRuntimeTool::Read => "read",
        }
    }
}

/// `ExecutionPlan['riskProfile']` from `types.ts:18`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskProfile {
    Low,
    Medium,
    High,
}

impl RiskProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            RiskProfile::Low => "low",
            RiskProfile::Medium => "medium",
            RiskProfile::High => "high",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "low" => Some(RiskProfile::Low),
            "medium" => Some(RiskProfile::Medium),
            "high" => Some(RiskProfile::High),
            _ => None,
        }
    }
}

/// `ExecutionPlan` from `types.ts:14-21`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPlan {
    pub capabilities: Vec<Capability>,
    pub rationale: String,
    pub verification_checks: Vec<String>,
    pub risk_profile: RiskProfile,
    pub requires_approval: bool,
    pub source: RuntimeMode,
}

/// `CapabilityControl` from `types.ts:23-29`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityControl {
    pub requires_approval: bool,
    pub action_type: String,
    pub fingerprint: String,
    pub file_path: Option<String>,
    pub command: Option<String>,
}

/// `CapabilityTaskResult` from `types.ts:31-36`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityTaskResult {
    pub output: String,
    pub confidence: f64,
    pub mode: RuntimeMode,
    pub degraded_mode: bool,
}

/// `ToolRunRequest` from `types.ts:38-52`.
///
/// `noteTags?: string[]` is optional; the port keeps the source's `Option`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRunRequest {
    pub tool_name: MasterRuntimeTool,
    pub action_type: String,
    pub fingerprint: String,
    pub requires_approval: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remind_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron_expression: Option<String>,
}

/// `ToolRunResult` from `types.ts:54-57`.
///
/// The three statuses are modelled as an enum; `details?: unknown` is carried as
/// a [`Value`].
#[derive(Debug, Clone, PartialEq)]
pub enum ToolRunResult {
    Completed {
        output: String,
        details: Option<Value>,
    },
    ApprovalRequired {
        summary: String,
    },
    Blocked {
        reason: String,
    },
}

/// `{ jobs, events }` of `MasterRunExportBundle` — `types.ts:64-67`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterRunExportDelegations {
    pub jobs: Vec<Value>,
    pub events: Vec<Value>,
}

/// `MasterRunExportBundle` from `types.ts:59-71`.
///
/// `verificationReport` stays a [`Value`] because the source only casts the
/// parsed bundle (`masterExecutionRuntime.ts:85`); it never rebuilds the report,
/// so the port does not either. `executionMode` is validated against
/// [`RuntimeMode`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterRunExportBundle {
    pub run_id: String,
    pub status: String,
    pub run: MasterRun,
    pub steps: Vec<Value>,
    pub delegations: MasterRunExportDelegations,
    pub verification_report: Option<Value>,
    pub execution_mode: Option<RuntimeMode>,
    pub exported_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_literals_round_trip() {
        let literals = [
            "web_search",
            "code_generation",
            "notes",
            "reminders",
            "system_ops",
        ];
        for literal in literals {
            let capability = Capability::parse(literal).expect("known");
            assert_eq!(capability.as_str(), literal);
            assert_eq!(
                serde_json::to_value(capability).unwrap(),
                serde_json::json!(literal)
            );
        }
        assert_eq!(Capability::parse("nope"), None);
    }

    #[test]
    fn runtime_mode_and_risk_profile_round_trip() {
        assert_eq!(
            serde_json::to_value(RuntimeMode::Model).unwrap(),
            serde_json::json!("model")
        );
        assert_eq!(RuntimeMode::parse("fallback"), Some(RuntimeMode::Fallback));
        assert_eq!(RiskProfile::High.as_str(), "high");
        assert_eq!(RiskProfile::parse("medium"), Some(RiskProfile::Medium));
    }
}
