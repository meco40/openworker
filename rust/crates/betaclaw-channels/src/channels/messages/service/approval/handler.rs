//! Port of `src/server/channels/messages/service/approval/handler.ts`.
//!
//! `respond_tool_approval` answers an approval prompt the user has just seen. It
//! handles the project-workspace guard, denials, roleplay personas without tools,
//! "approve always" for commands, and the follow-up model turn.

use std::sync::Arc;

use serde_json::json;

use crate::channels::messages::service::conversation::ports::SessionPort;
use crate::channels::messages::service::execution::ports::{
    ConversationLookup, ModelLoopParams, ModelRoutingResolver, ModelToolLoop, PortResult,
    ToolManagerPort, WorkspaceCwdResolver,
};
use crate::channels::messages::service::ports::{
    ChatStore, PersonaPort, SendResponse, SummaryPort,
};
use crate::channels::messages::service::subagent::utils::{non_empty, object};
use crate::channels::messages::service::tool_manager::ToolCallRequest;
use crate::channels::messages::service::types::ToolExecutionResult;
use crate::model_hub::types::{GatewayMessage, GatewayRole};

/// `ROLEPLAY_TOOLS_DISABLED_MESSAGE` (`core/toolPolicy.ts`).
pub const ROLEPLAY_TOOLS_DISABLED_MESSAGE: &str =
    "Tools sind fuer diese Roleplay-Persona deaktiviert.";

const PROJECT_WORKSPACE_GUARD: &str = "project_workspace_guard";
const PROJECT_GUARD_REJECTED: &str = "Freigabe ohne Projekt wurde abgelehnt. Nutze `/project new <name>` oder `/project use <id|slug|index>`.";
const PROJECT_GUARD_APPROVED: &str = "Freigabe gespeichert. Diese Konversation darf voruebergehend ohne aktives Projekt fortfahren, bis ein Projekt gesetzt oder gewechselt wird.";
const COMMAND_REJECTED: &str = "Befehl wurde abgelehnt. Ich fuehre diesen Tool-Aufruf nicht aus.";

/// `setConversationProjectGuardApproved(conversationId, userId, approved)`.
pub type ProjectGuardSetter = Arc<dyn Fn(&str, &str, bool) + Send + Sync>;

/// `ApprovalHandlerDeps` (`handler.ts:12-45`). The TS optional members are
/// required here: the only callers pass all of them.
pub struct ApprovalHandlerDeps {
    pub session: Arc<dyn SessionPort>,
    pub chat: Arc<dyn ChatStore>,
    pub tool_manager: Arc<dyn ToolManagerPort>,
    pub summary: Arc<dyn SummaryPort>,
    pub persona: Arc<dyn PersonaPort>,
    pub model_loop: Arc<dyn ModelToolLoop>,
    pub get_conversation: ConversationLookup,
    pub set_project_guard_approved: ProjectGuardSetter,
    pub resolve_workspace_cwd: WorkspaceCwdResolver,
    pub resolve_routing: ModelRoutingResolver,
}

/// The `params` of `respondToolApproval`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalParams {
    pub conversation_id: String,
    pub user_id: String,
    pub approval_token: String,
    pub approved: bool,
    pub approve_always: bool,
    pub tool_id: Option<String>,
    pub tool_function_name: Option<String>,
}

/// `status` of the approval result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalStatus {
    Approved,
    Denied,
    NotFound,
    ApprovalRequired,
}

impl ApprovalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalStatus::Approved => "approved",
            ApprovalStatus::Denied => "denied",
            ApprovalStatus::NotFound => "not_found",
            ApprovalStatus::ApprovalRequired => "approval_required",
        }
    }
}

/// `{ ok, status, policyUpdated }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApprovalOutcome {
    pub ok: bool,
    pub status: ApprovalStatus,
    pub policy_updated: bool,
}

const NOT_FOUND: ApprovalOutcome = ApprovalOutcome {
    ok: false,
    status: ApprovalStatus::NotFound,
    policy_updated: false,
};

fn handled(status: ApprovalStatus, policy_updated: bool) -> ApprovalOutcome {
    ApprovalOutcome {
        ok: true,
        status,
        policy_updated,
    }
}

