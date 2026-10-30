//! Port of `src/server/channels/messages/service/handlers/shellInference.ts`.
//!
//! `handle_inferred_shell_question` runs a shell command that was inferred from a
//! natural-language question (for example "wie viele Dateien liegen auf dem
//! Desktop"), then lets the model answer from the output.

use std::sync::Arc;

use serde_json::json;

use crate::channels::messages::service::execution::ports::{
    ModelLoopParams, ModelRoutingResolver, ModelToolLoop, PortResult, StreamSink, ToolManagerPort,
    WorkspaceCwdResolver,
};
use crate::channels::messages::service::ports::{ChatStore, SendResponse};
use crate::channels::messages::service::subagent::utils::object;
use crate::channels::messages::service::tool_manager::ToolCallRequest;
use crate::channels::messages::service::types::ToolExecutionResult;
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};
use crate::model_hub::types::{GatewayMessage, GatewayRole};

/// `ShellInferenceDeps`.
pub struct ShellInferenceDeps {
    pub chat: Arc<dyn ChatStore>,
    pub tool_manager: Arc<dyn ToolManagerPort>,
    pub model_loop: Arc<dyn ModelToolLoop>,
    pub resolve_routing: ModelRoutingResolver,
    pub resolve_workspace_cwd: WorkspaceCwdResolver,
}

/// Input of [`handle_inferred_shell_question`].
pub struct ShellInferenceParams {
    pub conversation: Conversation,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub user_input: String,
    pub command: String,
    pub on_stream_delta: Option<StreamSink>,
}

/// `handleInferredShellQuestion(deps, sendResponse, params)`.
pub async fn handle_inferred_shell_question(
    deps: &ShellInferenceDeps,
    sink: &dyn SendResponse,
    params: ShellInferenceParams,
) -> PortResult<StoredMessage> {
    let conversation = &params.conversation;
    let workspace_cwd = (deps.resolve_workspace_cwd)(conversation);
    let tool_context = deps.tool_manager.resolve_tool_context().await?;

    let execution = deps
        .tool_manager
        .execute_tool_function_call(ToolCallRequest {
            conversation: conversation.clone(),
            platform: params.platform,
            external_chat_id: params.external_chat_id.clone(),
            function_name: "shell_execute".to_string(),
            args: serde_json::Value::Object(object(json!({ "command": params.command }))),
            workspace_cwd: workspace_cwd.clone(),
            installed_functions: tool_context.installed_function_names.clone(),
            tool_id: Some(
                tool_context
                    .function_to_skill_id
                    .get("shell_execute")
                    .cloned()
                    .unwrap_or_else(|| "shell-access".to_string()),
            ),
            skip_approval_check: false,
        })
        .await?;

    let output = match execution {
        ToolExecutionResult::ApprovalRequired { prompt, pending } => {
            let metadata = deps.tool_manager.build_approval_metadata(
                &pending,
                &prompt,
                object(json!({
                    "ok": false,
                    "runtime": "chat-shell-inference",
                    "inferredCommand": params.command,
                    "inferredFrom": params.user_input,
                })),
            );
            return sink
                .send_response(
                    conversation,
                    &prompt,
                    params.platform,
                    &params.external_chat_id,
                    Some(metadata),
                )
                .await;
        }
        ToolExecutionResult::Ok { output } => {
            format!("Tool \"shell_execute\" result:\n{output}")
        }
        ToolExecutionResult::Error { output } => {
            format!("Tool \"shell_execute\" failed:\n{output}")
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
        "[Tool call: shell_execute]",
    ));
    messages.push(GatewayMessage::new(GatewayRole::User, output));

    let routing = (deps.resolve_routing)(conversation);
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
                on_stream_delta: params.on_stream_delta,
            },
        )
        .await?;

    // `{ ...modelOutcome.metadata, runtime, inferredCommand }`: these two keys win.
    let mut metadata = model_outcome.metadata;
    metadata.insert("runtime".to_string(), json!("chat-shell-inference"));
    metadata.insert("inferredCommand".to_string(), json!(params.command));
    sink.send_response(
        conversation,
        &model_outcome.content,
        params.platform,
        &params.external_chat_id,
        Some(metadata),
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::channels::messages::service::execution::test_doubles::{
        conversation, pending, routing, FakeContext, FakeModelLoop, FakeSink, FakeTools,
    };

    fn deps(tools: Arc<FakeTools>, model: Arc<FakeModelLoop>) -> ShellInferenceDeps {
        ShellInferenceDeps {
            chat: Arc::new(FakeContext {
                messages: Vec::new(),
            }),
            tool_manager: tools,
            model_loop: model,
            resolve_routing: routing(),
            resolve_workspace_cwd: Arc::new(|_conversation: &Conversation| None::<String>),
        }
    }

    fn params(command: &str) -> ShellInferenceParams {
        ShellInferenceParams {
            conversation: conversation("conv-1", "user-1", None),
            platform: ChannelType::WebChat,
            external_chat_id: "web-1".to_string(),
            user_input: "wie viele Dateien?".to_string(),
            command: command.to_string(),
            on_stream_delta: None,
        }
    }

    #[tokio::test]
    async fn approval_prompt_is_sent_with_the_inferred_command() {
        let tools = Arc::new(FakeTools::default());
        let conv = conversation("conv-1", "user-1", None);
        tools
            .outcomes
            .lock()
            .unwrap()
            .push_back(ToolExecutionResult::ApprovalRequired {
                prompt: "Approve?".to_string(),
                pending: Box::new(pending("t", &conv, "shell_execute")),
            });
        let sink = FakeSink::default();

        handle_inferred_shell_question(
            &deps(tools, Arc::new(FakeModelLoop::default())),
            &sink,
            params("ls"),
        )
        .await
        .unwrap();

        let sent = sink.sent();
        assert_eq!(sent[0].content, "Approve?");
        let metadata = sent[0].metadata.as_ref().unwrap();
        assert_eq!(metadata["status"], json!("approval_required"));
        assert_eq!(metadata["inferredCommand"], json!("ls"));
        assert_eq!(metadata["inferredFrom"], json!("wie viele Dateien?"));
    }

    #[tokio::test]
    async fn tool_output_is_answered_by_the_model_with_runtime_metadata() {
        let tools = Arc::new(FakeTools::default());
        tools
            .outcomes
            .lock()
            .unwrap()
            .push_back(ToolExecutionResult::Ok {
                output: "3".to_string(),
            });
        let model = Arc::new(FakeModelLoop::replying("Du hast 3 Dateien."));
        let sink = FakeSink::default();

        handle_inferred_shell_question(&deps(tools, model.clone()), &sink, params("dir"))
            .await
            .unwrap();

        let sent = sink.sent();
        assert_eq!(sent[0].content, "Du hast 3 Dateien.");
        let metadata = sent[0].metadata.as_ref().unwrap();
        assert_eq!(metadata["runtime"], json!("chat-shell-inference"));
        assert_eq!(metadata["inferredCommand"], json!("dir"));
        let calls = model.calls.lock().unwrap();
        assert_eq!(
            calls[0].messages.last().unwrap().content,
            "Tool \"shell_execute\" result:\n3"
        );
    }
}
