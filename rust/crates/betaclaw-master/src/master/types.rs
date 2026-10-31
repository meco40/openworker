//! Port of `src/server/master/types.ts:1-147` plus the shapes it re-exports
//! from `src/shared/masterTypes.ts:1-140`.
//!
//! | TypeScript                              | Rust |
//! | --------------------------------------- | ---- |
//! | `shared/masterTypes.ts` (`MasterRun`, `MasterStep`, …) | this module |
//! | `master/types.ts:16-147` (the interfaces and unions declared here) | this module |
//!
//! # Union-typed columns stay `String`
//!
//! The record types mirror a `SELECT *` row and the row mappers cast the union
//! fields with a bare `as` (`mappers.ts:29,71,99,…`), through which any stored
//! text survives. Following the S1 precedent (`messages_store/types.rs:12-22`),
//! the record structs keep the raw `String` for those fields so an unknown
//! spelling is neither rewritten nor rejected; the closed sets are still
//! published as enums because callers need a catalogue and the writers that
//! follow will validate against them. Every enum exposes [`as_str`](MasterRunStatus::as_str)
//! and `parse`, and serialises to exactly the TypeScript spelling.

use serde::{Deserialize, Serialize};

/// Generates a closed string-union enum with the TypeScript spellings.
///
/// `as_str`/`parse` cover the `as const` catalogue uses; the serde rename keeps
/// the JSON spelling identical to the TypeScript literal, so a serialised
/// [`MasterRun`] round-trips byte-for-byte against the source.
macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }

        impl $name {
            /// The TypeScript literal this variant stands for.
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            /// Parses the TypeScript literal, or `None` for an unknown value.
            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

// ─── Shared interfaces ───────────────────────────────────────────────────────
/// `MasterRun` from `src/shared/masterTypes.ts:16-36`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterRun {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub title: String,
    pub contract: String,
    pub status: String,
    pub progress: i64,
    pub verification_passed: bool,
    pub result_bundle: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_error: Option<String>,
    pub paused_for_approval: bool,
    pub pending_approval_action_type: Option<String>,
    pub cancelled_at: Option<String>,
    pub cancel_reason: Option<String>,
    pub owner_id: Option<String>,
    pub lease_expires_at: Option<String>,
    pub heartbeat_at: Option<String>,
}

/// `MasterStep` from `src/shared/masterTypes.ts:38-50`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterStep {
    pub id: String,
    pub run_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub seq: i64,
    pub phase: String,
    pub status: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterFeedback` from `src/shared/masterTypes.ts:52-61`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterFeedback {
    pub id: String,
    pub run_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub rating: i64,
    pub policy: String,
    pub comment: Option<String>,
    pub created_at: String,
}

/// `MasterNote` from `src/shared/masterTypes.ts:63-72`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterNote {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterReminder` from `src/shared/masterTypes.ts:74-85`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterReminder {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub title: String,
    pub message: String,
    pub remind_at: String,
    pub cron_expression: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterApprovalRequest` from `src/shared/masterTypes.ts:87-109`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterApprovalRequest {
    pub id: String,
    pub run_id: String,
    pub step_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub tool_name: String,
    pub action_type: String,
    pub summary: String,
    pub prompt: String,
    pub host: Option<String>,
    pub cwd: Option<String>,
    pub resolved_path: Option<String>,
    pub fingerprint: String,
    pub risk_level: String,
    pub status: String,
    pub expires_at: String,
    pub decision: Option<String>,
    pub decision_reason: Option<String>,
    pub decided_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterToolPolicy` from `src/shared/masterTypes.ts:111-121`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterToolPolicy {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub security: String,
    pub ask: String,
    pub allowlist: Vec<String>,
    pub updated_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterSubagentSession` from `src/shared/masterTypes.ts:123-140`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterSubagentSession {
    pub id: String,
    pub run_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub status: String,
    pub title: String,
    pub prompt: String,
    pub assigned_tools: Vec<String>,
    pub owner_id: Option<String>,
    pub lease_expires_at: Option<String>,
    pub heartbeat_at: Option<String>,
    pub latest_event_at: Option<String>,
    pub result_summary: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterActionLedgerEntry` from `src/server/master/types.ts:16-28`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterActionLedgerEntry {
    pub id: String,
    pub run_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub step_id: String,
    pub action_type: String,
    pub idempotency_key: String,
    pub state: String,
    pub result_payload: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterApprovalRule` from `src/server/master/types.ts:30-39`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterApprovalRule {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub action_type: String,
    pub fingerprint: String,
    pub decision: String,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterCapabilityScore` from `src/server/master/types.ts:41-50`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterCapabilityScore {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub capability: String,
    pub confidence: f64,
    pub last_verified_at: Option<String>,
    pub benchmark_summary: String,
    pub updated_at: String,
}

/// `MasterCapabilityProposal` from `src/server/master/types.ts:52-63`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterCapabilityProposal {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub title: String,
    pub capability_key: String,
    pub status: String,
    pub proposal: String,
    pub fallback_plan: String,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterToolForgeArtifact` from `src/server/master/types.ts:65-78`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterToolForgeArtifact {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub name: String,
    pub spec: String,
    pub manifest: String,
    pub test_summary: String,
    pub risk_report: String,
    pub status: String,
    pub published_globally: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterConnectorSecret` from `src/server/master/types.ts:80-92`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterConnectorSecret {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub provider: String,
    pub key_ref: String,
    pub encrypted_payload: String,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `MasterAuditEvent` from `src/server/master/types.ts:94-102`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterAuditEvent {
    pub id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub category: String,
    pub action: String,
    pub metadata: String,
    pub created_at: String,
}

/// `MasterRunCreateInput` from `src/server/master/types.ts:104-109`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterRunCreateInput {
    pub user_id: String,
    pub workspace_id: String,
    pub title: String,
    pub contract: String,
}

/// `WorkspaceScope` from `src/server/master/types.ts:111-114`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceScope {
    pub user_id: String,
    pub workspace_id: String,
}

/// `TriggerPolicyDecision` from `src/server/master/types.ts:116-119`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerPolicyDecision {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<TriggerPolicyReason>,
}

/// `MasterDelegationJob` from `src/server/master/types.ts:121-136`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterDelegationJob {
    pub id: String,
    pub run_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub capability: String,
    pub payload: String,
    pub status: String,
    pub priority: String,
    pub attempts: i64,
    pub max_attempts: i64,
    pub timeout_ms: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_error: Option<String>,
}

