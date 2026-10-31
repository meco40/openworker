//! Port of `src/server/master/execution/approvalPolicy.ts:1-103`.
//!
//! The runtime approval gate: build the trusted `actionType`/`fingerprint`, ask
//! the tool policy, then the standing approval rules, then a one-time approval,
//! then the control-plane flag, and answer `allowed` / `awaiting_approval` /
//! `denied`.
//!
//! # `resolveToolPolicy` (P5) is a seam
//!
//! `approvalPolicy.ts:5,42` imports `resolveToolPolicy` from
//! `@/server/master/toolPolicy/service`, which is package P5 and has not landed.
//! The port takes a [`ToolPolicyResolver`] instead of importing or stubbing that
//! module. [`AllowAllToolPolicyResolver`] reproduces the "no policy row"
//! behaviour (`resolveToolPolicy` returns `allow` when no policy exists), so it is
//! a faithful default (OP-S9-13).
//!
//! # The event bus is the injected publisher
//!
//! `consumeApprovedApprovalRequest` publishes a `master.updated` invalidation
//! (`approvals/service.ts:184`), so the gate takes a
//! [`MasterEventPublisher`] and forwards it.

use crate::master::approvals::service::{
    consume_approved_approval_request, ApprovalServiceError, ConsumeApprovedApprovalRequestInput,
};
use crate::master::feature_flags::{is_master_approval_control_plane_enabled, MasterEnv};
use crate::master::live_events::MasterEventPublisher;
use crate::master::repository::MasterRepository;
use crate::master::types::WorkspaceScope;

/// `ApprovalGateDecision` from `approvalPolicy.ts:7`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalGateDecision {
    Allowed,
    AwaitingApproval,
    Denied,
}

impl ApprovalGateDecision {
    /// The TypeScript literal.
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalGateDecision::Allowed => "allowed",
            ApprovalGateDecision::AwaitingApproval => "awaiting_approval",
            ApprovalGateDecision::Denied => "denied",
        }
    }
}

/// `RuntimeApprovalResolution` from `approvalPolicy.ts:9-14`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeApprovalResolution {
    pub decision: ApprovalGateDecision,
    pub action_type: String,
    pub fingerprint: String,
    pub reason: Option<String>,
}

/// `ToolPolicyResolution['decision']` — `toolPolicy/service.ts:110`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPolicyDecision {
    Allow,
    Ask,
    Deny,
}

impl ToolPolicyDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolPolicyDecision::Allow => "allow",
            ToolPolicyDecision::Ask => "ask",
            ToolPolicyDecision::Deny => "deny",
        }
    }
}

/// The argument bag of `resolveToolPolicy` — `toolPolicy/service.ts:120-128`.
pub struct ToolPolicyResolutionInput<'a> {
    pub repo: &'a dyn MasterRepository,
    pub scope: &'a WorkspaceScope,
    pub action_type: &'a str,
    pub tool_name: Option<&'a str>,
    pub host: Option<&'a str>,
    pub target_context: Option<&'a str>,
    pub fingerprint: Option<&'a str>,
}

/// `ToolPolicyResolution` from `toolPolicy/service.ts:106-111`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPolicyResolution {
    pub decision: ToolPolicyDecision,
    pub reason: Option<String>,
}

/// The P5 seam for `resolveToolPolicy`.
pub trait ToolPolicyResolver: Send + Sync {
    fn resolve_tool_policy(&self, input: &ToolPolicyResolutionInput<'_>) -> ToolPolicyResolution;
}

/// The default: `allow`, exactly like `resolveToolPolicy` with no stored policy.
#[derive(Debug, Clone, Copy, Default)]
pub struct AllowAllToolPolicyResolver;

impl ToolPolicyResolver for AllowAllToolPolicyResolver {
    fn resolve_tool_policy(&self, _input: &ToolPolicyResolutionInput<'_>) -> ToolPolicyResolution {
        ToolPolicyResolution {
            decision: ToolPolicyDecision::Allow,
            reason: None,
        }
    }
}

/// The `throw` of `registerOneTimeApproval` — `approvalPolicy.ts:21-23`.
#[derive(Debug, thiserror::Error)]
pub enum ApprovalPolicyError {
    #[error(
        "registerOneTimeApproval is no longer supported; persist an approval request instead."
    )]
    RegisterUnsupported,
    #[error(transparent)]
    Approval(#[from] ApprovalServiceError),
    #[error(transparent)]
    Repository(#[from] rusqlite::Error),
}

/// `registerOneTimeApproval` — `approvalPolicy.ts:16-24`.
pub fn register_one_time_approval(
    _scope: &WorkspaceScope,
    _action_type: &str,
    _fingerprint: &str,
) -> Result<(), ApprovalPolicyError> {
    Err(ApprovalPolicyError::RegisterUnsupported)
}

/// `clearOneTimeApprovalsForTests` — `approvalPolicy.ts:26-28` (a no-op).
pub fn clear_one_time_approvals_for_tests() {}

/// `input` of `resolveRuntimeApproval` — `approvalPolicy.ts:30-38`.
pub struct ResolveRuntimeApprovalInput<'a> {
    pub repo: &'a dyn MasterRepository,
    pub scope: &'a WorkspaceScope,
    pub action_type: &'a str,
    pub fingerprint: Option<&'a str>,
    pub requires_approval: bool,
    pub tool_name: Option<&'a str>,
    pub host: Option<&'a str>,
    pub target_context: Option<&'a str>,
}

