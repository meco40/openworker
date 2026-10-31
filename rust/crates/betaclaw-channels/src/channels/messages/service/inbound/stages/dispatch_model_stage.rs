//! Port of `src/server/channels/messages/service/inbound/stages/dispatchModelStage.ts`.
//!
//! Build intent in a workspace runs a preflight first. The execution directive is
//! assembled as `[roleplay policy, explicit or autonomous directive]`. The model
//! output is then cleaned of code blocks unless code was requested or the turn failed.

use serde_json::{Map, Value};

use crate::channels::messages::service::core::configuration::{
    should_allow_code_in_response, strip_code_blocks_if_needed,
};
use crate::channels::messages::service::core::project_management::resolve_conversation_workspace_cwd;
use crate::channels::messages::service::dispatchers::ai::types::DispatchToAiParams;
use crate::channels::messages::service::dispatchers::ai_dispatcher::{
    dispatch_to_ai, AiDispatcherDeps,
};
use crate::channels::messages::service::execution::build_execution::PreflightResult;
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::inbound::handle_inbound::{
    InboundDeps, InboundParams, InboundResult,
};
use crate::channels::messages::service::ports::MaxToolCallsInput;
use crate::channels::messages::service::project_guard::is_project_required_intent;
use crate::channels::messages::service::types::is_explicit_recall_command;
use crate::messages_store::types::{Conversation, StoredMessage};
use crate::personas::types::PersonaProfile;

/// Roleplay tool policy line (`dispatchModelStage.ts:75-77`).
const ROLEPLAY_TOOL_DIRECTIVE: &str =
    "TOOL POLICY: Fuer diese Roleplay-Persona sind alle Tool-Calls deaktiviert.";

/// Inputs of the model stage that the context and prepare stages produced.
pub struct DispatchModelStageInput<'a> {
    pub user_msg: &'a StoredMessage,
    pub effective: &'a Conversation,
    pub active_persona: Option<&'a PersonaProfile>,
    pub tools_disabled: bool,
    pub effective_user_input: &'a str,
    pub project_created_from_clarification: Option<&'a str>,
}

/// `dispatchModelStage(input)` (`dispatchModelStage.ts:33-139`).
pub async fn dispatch_model_stage(
    deps: &InboundDeps,
    params: &InboundParams,
    input: DispatchModelStageInput<'_>,
) -> PortResult<InboundResult> {
    let platform = params.platform;
    let chat_id = params.external_chat_id.as_str();
    let effective = input.effective;
    let tools_disabled = input.tools_disabled;

    let active_workspace_cwd = resolve_conversation_workspace_cwd(effective, &*deps.repo)?;
    let build_intent = is_project_required_intent(input.effective_user_input);
    let is_autonomous_persona = input.active_persona.is_some_and(|p| p.is_autonomous);
    let explicit_recall_command = is_explicit_recall_command(input.effective_user_input);

    let mut dispatch_user_input = input.effective_user_input.to_string();
    if build_intent && !tools_disabled {
        if let Some(workspace_cwd) = &active_workspace_cwd {
            let preflight = deps
                .execution
                .run_build_workspace_preflight(
                    effective.clone(),
                    platform,
                    chat_id.to_string(),
                    workspace_cwd.clone(),
                    deps.tools.clone(),
                    deps.send.clone(),
                )
                .await?;
            match preflight {
                PreflightResult::ApprovalRequired { message } => {
                    return Ok(InboundResult {
                        user_msg: input.user_msg.clone(),
                        agent_msg: *message,
                        new_conversation_id: None,
                    });
                }
                PreflightResult::Summary { text } => {
                    dispatch_user_input = format!("{}\n\n{}", input.effective_user_input, text);
                }
            }
        }
    }

    let autonomous_directive = deps.execution.autonomous_execution_directive(
        active_workspace_cwd.clone(),
        if tools_disabled { false } else { build_intent },
        if tools_disabled {
            false
        } else {
            is_autonomous_persona
        },
    );
    let explicit_directive = params
        .opts
        .execution_directive
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let roleplay_directive = if tools_disabled {
        ROLEPLAY_TOOL_DIRECTIVE.to_string()
    } else {
        String::new()
    };
    // `[roleplay].concat(explicit || autonomous || '')`, then drop blanks and join.
    let second = if explicit_directive.is_empty() {
        autonomous_directive.unwrap_or_default()
    } else {
        explicit_directive
    };
    let combined = [roleplay_directive, second]
        .into_iter()
        .filter(|entry| !entry.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let execution_directive = (!combined.trim().is_empty()).then_some(combined);

    let max_tool_calls = deps.execution.resolve_max_tool_calls(MaxToolCallsInput {
        is_autonomous_persona,
        persona_max_tool_calls: input.active_persona.map(|p| p.max_tool_calls),
        build_intent,
        override_max_tool_calls: params.opts.max_tool_calls,
    });

    let ai_deps = AiDispatcherDeps {
        context: &*deps.chat,
        repo: &*deps.repo,
        recall: &*deps.recall,
        skills: &*deps.skills,
        personas: &*deps.personas,
        model: &*deps.model,
        tools: &deps.tools,
        env: &deps.env,
        summary: deps.summary.clone(),
        active_requests: &deps.state.active_requests,
    };
    let outcome = dispatch_to_ai(
        &ai_deps,
        DispatchToAiParams {
            conversation: effective.clone(),
            platform,
            external_chat_id: chat_id.to_string(),
            user_input: dispatch_user_input,
            on_stream_delta: params.on_stream_delta.clone(),
            turn_seq: input.user_msg.seq,
            execution_directive,
            max_tool_calls: Some(max_tool_calls),
            skip_summary_refresh: explicit_recall_command,
            require_tool_call: params.opts.require_tool_call,
            tools_disabled,
        },
    )
    .await?;

    let allow_code = should_allow_code_in_response(
        input.effective_user_input,
        &Value::Object(outcome.metadata.clone()),
    );
    let normalized_output = strip_code_blocks_if_needed(&outcome.content, allow_code);
    let final_output = match input.project_created_from_clarification {
        Some(name) => {
            format!("Projekt automatisch erstellt und aktiviert: {name}\n\n{normalized_output}")
        }
        None => normalized_output,
    };

    let mut metadata: Map<String, Value> = outcome.metadata.clone();
    if build_intent && !tools_disabled {
        metadata.insert("executionMode".into(), "autonomous".into());
    }
    if let Some(workspace_cwd) = &active_workspace_cwd {
        metadata.insert("workspaceCwd".into(), workspace_cwd.clone().into());
    }

    let agent_msg = deps
        .send
        .send_response(effective, &final_output, platform, chat_id, Some(metadata))
        .await?;

    Ok(InboundResult {
        user_msg: input.user_msg.clone(),
        agent_msg,
        new_conversation_id: None,
    })
}