/// `MasterDelegationEvent` from `src/server/master/types.ts:138-147`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterDelegationEvent {
    pub id: String,
    pub job_id: String,
    pub run_id: String,
    pub user_id: String,
    pub workspace_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: String,
    pub created_at: String,
}

// ─── Catalogue unions ────────────────────────────────────────────────────────
string_enum!(
    /// `MasterRunStatus` from `src/shared/masterTypes.ts:1-12`.
    MasterRunStatus {
        Idle => "IDLE",
        Analyzing => "ANALYZING",
        Planning => "PLANNING",
        Delegating => "DELEGATING",
        Executing => "EXECUTING",
        Verifying => "VERIFYING",
        Refining => "REFINING",
        AwaitingApproval => "AWAITING_APPROVAL",
        Completed => "COMPLETED",
        Cancelled => "CANCELLED",
        Failed => "FAILED",
    }
);

string_enum!(
    /// `ApprovalDecision` from `src/shared/masterTypes.ts:14`.
    ApprovalDecision {
        ApproveOnce => "approve_once",
        ApproveAlways => "approve_always",
        Deny => "deny",
    }
);

string_enum!(
    /// `MasterStep['status']` from `src/shared/masterTypes.ts:45`.
    MasterStepStatus {
        Pending => "pending",
        Running => "running",
        Done => "done",
        Error => "error",
        Blocked => "blocked",
    }
);

string_enum!(
    /// `MasterFeedback['policy']` from `src/shared/masterTypes.ts:58`.
    MasterFeedbackPolicy {
        Safe => "safe",
        Balanced => "balanced",
        Fast => "fast",
    }
);

string_enum!(
    /// `MasterReminder['status']` from `src/shared/masterTypes.ts:82`.
    MasterReminderStatus {
        Pending => "pending",
        Fired => "fired",
        Paused => "paused",
        Cancelled => "cancelled",
    }
);

string_enum!(
    /// `MasterApprovalRequest['host']` from `src/shared/masterTypes.ts:97`.
    MasterApprovalHost {
        Sandbox => "sandbox",
        Gateway => "gateway",
    }
);

string_enum!(
    /// `MasterApprovalRequest['riskLevel']` from `src/shared/masterTypes.ts:101`.
    MasterRiskLevel {
        Low => "low",
        Medium => "medium",
        High => "high",
    }
);

string_enum!(
    /// `MasterApprovalRequest['status']` from `src/shared/masterTypes.ts:102`.
    MasterApprovalStatus {
        Pending => "pending",
        Approved => "approved",
        Denied => "denied",
        Expired => "expired",
    }
);

string_enum!(
    /// `MasterToolPolicy['security']` from `src/shared/masterTypes.ts:115`.
    MasterToolPolicySecurity {
        Deny => "deny",
        Allowlist => "allowlist",
        Full => "full",
    }
);

string_enum!(
    /// `MasterToolPolicy['ask']` from `src/shared/masterTypes.ts:116`.
    MasterToolPolicyAsk {
        Off => "off",
        OnMiss => "on_miss",
        Always => "always",
    }
);

