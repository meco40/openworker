//! Port of `src/server/master/capabilities/apprenticeship.ts:1-34`.
//!
//! Turns a connector request into a persisted capability proposal: the prose
//! comes from [`build_integration_proposal_template`] and the row is written with
//! the `awaiting_approval` status so it can be decided later.

use crate::master::capabilities::proposal_template::{
    build_integration_proposal_template, IntegrationProposalInput,
};
use crate::master::repository::governance_store::MasterCapabilityProposalInput;
use crate::master::repository::MasterRepository;
use crate::master::types::{MasterCapabilityProposal, WorkspaceScope};

/// `input` of `createCapabilityApprenticeshipProposal` — `apprenticeship.ts:8-16`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityApprenticeshipInput {
    pub capability: String,
    pub reason: String,
    pub api_reference: String,
    pub auth_model: String,
    pub scopes: Vec<String>,
    pub rate_limit: String,
    pub fallback_plan: String,
}

/// `createCapabilityApprenticeshipProposal` — `apprenticeship.ts:5-34`.
///
/// `title` is `` `Connector proposal: ${capability}` `` and `capabilityKey` is
/// the raw capability string (untrimmed).
pub fn create_capability_apprenticeship_proposal(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    input: &CapabilityApprenticeshipInput,
) -> rusqlite::Result<MasterCapabilityProposal> {
    let proposal_text = build_integration_proposal_template(&IntegrationProposalInput {
        capability: input.capability.clone(),
        reason: input.reason.clone(),
        api_reference: input.api_reference.clone(),
        auth_model: input.auth_model.clone(),
        scopes: input.scopes.clone(),
        rate_limit: input.rate_limit.clone(),
        fallback_plan: input.fallback_plan.clone(),
    });
    repo.create_capability_proposal(
        scope,
        &MasterCapabilityProposalInput {
            title: format!("Connector proposal: {}", input.capability),
            capability_key: input.capability.clone(),
            status: "awaiting_approval".to_string(),
            proposal: proposal_text,
            fallback_plan: input.fallback_plan.clone(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn input() -> CapabilityApprenticeshipInput {
        CapabilityApprenticeshipInput {
            capability: "gmail".to_string(),
            reason: "inbox triage".to_string(),
            api_reference: "https://gmail.googleapis.com".to_string(),
            auth_model: "oauth2".to_string(),
            scopes: vec!["mail.read".to_string()],
            rate_limit: "250/s".to_string(),
            fallback_plan: "poll less often".to_string(),
        }
    }

    #[test]
    fn the_proposal_uses_the_source_title_key_and_status() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let proposal =
            create_capability_apprenticeship_proposal(&repo, &scope(), &input()).unwrap();
        assert_eq!(proposal.title, "Connector proposal: gmail");
        assert_eq!(proposal.capability_key, "gmail");
        assert_eq!(proposal.status, "awaiting_approval");
        assert_eq!(proposal.fallback_plan, "poll less often");
        assert_eq!(
            proposal.proposal,
            "Capability: gmail\n\
             Reason: inbox triage\n\
             Official API: https://gmail.googleapis.com\n\
             Auth Model: oauth2\n\
             Scopes: mail.read\n\
             Rate Limits: 250/s\n\
             Fallback: poll less often"
        );
    }

    #[test]
    fn the_proposal_is_listed_back_for_the_scope() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        create_capability_apprenticeship_proposal(&repo, &scope, &input()).unwrap();
        let listed = repo.list_capability_proposals(&scope).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].capability_key, "gmail");
    }
}
