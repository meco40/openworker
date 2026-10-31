//! Port of `src/server/channels/messages/service/subagent/agentProfiles.ts`.
//!
//! The four built-in profiles, their aliases and tool allow-lists are copied
//! verbatim. Serialisation matches the TypeScript objects because the `profiles`
//! action returns them in its payload.

use serde::Serialize;

/// `SubagentAgentProfile` (`agentProfiles.ts:1-9`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentAgentProfile {
    pub id: String,
    pub aliases: Vec<String>,
    pub name: String,
    pub description: String,
    pub skill_ids: Vec<String>,
    pub tool_function_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_guidance: Option<String>,
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn profiles() -> Vec<SubagentAgentProfile> {
    vec![
        SubagentAgentProfile {
            id: "worker".into(),
            aliases: strings(&["default", "general"]),
            name: "Worker".into(),
            description: "General execution agent with full tool access.".into(),
            skill_ids: strings(&["shell-access", "python-runtime", "filesystem", "process-manager"]),
            tool_function_names: Vec::new(),
            default_guidance: None,
        },
        SubagentAgentProfile {
            id: "planner".into(),
            aliases: strings(&["architect"]),
            name: "Planner".into(),
            description: "Planning and decomposition agent with analysis-oriented tools.".into(),
            skill_ids: strings(&["filesystem", "web-search", "web-fetch", "sql-bridge"]),
            tool_function_names: strings(&["file_read", "web_search", "web_fetch", "db_query"]),
            default_guidance: None,
        },
        SubagentAgentProfile {
            id: "researcher".into(),
            aliases: strings(&["research"]),
            name: "Researcher".into(),
            description: "Research-focused agent for web and repository investigation.".into(),
            skill_ids: strings(&["web-search", "web-fetch", "browser", "github-manager", "filesystem"]),
            tool_function_names: strings(&[
                "web_search",
                "web_fetch",
                "browser_snapshot",
                "github_query",
                "file_read",
            ]),
            default_guidance: None,
        },
        SubagentAgentProfile {
            id: "qa".into(),
            aliases: strings(&["playwright", "tester"]),
            name: "QA Playwright".into(),
            description: "Browser QA agent using Playwright CLI and shell verification.".into(),
            skill_ids: strings(&["playwright-cli", "shell-access", "filesystem", "process-manager"]),
            tool_function_names: strings(&[
                "playwright_cli",
                "shell_execute",
                "file_read",
                "process_manager",
            ]),
            default_guidance: Some(
                "Execute deterministic browser QA steps with Playwright CLI and report failures with actionable details."
                    .into(),
            ),
        },
    ]
}

/// `listSubagentAgentProfiles()`.
pub fn list_subagent_agent_profiles() -> Vec<SubagentAgentProfile> {
    profiles()
}

/// `resolveSubagentAgentProfile(agentId)`: matches the id or any alias after
/// trimming and lower-casing. A blank input resolves to nothing.
pub fn resolve_subagent_agent_profile(agent_id: &str) -> Option<SubagentAgentProfile> {
    let normalized = agent_id.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    profiles().into_iter().find(|profile| {
        profile.id == normalized
            || profile
                .aliases
                .iter()
                .any(|alias| alias.trim().to_lowercase() == normalized)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alias_and_id_resolve_case_insensitively() {
        assert_eq!(
            resolve_subagent_agent_profile(" Architect ").map(|p| p.id),
            Some("planner".to_string())
        );
        assert_eq!(
            resolve_subagent_agent_profile("QA").map(|p| p.id),
            Some("qa".to_string())
        );
        assert!(resolve_subagent_agent_profile("  ").is_none());
        assert!(resolve_subagent_agent_profile("unknown").is_none());
    }
}