/// `areToolsDisabledForPersona` (`core/toolPolicy.ts`): only the `roleplay` type
/// disables tools. A missing persona does not.
fn tools_disabled_for_persona(memory_persona_type: Option<&str>) -> bool {
    memory_persona_type.is_some_and(|value| value.trim().to_lowercase() == "roleplay")
}

/// `respondToolApproval(deps, sendResponse, params)`.
pub async fn respond_tool_approval(
    deps: &ApprovalHandlerDeps,
    sink: &dyn SendResponse,
    params: &ApprovalParams,
) -> PortResult<ApprovalOutcome> {
    deps.tool_manager.prune_pending_tool_approvals();

    let token = params.approval_token.trim();
    if token.is_empty() {
        return Ok(NOT_FOUND);
    }

    let Some(pending) = deps.tool_manager.get_pending_approval(token) else {
        return Ok(NOT_FOUND);
    };
    if pending.user_id != deps.session.resolve_user_id(Some(&params.user_id))
        || pending.conversation_id != params.conversation_id
    {
        return Ok(NOT_FOUND);
    }
    if let Some(name) = non_empty(params.tool_function_name.as_deref()) {
        if name != pending.tool_function_name {
            return Ok(NOT_FOUND);
        }
    }
    if let (Some(tool_id), Some(pending_tool_id)) = (
        non_empty(params.tool_id.as_deref()),
        non_empty(pending.tool_id.as_deref()),
    ) {
        if tool_id != pending_tool_id {
            return Ok(NOT_FOUND);
        }
    }

    deps.tool_manager.delete_pending_approval(token);

    let Some(conversation) = (deps.get_conversation)(&pending.conversation_id, &pending.user_id)
    else {
        return Ok(NOT_FOUND);
    };
    let workspace_cwd = (deps.resolve_workspace_cwd)(&conversation);

    if pending.tool_function_name == PROJECT_WORKSPACE_GUARD {
        if !params.approved {
            sink.send_response(
                &conversation,
                PROJECT_GUARD_REJECTED,
                pending.platform,
                &pending.external_chat_id,
                None,
            )
            .await?;
            return Ok(handled(ApprovalStatus::Denied, false));
        }

        (deps.set_project_guard_approved)(&conversation.id, &conversation.user_id, true);
        sink.send_response(
            &conversation,
            PROJECT_GUARD_APPROVED,
            pending.platform,
            &pending.external_chat_id,
            None,
        )
        .await?;
        return Ok(handled(ApprovalStatus::Approved, false));
    }

    if !params.approved {
        sink.send_response(
            &conversation,
            COMMAND_REJECTED,
            pending.platform,
            &pending.external_chat_id,
            None,
        )
        .await?;
        return Ok(handled(ApprovalStatus::Denied, false));
    }

    let persona_type = match non_empty(conversation.persona_id.as_deref()) {
        Some(persona_id) => deps.persona.memory_persona_type(persona_id)?,
        None => None,
    };
    if tools_disabled_for_persona(persona_type.as_deref()) {
        sink.send_response(
            &conversation,
            ROLEPLAY_TOOLS_DISABLED_MESSAGE,
            pending.platform,
            &pending.external_chat_id,
            Some(object(json!({
                "ok": false,
                "status": "tools_disabled_for_roleplay",
            }))),
        )
        .await?;
        return Ok(handled(ApprovalStatus::Denied, false));
    }

    let mut policy_updated = false;
    if params.approve_always {
        if let Some(command) = non_empty(pending.command.as_deref()) {
            deps.tool_manager.approve_command(command).await?;
            policy_updated = true;
        }
    }

    let tool_context = deps.tool_manager.resolve_tool_context().await?;
    let execution = deps
        .tool_manager
        .execute_tool_function_call(ToolCallRequest {
            conversation: conversation.clone(),
            platform: pending.platform,
            external_chat_id: pending.external_chat_id.clone(),
            function_name: pending.tool_function_name.clone(),
            args: serde_json::Value::Object(pending.args.clone()),
            workspace_cwd: workspace_cwd.clone(),
            installed_functions: tool_context.installed_function_names.clone(),
            tool_id: pending.tool_id.clone(),
            skip_approval_check: true,
        })
        .await?;

    let tool_name = pending.tool_function_name.as_str();
    let tool_result_content = match &execution {
        ToolExecutionResult::Ok { output } => {
            format!("Tool \"{tool_name}\" result:\n{output}")
        }
        ToolExecutionResult::ApprovalRequired { .. } => {
            format!("Tool \"{tool_name}\" failed:\nApproval unresolved.")
        }
        ToolExecutionResult::Error { output } => {
            format!("Tool \"{tool_name}\" failed:\n{output}")
        }
    };

    let mut messages = deps.chat.build_gateway_messages(
        &conversation.id,
        &conversation.user_id,
        50,
        conversation.persona_id.as_deref(),
    )?;
    messages.push(GatewayMessage::new(
        GatewayRole::Assistant,
        format!("[Tool call: {tool_name}]"),
    ));
    messages.push(GatewayMessage::new(GatewayRole::User, tool_result_content));

    let routing = (deps.resolve_routing)(&conversation);
    let model_outcome = deps
        .model_loop
        .run_model_tool_loop(
            &*deps.tool_manager,
            ModelLoopParams {
                conversation: conversation.clone(),
                messages,
                model_hub_profile_id: routing.model_hub_profile_id,
                preferred_model_id: routing.preferred_model_id,
                workspace_cwd,
                tool_context,
                abort_signal: None,
                on_stream_delta: None,
            },
        )
        .await?;

    sink.send_response(
        &conversation,
        &model_outcome.content,
        pending.platform,
        &pending.external_chat_id,
        Some(model_outcome.metadata.clone()),
    )
    .await?;

    deps.summary.schedule_summary_refresh(conversation.clone());

    let status = model_outcome
        .metadata
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    let next_status = if status == "approval_required" {
        ApprovalStatus::ApprovalRequired
    } else {
        ApprovalStatus::Approved
    };
    Ok(handled(next_status, policy_updated))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::channels::messages::service::execution::test_doubles::{
        conversation, pending, ApprovalFixture, FakeSink,
    };

    fn params(conversation_id: &str, user_id: &str, token: &str, approved: bool) -> ApprovalParams {
        ApprovalParams {
            conversation_id: conversation_id.to_string(),
            user_id: user_id.to_string(),
            approval_token: token.to_string(),
            approved,
            approve_always: false,
            tool_id: None,
            tool_function_name: None,
        }
    }

    fn fixture() -> ApprovalFixture {
        ApprovalFixture::new(conversation("conv-1", "user-1", None))
    }

    #[tokio::test]
    async fn unknown_token_is_not_found_and_silent() {
        let fixture = fixture();
        let sink = FakeSink::default();
        let outcome = respond_tool_approval(
            &fixture.deps(),
            &sink,
            &params("conv-1", "user-1", "missing", true),
        )
        .await
        .unwrap();
        assert_eq!(
            outcome,
            ApprovalOutcome {
                ok: false,
                status: ApprovalStatus::NotFound,
                policy_updated: false,
            }
        );
        assert!(sink.sent().is_empty());
    }

    #[tokio::test]
    async fn token_of_another_user_is_not_found() {
        let fixture = fixture();
        let other = conversation("conv-1", "other-user", None);
        fixture
            .tools
            .pending
            .lock()
            .unwrap()
            .insert("tok".into(), pending("tok", &other, "shell_execute"));
        let outcome = respond_tool_approval(
            &fixture.deps(),
            &FakeSink::default(),
            &params("conv-1", "user-1", "tok", true),
        )
        .await
        .unwrap();
        assert_eq!(outcome.status, ApprovalStatus::NotFound);
        assert!(fixture.tools.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn approved_shell_call_runs_the_tool_and_sends_the_model_answer() {
        let fixture = fixture();
        let conv = fixture.conversation.clone();
        fixture
            .tools
            .pending
            .lock()
            .unwrap()
            .insert("tok".into(), pending("tok", &conv, "shell_execute"));
        fixture
            .tools
            .outcomes
            .lock()
            .unwrap()
            .push_back(ToolExecutionResult::Ok {
                output: "file.txt".into(),
            });
        let sink = FakeSink::default();

        let outcome = respond_tool_approval(
            &fixture.deps(),
            &sink,
            &params("conv-1", "user-1", "tok", true),
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, ApprovalStatus::Approved);
        assert!(outcome.ok && !outcome.policy_updated);
        assert_eq!(sink.sent()[0].content, "model answer");
        let calls = fixture.tools.calls.lock().unwrap();
        assert_eq!(calls[0].function_name, "shell_execute");
        assert!(calls[0].skip_approval_check);
        let loop_calls = fixture.model.calls.lock().unwrap();
        let messages = &loop_calls[0].messages;
        assert_eq!(
            messages[messages.len() - 2].content,
            "[Tool call: shell_execute]"
        );
        assert_eq!(
            messages[messages.len() - 1].content,
            "Tool \"shell_execute\" result:\nfile.txt"
        );
        assert_eq!(loop_calls[0].workspace_cwd.as_deref(), Some("/work/space"));
        assert_eq!(
            fixture.summary.scheduled.lock().unwrap().as_slice(),
            ["conv-1"]
        );
    }

    #[tokio::test]
    async fn approve_always_stores_the_command_policy() {
        let fixture = fixture();
        let conv = fixture.conversation.clone();
        fixture
            .tools
            .pending
            .lock()
            .unwrap()
            .insert("tok".into(), pending("tok", &conv, "shell_execute"));
        fixture
            .tools
            .outcomes
            .lock()
            .unwrap()
            .push_back(ToolExecutionResult::Error {
                output: "boom".into(),
            });
        let mut request = params("conv-1", "user-1", "tok", true);
        request.approve_always = true;

        let outcome = respond_tool_approval(&fixture.deps(), &FakeSink::default(), &request)
            .await
            .unwrap();

        assert!(outcome.policy_updated);
        assert_eq!(
            fixture.tools.approved_commands.lock().unwrap().as_slice(),
            ["ls -la"]
        );
        let loop_calls = fixture.model.calls.lock().unwrap();
        assert_eq!(
            loop_calls[0].messages.last().unwrap().content,
            "Tool \"shell_execute\" failed:\nboom"
        );
    }

    #[tokio::test]
    async fn denial_sends_the_rejection_without_running_the_tool() {
        let fixture = fixture();
        let conv = fixture.conversation.clone();
        fixture
            .tools
            .pending
            .lock()
            .unwrap()
            .insert("tok".into(), pending("tok", &conv, "shell_execute"));
        let sink = FakeSink::default();

        let outcome = respond_tool_approval(
            &fixture.deps(),
            &sink,
            &params("conv-1", "user-1", "tok", false),
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, ApprovalStatus::Denied);
        assert!(sink.sent()[0]
            .content
            .starts_with("Befehl wurde abgelehnt."));
        assert!(fixture.tools.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn project_guard_approval_sets_the_flag() {
        let fixture = fixture();
        let conv = fixture.conversation.clone();
        fixture
            .tools
            .pending
            .lock()
            .unwrap()
            .insert("tok".into(), pending("tok", &conv, PROJECT_WORKSPACE_GUARD));
        let sink = FakeSink::default();

        let outcome = respond_tool_approval(
            &fixture.deps(),
            &sink,
            &params("conv-1", "user-1", "tok", true),
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, ApprovalStatus::Approved);
        assert_eq!(
            fixture.guard_calls.lock().unwrap().as_slice(),
            [("conv-1".to_string(), "user-1".to_string(), true)]
        );
        assert!(sink.sent()[0].content.starts_with("Freigabe gespeichert."));
    }

    #[tokio::test]
    async fn roleplay_persona_blocks_tools_with_metadata() {
        let mut fixture = fixture();
        let conv = conversation("conv-1", "user-1", Some("persona-r"));
        fixture.conversation = conv.clone();
        fixture.persona = Arc::new(
            crate::channels::messages::service::execution::test_doubles::FakePersona {
                memory_types: HashMap::from([("persona-r".to_string(), "Roleplay".to_string())]),
            },
        );
        fixture
            .tools
            .pending
            .lock()
            .unwrap()
            .insert("tok".into(), pending("tok", &conv, "shell_execute"));
        let sink = FakeSink::default();

        let outcome = respond_tool_approval(
            &fixture.deps(),
            &sink,
            &params("conv-1", "user-1", "tok", true),
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, ApprovalStatus::Denied);
        let sent = sink.sent();
        assert_eq!(sent[0].content, ROLEPLAY_TOOLS_DISABLED_MESSAGE);
        assert_eq!(
            sent[0].metadata.as_ref().unwrap()["status"],
            json!("tools_disabled_for_roleplay")
        );
        assert!(fixture.tools.calls.lock().unwrap().is_empty());
    }
}
