//! Port of `src/server/channels/messages/service/subagent/lifecycle/start.ts`.

use std::sync::Arc;

use crate::channels::messages::service::execution::ports::{PortError, PortResult};
use crate::messages_store::types::Conversation;

use super::super::agent_profiles::resolve_subagent_agent_profile;
use super::super::registry::{CreateSubagentRunInput, SubagentRegistry, SubagentRunRecord};
use super::super::types::StartSubagentRunParams;

/// Workspace of a conversation (`resolveConversationWorkspace` in the TS options).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkspaceRef {
    pub project_id: Option<String>,
    pub workspace_path: Option<String>,
    pub workspace_relative_path: Option<String>,
}

pub type WorkspaceResolver = Arc<dyn Fn(&Conversation) -> Option<WorkspaceRef> + Send + Sync>;

/// `startSubagentRun(params, options)`. The TypeScript version is `async` but
/// does no I/O of its own, so the port is synchronous. The limit check throws in
/// TS and returns `PortError::Failed` here, with the same message.
pub fn start_subagent_run(
    registry: &dyn SubagentRegistry,
    max_active: usize,
    workspace: Option<&WorkspaceResolver>,
    params: StartSubagentRunParams,
) -> PortResult<SubagentRunRecord> {
    let active = registry.count_active_runs(&params.conversation.id);
    if active >= max_active {
        return Err(PortError::Failed(format!(
            "Subagent limit reached ({active}/{max_active})."
        )));
    }

    let workspace = workspace.and_then(|resolve| resolve(&params.conversation));
    let profile = resolve_subagent_agent_profile(&params.agent_id);

    // Profile default guidance first, then the caller's guidance. Blank parts are
    // dropped, as in the TypeScript `.map(trim).filter(Boolean).join`.
    let merged_guidance = [
        profile.as_ref().and_then(|p| p.default_guidance.as_deref()),
        params.guidance.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|part| !part.is_empty())
    .collect::<Vec<&str>>()
    .join("\n\n");

    let input = CreateSubagentRunInput {
        requester_conversation_id: params.conversation.id.clone(),
        requester_user_id: params.conversation.user_id.clone(),
        agent_id: params.agent_id,
        profile_id: profile.as_ref().map(|p| p.id.clone()),
        profile_name: profile.as_ref().map(|p| p.name.clone()),
        skill_ids: profile.as_ref().map(|p| p.skill_ids.clone()),
        tool_function_names: profile.as_ref().map(|p| p.tool_function_names.clone()),
        task: params.task,
        guidance: (!merged_guidance.is_empty()).then_some(merged_guidance),
        model_override: params.model_override,
        project_id: workspace.as_ref().and_then(|w| w.project_id.clone()),
        workspace_path: workspace.as_ref().and_then(|w| w.workspace_path.clone()),
        workspace_relative_path: workspace
            .as_ref()
            .and_then(|w| w.workspace_relative_path.clone()),
    };
    Ok(registry.create_run(input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::execution::test_doubles::{
        conversation, run_record, FakeRegistry,
    };
    use crate::channels::messages::service::subagent::registry::SubagentRunStatus;
    use crate::messages_store::types::ChannelType;

    fn params(agent_id: &str, guidance: Option<&str>) -> StartSubagentRunParams {
        StartSubagentRunParams {
            conversation: conversation("conv", "user-1", None),
            platform: ChannelType::WebChat,
            external_chat_id: "web-1".to_string(),
            agent_id: agent_id.to_string(),
            task: "check login".to_string(),
            guidance: guidance.map(str::to_string),
            model_override: None,
        }
    }

    #[test]
    fn refuses_when_the_conversation_is_at_its_limit() {
        let registry = FakeRegistry::default();
        registry.seed(run_record("subagent-1", "conv", SubagentRunStatus::Running));
        let error = start_subagent_run(&registry, 1, None, params("worker", None)).unwrap_err();
        assert_eq!(
            error,
            PortError::Failed("Subagent limit reached (1/1).".to_string())
        );
    }

    #[test]
    fn merges_profile_guidance_and_records_workspace() {
        let registry = FakeRegistry::default();
        let resolver: WorkspaceResolver = Arc::new(|_conversation: &Conversation| {
            Some(WorkspaceRef {
                project_id: Some("p-1".to_string()),
                workspace_path: Some("/work".to_string()),
                workspace_relative_path: Some("work".to_string()),
            })
        });

        let run =
            start_subagent_run(&registry, 5, Some(&resolver), params("qa", Some("extra"))).unwrap();
        assert_eq!(run.profile_id.as_deref(), Some("qa"));
        assert_eq!(run.workspace_path.as_deref(), Some("/work"));
        let guidance = run.guidance.unwrap();
        assert!(guidance.starts_with("Execute deterministic browser QA steps"));
        assert!(guidance.ends_with("\n\nextra"));
    }

    #[test]
    fn worker_without_guidance_has_no_guidance_field() {
        let registry = FakeRegistry::default();
        let run = start_subagent_run(&registry, 5, None, params("worker", None)).unwrap();
        assert_eq!(run.guidance, None);
        assert_eq!(run.profile_name.as_deref(), Some("Worker"));
    }
}