/// `resolveRuntimeApproval` — `approvalPolicy.ts:30-103`.
pub fn resolve_runtime_approval(
    input: &ResolveRuntimeApprovalInput<'_>,
    env: &MasterEnv,
    tool_policy: &dyn ToolPolicyResolver,
    publisher: &dyn MasterEventPublisher,
) -> Result<RuntimeApprovalResolution, ApprovalPolicyError> {
    let action_type = input.action_type.trim().to_string();
    let fingerprint_source = input.fingerprint.unwrap_or("");
    let source = if fingerprint_source.is_empty() {
        action_type.as_str()
    } else {
        fingerprint_source
    };
    let trimmed = source.trim();
    let fingerprint = if trimmed.is_empty() {
        action_type.clone()
    } else {
        trimmed.to_string()
    };

    let resolution = tool_policy.resolve_tool_policy(&ToolPolicyResolutionInput {
        repo: input.repo,
        scope: input.scope,
        action_type: &action_type,
        tool_name: input.tool_name,
        host: input.host,
        target_context: input.target_context,
        fingerprint: Some(&fingerprint),
    });
    if resolution.decision == ToolPolicyDecision::Deny {
        return Ok(RuntimeApprovalResolution {
            decision: ApprovalGateDecision::Denied,
            action_type: action_type.clone(),
            fingerprint,
            reason: Some(
                resolution
                    .reason
                    .unwrap_or_else(|| format!("Action denied by tool policy: {action_type}")),
            ),
        });
    }

    let requires_approval =
        input.requires_approval || resolution.decision == ToolPolicyDecision::Ask;
    if !requires_approval {
        return Ok(RuntimeApprovalResolution {
            decision: ApprovalGateDecision::Allowed,
            action_type,
            fingerprint,
            reason: None,
        });
    }

    let rule = input
        .repo
        .get_approval_rule(input.scope, &action_type, &fingerprint)?;
    if rule.as_deref() == Some("deny") {
        return Ok(RuntimeApprovalResolution {
            decision: ApprovalGateDecision::Denied,
            action_type: action_type.clone(),
            fingerprint,
            reason: Some(format!("Action denied by policy: {action_type}")),
        });
    }
    if rule.as_deref() == Some("approve_always") {
        return Ok(RuntimeApprovalResolution {
            decision: ApprovalGateDecision::Allowed,
            action_type,
            fingerprint,
            reason: None,
        });
    }

    let consumed = consume_approved_approval_request(
        &ConsumeApprovedApprovalRequestInput {
            repo: input.repo,
            scope: input.scope,
            action_type: &action_type,
            fingerprint: &fingerprint,
        },
        publisher,
    )?;
    if consumed.is_some() {
        return Ok(RuntimeApprovalResolution {
            decision: ApprovalGateDecision::Allowed,
            action_type,
            fingerprint,
            reason: None,
        });
    }

    if !is_master_approval_control_plane_enabled(env) {
        return Ok(RuntimeApprovalResolution {
            decision: ApprovalGateDecision::Denied,
            action_type: action_type.clone(),
            fingerprint,
            reason: Some(format!(
                "Approval control plane is disabled for {action_type}."
            )),
        });
    }

    Ok(RuntimeApprovalResolution {
        decision: ApprovalGateDecision::AwaitingApproval,
        action_type: action_type.clone(),
        fingerprint: fingerprint.clone(),
        reason: Some(
            resolution
                .reason
                .unwrap_or_else(|| format!("Approval required for {action_type} ({fingerprint}).")),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::live_events::NoopMasterEventPublisher;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    struct StubResolver {
        decision: ToolPolicyDecision,
        reason: Option<String>,
    }

    impl ToolPolicyResolver for StubResolver {
        fn resolve_tool_policy(
            &self,
            _input: &ToolPolicyResolutionInput<'_>,
        ) -> ToolPolicyResolution {
            ToolPolicyResolution {
                decision: self.decision,
                reason: self.reason.clone(),
            }
        }
    }

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    #[test]
    fn an_allowed_action_needs_no_approval() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let resolution = resolve_runtime_approval(
            &ResolveRuntimeApprovalInput {
                repo: &repo,
                scope: &scope,
                action_type: " file.write ",
                fingerprint: None,
                requires_approval: false,
                tool_name: Some("write"),
                host: None,
                target_context: None,
            },
            &MasterEnv::new(),
            &AllowAllToolPolicyResolver,
            &NoopMasterEventPublisher,
        )
        .unwrap();
        assert_eq!(resolution.decision, ApprovalGateDecision::Allowed);
        assert_eq!(resolution.action_type, "file.write");
        assert_eq!(resolution.fingerprint, "file.write");
        assert!(resolution.reason.is_none());
    }

    #[test]
    fn a_denying_tool_policy_wins_immediately() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let resolver = StubResolver {
            decision: ToolPolicyDecision::Deny,
            reason: None,
        };
        let resolution = resolve_runtime_approval(
            &ResolveRuntimeApprovalInput {
                repo: &repo,
                scope: &scope,
                action_type: "shell.exec",
                fingerprint: Some("shell.exec"),
                requires_approval: false,
                tool_name: None,
                host: None,
                target_context: None,
            },
            &MasterEnv::new(),
            &resolver,
            &NoopMasterEventPublisher,
        )
        .unwrap();
        assert_eq!(resolution.decision, ApprovalGateDecision::Denied);
        assert_eq!(
            resolution.reason.as_deref(),
            Some("Action denied by tool policy: shell.exec")
        );
    }

    #[test]
    fn a_standing_approve_always_rule_allows() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        repo.upsert_approval_rule(&scope, "file.write", "file.write", "approve_always")
            .unwrap();
        let resolution = resolve_runtime_approval(
            &ResolveRuntimeApprovalInput {
                repo: &repo,
                scope: &scope,
                action_type: "file.write",
                fingerprint: None,
                requires_approval: true,
                tool_name: None,
                host: None,
                target_context: None,
            },
            &MasterEnv::new(),
            &AllowAllToolPolicyResolver,
            &NoopMasterEventPublisher,
        )
        .unwrap();
        assert_eq!(resolution.decision, ApprovalGateDecision::Allowed);
    }

    #[test]
    fn without_a_rule_the_gate_awaits_approval() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let resolver = StubResolver {
            decision: ToolPolicyDecision::Ask,
            reason: Some("Tool policy approval required for file.write.".to_string()),
        };
        let resolution = resolve_runtime_approval(
            &ResolveRuntimeApprovalInput {
                repo: &repo,
                scope: &scope,
                action_type: "file.write",
                fingerprint: None,
                requires_approval: false,
                tool_name: None,
                host: None,
                target_context: None,
            },
            &MasterEnv::new(),
            &resolver,
            &NoopMasterEventPublisher,
        )
        .unwrap();
        assert_eq!(resolution.decision, ApprovalGateDecision::AwaitingApproval);
        assert_eq!(
            resolution.reason.as_deref(),
            Some("Tool policy approval required for file.write.")
        );
    }

    #[test]
    fn a_disabled_control_plane_denies() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let mut env = MasterEnv::new();
        env.insert(
            "MASTER_APPROVAL_CONTROL_PLANE_ENABLED".to_string(),
            "false".to_string(),
        );
        let resolution = resolve_runtime_approval(
            &ResolveRuntimeApprovalInput {
                repo: &repo,
                scope: &scope,
                action_type: "file.write",
                fingerprint: None,
                requires_approval: true,
                tool_name: None,
                host: None,
                target_context: None,
            },
            &env,
            &AllowAllToolPolicyResolver,
            &NoopMasterEventPublisher,
        )
        .unwrap();
        assert_eq!(resolution.decision, ApprovalGateDecision::Denied);
        assert_eq!(
            resolution.reason.as_deref(),
            Some("Approval control plane is disabled for file.write.")
        );
    }

    #[test]
    fn literals_and_the_removed_helper() {
        assert_eq!(
            ApprovalGateDecision::AwaitingApproval.as_str(),
            "awaiting_approval"
        );
        assert_eq!(ToolPolicyDecision::Ask.as_str(), "ask");
        let error = register_one_time_approval(&scope(), "a", "f").unwrap_err();
        assert_eq!(
            error.to_string(),
            "registerOneTimeApproval is no longer supported; persist an approval request instead."
        );
        clear_one_time_approvals_for_tests();
    }
}