string_enum!(
    /// `MasterSubagentSession['status']` from `src/shared/masterTypes.ts:128`.
    MasterSubagentSessionStatus {
        Queued => "queued",
        Running => "running",
        Completed => "completed",
        Failed => "failed",
        Cancelled => "cancelled",
    }
);

string_enum!(
    /// `MasterActionLedgerEntry['state']` from `src/server/master/types.ts:24`.
    MasterActionLedgerState {
        Planned => "planned",
        Started => "started",
        Committed => "committed",
        RolledBack => "rolled_back",
        Failed => "failed",
    }
);

string_enum!(
    /// `MasterCapabilityProposal['status']` from `src/server/master/types.ts:58`.
    MasterCapabilityProposalStatus {
        Draft => "draft",
        AwaitingApproval => "awaiting_approval",
        Approved => "approved",
        Denied => "denied",
    }
);

string_enum!(
    /// `MasterToolForgeArtifact['status']` from `src/server/master/types.ts:74`.
    MasterToolForgeArtifactStatus {
        Draft => "draft",
        AwaitingApproval => "awaiting_approval",
        Approved => "approved",
        Denied => "denied",
        Published => "published",
    }
);

string_enum!(
    /// `MasterDelegationJob['status']` from `src/server/master/types.ts:128`.
    MasterDelegationJobStatus {
        Queued => "queued",
        Running => "running",
        Completed => "completed",
        Failed => "failed",
        Cancelled => "cancelled",
    }
);

string_enum!(
    /// `MasterDelegationJob['priority']` from `src/server/master/types.ts:129`.
    MasterDelegationJobPriority {
        Low => "low",
        Medium => "medium",
        High => "high",
    }
);

string_enum!(
    /// `MasterDelegationEvent['type']` from `src/server/master/types.ts:144`.
    MasterDelegationEventType {
        Created => "created",
        Started => "started",
        Progress => "progress",
        Result => "result",
        Error => "error",
        PolicyDenied => "policy_denied",
        Cancelled => "cancelled",
    }
);

string_enum!(
    /// `TriggerPolicyDecision['reason']` from `src/server/master/types.ts:118`.
    TriggerPolicyReason {
        CooldownActive => "cooldown_active",
        CapacityExhausted => "capacity_exhausted",
        BudgetExceeded => "budget_exceeded",
        Blocked => "blocked",
    }
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_run_shape_serialises_camel_case() {
        let run = MasterRun {
            id: "r1".to_string(),
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            title: "t".to_string(),
            contract: "c".to_string(),
            status: "ANALYZING".to_string(),
            progress: 0,
            verification_passed: false,
            result_bundle: None,
            created_at: "t0".to_string(),
            updated_at: "t0".to_string(),
            last_error: None,
            paused_for_approval: false,
            pending_approval_action_type: None,
            cancelled_at: None,
            cancel_reason: None,
            owner_id: None,
            lease_expires_at: None,
            heartbeat_at: None,
        };
        let json = serde_json::to_value(&run).unwrap();
        assert_eq!(json["userId"], "u1");
        assert_eq!(json["workspaceId"], "w1");
        assert_eq!(json["verificationPassed"], false);
        assert!(json["resultBundle"].is_null());
    }

    #[test]
    fn enums_keep_the_typescript_spellings() {
        assert_eq!(
            MasterRunStatus::AwaitingApproval.as_str(),
            "AWAITING_APPROVAL"
        );
        assert_eq!(
            MasterRunStatus::parse("AWAITING_APPROVAL"),
            Some(MasterRunStatus::AwaitingApproval)
        );
        assert_eq!(MasterRunStatus::parse("nope"), None);
        assert_eq!(ApprovalDecision::ApproveAlways.as_str(), "approve_always");
        assert_eq!(MasterActionLedgerState::RolledBack.as_str(), "rolled_back");
        assert_eq!(
            MasterDelegationEventType::PolicyDenied.as_str(),
            "policy_denied"
        );
        assert_eq!(
            MasterDelegationJobPriority::parse("high"),
            Some(MasterDelegationJobPriority::High)
        );
    }

    #[test]
    fn enum_serialises_to_the_literal() {
        let json = serde_json::to_value(MasterRunStatus::Failed).unwrap();
        assert_eq!(json, serde_json::json!("FAILED"));
        let parsed: MasterRunStatus = serde_json::from_value(serde_json::json!("IDLE")).unwrap();
        assert_eq!(parsed, MasterRunStatus::Idle);
    }

    #[test]
    fn trigger_policy_decision_carries_optional_reason() {
        let decision = TriggerPolicyDecision {
            allowed: false,
            reason: Some(TriggerPolicyReason::CooldownActive),
        };
        let json = serde_json::to_value(&decision).unwrap();
        assert_eq!(json["allowed"], false);
        assert_eq!(json["reason"], "cooldown_active");
    }
}
