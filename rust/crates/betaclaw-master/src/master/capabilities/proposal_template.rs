//! Port of `src/server/master/capabilities/proposalTemplate.ts:1-19`.
//!
//! Renders the multi-line integration proposal that [`super::apprenticeship`]
//! stores on a capability proposal. The seven lines are joined with `\n` in the
//! source order; `Scopes` joins its list with `, ` (comma + space).

/// `input` of `buildIntegrationProposalTemplate` — `proposalTemplate.ts:1-9`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationProposalInput {
    pub capability: String,
    pub reason: String,
    pub api_reference: String,
    pub auth_model: String,
    pub scopes: Vec<String>,
    pub rate_limit: String,
    pub fallback_plan: String,
}

/// `buildIntegrationProposalTemplate` — `proposalTemplate.ts:1-19`.
pub fn build_integration_proposal_template(input: &IntegrationProposalInput) -> String {
    [
        format!("Capability: {}", input.capability),
        format!("Reason: {}", input.reason),
        format!("Official API: {}", input.api_reference),
        format!("Auth Model: {}", input.auth_model),
        format!("Scopes: {}", input.scopes.join(", ")),
        format!("Rate Limits: {}", input.rate_limit),
        format!("Fallback: {}", input.fallback_plan),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_template_joins_the_source_lines_in_order() {
        let input = IntegrationProposalInput {
            capability: "gmail".to_string(),
            reason: "inbox triage".to_string(),
            api_reference: "https://gmail.googleapis.com".to_string(),
            auth_model: "oauth2".to_string(),
            scopes: vec!["mail.read".to_string(), "mail.send".to_string()],
            rate_limit: "250/s".to_string(),
            fallback_plan: "poll less often".to_string(),
        };
        assert_eq!(
            build_integration_proposal_template(&input),
            "Capability: gmail\n\
             Reason: inbox triage\n\
             Official API: https://gmail.googleapis.com\n\
             Auth Model: oauth2\n\
             Scopes: mail.read, mail.send\n\
             Rate Limits: 250/s\n\
             Fallback: poll less often"
        );
    }

    #[test]
    fn empty_scopes_join_to_an_empty_string() {
        let input = IntegrationProposalInput {
            capability: "c".to_string(),
            reason: "r".to_string(),
            api_reference: "a".to_string(),
            auth_model: "m".to_string(),
            scopes: Vec::new(),
            rate_limit: "l".to_string(),
            fallback_plan: "f".to_string(),
        };
        assert!(build_integration_proposal_template(&input).contains("\nScopes: \n"));
    }
}
