//! Port of `src/server/channels/messages/service/subagent/executor.ts`.
//!
//! `run_subagent` is the background run: it attaches an abort controller, starts
//! the model tool loop with a restricted tool context and announces the result.
//! `invoke_subagent_tool_call` is the tool entry point for the `subagents` tool.

use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::channels::messages::service::execution::ports::{
    AbortController, AbortSignal, ConversationLookup, ModelLoopParams, ModelRoutingResolver,
    ModelToolLoop, PortError, PortResult, ToolManagerPort,
};
use crate::channels::messages::service::ports::SendResponse;
use crate::messages_store::types::{ChannelType, Conversation};
use crate::model_hub::types::{GatewayMessage, GatewayRole};

use super::constants::{
    SUBAGENT_ANNOUNCE_MAX_CHARS, SUBAGENT_DEFAULT_AGENT_ID, SUBAGENT_RESULT_PREVIEW_MAX_CHARS,
    SUBAGENT_TIMEOUT,
};
use super::manager::SubagentManager;
use super::registry::{SubagentRegistry, SubagentRunRecord};
use super::types::{RunSubagentParams, SubagentManagerDeps};
use super::utils::{
    filter_tool_context_for_subagent, non_empty, object, short_id, str_arg, truncate_utf16,
};
use crate::channels::messages::service::types::{SubagentAction, SubagentDispatchContext};

/// Text of the abort outcome. Aborted runs are not announced.
const ABORTED_MESSAGE: &str = "Subagent run aborted.";

/// `SubagentExecutorDeps` (`executor.ts:16-40`). The TS `runModelToolLoop` and
/// `sendResponse` members are ports here, and `subagentManager` is the manager.
pub struct SubagentExecutorDeps {
    pub manager: Arc<SubagentManager>,
    pub registry: Arc<dyn SubagentRegistry>,
    pub tool_manager: Arc<dyn ToolManagerPort>,
    pub resolve_routing: ModelRoutingResolver,
    pub model_loop: Arc<dyn ModelToolLoop>,
    pub sink: Arc<dyn SendResponse>,
}

/// Arguments of the `subagents` tool call (`invokeSubagentToolCall`).
#[derive(Debug, Clone)]
pub struct SubagentToolCall {
    pub args: Map<String, Value>,
    pub conversation_id: String,
    pub user_id: String,
    pub platform: ChannelType,
    pub external_chat_id: String,
}

/// `runSubagent(deps, sendResponse, params)`. The run is awaited here; the caller
/// decides whether to spawn it in the background (see `SubagentManagerDeps`).
///
/// The `finally` of the TypeScript version is reproduced by stopping the timer and
/// detaching the runtime after the outcome has been handled.
pub async fn run_subagent(
    deps: &SubagentExecutorDeps,
    params: RunSubagentParams,
) -> PortResult<()> {
    let RunSubagentParams {
        conversation,
        platform,
        external_chat_id,
        run,
    } = params;

    let abort = AbortController::new();
    deps.registry.attach_runtime(&run.run_id, abort.clone());

    // Auto-abort after the timeout to stop a runaway subagent (executor.ts:64-68).
    let timeout = {
        let abort = abort.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SUBAGENT_TIMEOUT).await;
            abort.abort();
        })
    };

    let outcome = execute(
        deps,
        &conversation,
        platform,
        &external_chat_id,
        &run,
        abort.signal(),
    )
    .await;
    timeout.abort();

    let result = match outcome {
        Ok(()) => Ok(()),
        Err(error) => {
            report_failure(
                deps,
                &conversation,
                platform,
                &external_chat_id,
                &run,
                error,
            )
            .await
        }
    };
    deps.registry.detach_runtime(&run.run_id);
    result
}

/// The `try` body of `runSubagent`: run the loop, complete the record, announce.
async fn execute(
    deps: &SubagentExecutorDeps,
    conversation: &Conversation,
    platform: ChannelType,
    external_chat_id: &str,
    run: &SubagentRunRecord,
    signal: AbortSignal,
) -> PortResult<()> {
    let routing = (deps.resolve_routing)(conversation);
    let tools = deps.tool_manager.resolve_tool_context().await?;
    let tool_context = filter_tool_context_for_subagent(&tools, run.tool_function_names.as_deref());
    let preferred_model_id = non_empty(run.model_override.as_deref())
        .map(str::to_string)
        .or(routing.preferred_model_id);

    let outcome = deps
        .model_loop
        .run_model_tool_loop(
            &*deps.tool_manager,
            ModelLoopParams {
                conversation: conversation.clone(),
                messages: build_messages(run),
                model_hub_profile_id: routing.model_hub_profile_id,
                preferred_model_id,
                workspace_cwd: run.workspace_path.clone(),
                tool_context,
                abort_signal: Some(signal),
                on_stream_delta: None,
            },
        )
        .await?;

    let preview =
        truncate_utf16(outcome.content.trim(), SUBAGENT_RESULT_PREVIEW_MAX_CHARS).to_string();
    deps.registry.complete_run(&run.run_id, Some(&preview));

    let body = if preview.is_empty() {
        "(empty response)"
    } else {
        preview.as_str()
    };
    let announce_full = format!(
        "Subagent {} finished ({}).\n\n{}",
        run.agent_id,
        short_id(&run.run_id),
        body
    );
    let announce = truncate_utf16(&announce_full, SUBAGENT_ANNOUNCE_MAX_CHARS);
    deps.sink
        .send_response(
            conversation,
            announce,
            platform,
            external_chat_id,
            Some(subagent_metadata("completed", run)),
        )
        .await?;
    Ok(())
}

/// The `catch` of `runSubagent`. Maps the error to its message, marks the run as
/// failed and tells the requester unless the run was aborted.
async fn report_failure(
    deps: &SubagentExecutorDeps,
    conversation: &Conversation,
    platform: ChannelType,
    external_chat_id: &str,
    run: &SubagentRunRecord,
    error: PortError,
) -> PortResult<()> {
    let message = match error {
        PortError::Aborted => ABORTED_MESSAGE.to_string(),
        PortError::Failed(message) => message,
    };
    deps.registry.fail_run(&run.run_id, &message);
    if message == ABORTED_MESSAGE {
        return Ok(());
    }

    let content = format!(
        "Subagent {} failed ({}): {}",
        run.agent_id,
        short_id(&run.run_id),
        message
    );
    deps.sink
        .send_response(
            conversation,
            &content,
            platform,
            external_chat_id,
            Some(subagent_metadata("error", run)),
        )
        .await?;
    Ok(())
}

/// Messages of the run: system prompt, optional workspace line, then the task.
fn build_messages(run: &SubagentRunRecord) -> Vec<GatewayMessage> {
    let mut messages = vec![GatewayMessage::new(GatewayRole::System, system_prompt(run))];
    if let Some(workspace) = non_empty(run.workspace_path.as_deref()) {
        messages.push(GatewayMessage::new(
            GatewayRole::System,
            format!("Task workspace directory: {workspace}"),
        ));
    }
    let user_content = match non_empty(run.guidance.as_deref()) {
        Some(guidance) => format!(
            "{}\n\nAdditional guidance from requester:\n{}",
            run.task, guidance
        ),
        None => run.task.clone(),
    };
    messages.push(GatewayMessage::new(GatewayRole::User, user_content));
    messages
}

/// The system prompt of `runSubagent`. The tool line lists the record's own
/// allow-list, not the filtered one.
fn system_prompt(run: &SubagentRunRecord) -> String {
    let mut prompt = String::new();
    prompt.push_str(
        "You are a focused subagent. Solve only the delegated task and return concise, factual results.\n",
    );
    prompt.push_str("IMPORTANT constraints:\n");
    prompt.push_str("- Do NOT spawn additional subagents — you are already a subagent.\n");
    prompt.push_str("- Do NOT poll tools in loops waiting for state changes; act directly.\n");
    prompt.push_str(
        "- Complete your task within the tool calls available, then return a final answer.\n",
    );
    if let Some(name) = non_empty(run.profile_name.as_deref()) {
        let id = non_empty(run.profile_id.as_deref()).unwrap_or(&run.agent_id);
        prompt.push_str(&format!("- Agent profile: {name} ({id}).\n"));
    }
    match run
        .tool_function_names
        .as_deref()
        .filter(|names| !names.is_empty())
    {
        Some(names) => prompt.push_str(&format!("- Allowed tools: {}.\n", names.join(", "))),
        None => prompt.push_str("- Allowed tools: all installed tools except subagents.\n"),
    }
    if let Some(skills) = run.skill_ids.as_deref().filter(|skills| !skills.is_empty()) {
        prompt.push_str(&format!("- Preferred skills: {}.", skills.join(", ")));
    }
    prompt
}

fn subagent_metadata(status: &str, run: &SubagentRunRecord) -> Map<String, Value> {
    object(json!({
        "runtime": "subagent",
        "subagentStatus": status,
        "subagentRunId": run.run_id,
        "subagentAgentId": run.agent_id,
    }))
}

/// `invokeSubagentToolCall(deps, params)`. Tool-level problems come back as data
/// (`status: "error"`). Only an error from the manager itself is returned as `Err`.
pub fn invoke_subagent_tool_call(
    deps: &SubagentExecutorDeps,
    lookup: &ConversationLookup,
    command_deps: &dyn SubagentManagerDeps,
    call: &SubagentToolCall,
) -> PortResult<Map<String, Value>> {
    let Some(conversation) = lookup(&call.conversation_id, &call.user_id) else {
        return Ok(object(json!({
            "status": "error",
            "error": "Conversation not found for subagent tool context.",
        })));
    };

    let raw_action = str_arg(&call.args, "action");
    let raw_action = if raw_action.is_empty() {
        "list".to_string()
    } else {
        raw_action
    };
    let action =
        SubagentAction::parse(&raw_action.trim().to_lowercase()).unwrap_or(SubagentAction::List);

    let mut args: Vec<String> = Vec::new();
    match action {
        SubagentAction::Spawn => {
            let agent_raw = str_arg(&call.args, "agentId");
            let agent_raw = if agent_raw.is_empty() {
                SUBAGENT_DEFAULT_AGENT_ID.to_string()
            } else {
                agent_raw
            };
            let agent_id = agent_raw.trim().to_string();
            let task = str_arg(&call.args, "task").trim().to_string();
            let model = str_arg(&call.args, "model").trim().to_string();
            if task.is_empty() {
                return Ok(object(json!({
                    "status": "error",
                    "action": action.as_str(),
                    "error": "subagents spawn requires task.",
                })));
            }
            args.push(agent_id);
            args.push(task);
            if !model.is_empty() {
                args.push("--model".to_string());
                args.push(model);
            }
        }
        SubagentAction::Kill | SubagentAction::Info | SubagentAction::Log => {
            args.push(str_arg(&call.args, "target").trim().to_string());
        }
        SubagentAction::Steer => {
            args.push(str_arg(&call.args, "target").trim().to_string());
            args.push(str_arg(&call.args, "message").trim().to_string());
        }
        SubagentAction::List | SubagentAction::Help | SubagentAction::Profiles => {}
    }
    // `args.filter(Boolean)`: blank arguments are dropped before the action runs.
    args.retain(|arg| !arg.is_empty());

    let context = SubagentDispatchContext {
        conversation,
        platform: call.platform,
        external_chat_id: call.external_chat_id.clone(),
    };
    let result = deps
        .manager
        .execute_subagent_action(&context, action, &args, command_deps)?;

    // `{ status, action, text, ...result.payload }`: payload keys win.
    let mut out = Map::new();
    out.insert(
        "status".to_string(),
        result
            .payload
            .get("status")
            .cloned()
            .unwrap_or_else(|| json!("ok")),
    );
    out.insert("action".to_string(), json!(action.as_str()));
    out.insert("text".to_string(), json!(result.text));
    out.extend(result.payload);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::channels::messages::service::execution::ports::PortError;
    use crate::channels::messages::service::execution::test_doubles::{
        conversation, lookup, routing, run_record, FakeModelLoop, FakeRegistry, FakeSink, FakeTools,
    };
    use crate::channels::messages::service::orchestration::SubagentCommandDeps;
    use crate::channels::messages::service::subagent::registry::SubagentRunStatus;

    struct Harness {
        registry: Arc<FakeRegistry>,
        sink: Arc<FakeSink>,
        model: Arc<FakeModelLoop>,
        deps: Arc<SubagentExecutorDeps>,
    }

    fn harness(model: FakeModelLoop) -> Harness {
        let registry = Arc::new(FakeRegistry::default());
        let sink = Arc::new(FakeSink::default());
        let model = Arc::new(model);
        let registry_port: Arc<dyn SubagentRegistry> = registry.clone();
        let manager = Arc::new(SubagentManager::new(
            registry_port.clone(),
            Arc::new(|| 5usize),
            None,
        ));
        let deps = Arc::new(SubagentExecutorDeps {
            manager,
            registry: registry_port,
            tool_manager: Arc::new(FakeTools::default()),
            resolve_routing: routing(),
            model_loop: model.clone(),
            sink: sink.clone(),
        });
        Harness {
            registry,
            sink,
            model,
            deps,
        }
    }

    fn run_params(run: SubagentRunRecord) -> RunSubagentParams {
        RunSubagentParams {
            conversation: conversation("conv", "user-1", None),
            platform: ChannelType::WebChat,
            external_chat_id: "web-1".to_string(),
            run,
        }
    }

    fn tool_call(args: Value) -> SubagentToolCall {
        SubagentToolCall {
            args: object(args),
            conversation_id: "conv".to_string(),
            user_id: "user-1".to_string(),
            platform: ChannelType::WebChat,
            external_chat_id: "web-1".to_string(),
        }
    }

    #[tokio::test]
    async fn completed_run_is_recorded_and_announced() {
        let h = harness(FakeModelLoop::replying("  done  "));
        h.registry.seed(run_record(
            "subagent-1234abcd",
            "conv",
            SubagentRunStatus::Running,
        ));
        let run = h.registry.get("subagent-1234abcd");

        run_subagent(&h.deps, run_params(run)).await.unwrap();

        let record = h.registry.get("subagent-1234abcd");
        assert_eq!(record.status, SubagentRunStatus::Completed);
        assert_eq!(record.result_preview.as_deref(), Some("done"));
        let sent = h.sink.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].content,
            "Subagent worker finished (subagent).\n\ndone"
        );
        let metadata = sent[0].metadata.clone().unwrap();
        assert_eq!(metadata["subagentStatus"], json!("completed"));
        assert_eq!(metadata["runtime"], json!("subagent"));

        let calls = h.model.calls.lock().unwrap();
        let system = &calls[0].messages[0].content;
        assert!(system.contains("- Allowed tools: all installed tools except subagents."));
        assert_eq!(calls[0].messages.last().unwrap().content, "do the thing");
        assert_eq!(calls[0].preferred_model_id.as_deref(), Some("model-a"));
        assert!(
            calls[0].had_abort_signal,
            "the run must get its abort signal"
        );
    }

    #[tokio::test]
    async fn model_failure_marks_run_error_and_tells_requester() {
        let h = harness(FakeModelLoop {
            reply: Mutex::new(Some(Err(PortError::Failed("upstream 500".to_string())))),
            ..Default::default()
        });
        h.registry.seed(run_record(
            "subagent-fail",
            "conv",
            SubagentRunStatus::Running,
        ));
        let run = h.registry.get("subagent-fail");

        run_subagent(&h.deps, run_params(run)).await.unwrap();

        let record = h.registry.get("subagent-fail");
        assert_eq!(record.status, SubagentRunStatus::Error);
        assert_eq!(record.error.as_deref(), Some("upstream 500"));
        let sent = h.sink.sent();
        assert_eq!(
            sent[0].content,
            "Subagent worker failed (subagent): upstream 500"
        );
        assert_eq!(
            sent[0].metadata.clone().unwrap()["subagentStatus"],
            json!("error")
        );
    }

    #[tokio::test]
    async fn aborted_run_is_not_announced() {
        let h = harness(FakeModelLoop {
            wait_for_abort: true,
            ..Default::default()
        });
        h.registry.seed(run_record(
            "subagent-stop",
            "conv",
            SubagentRunStatus::Running,
        ));
        let run = h.registry.get("subagent-stop");
        let registry = h.registry.clone();

        let (outcome, aborted) = tokio::join!(run_subagent(&h.deps, run_params(run)), async move {
            tokio::task::yield_now().await;
            registry.abort_run("subagent-stop", "stopped")
        });

        assert!(outcome.is_ok());
        assert!(aborted, "the runtime was attached and must be aborted");
        assert_eq!(
            h.registry.get("subagent-stop").status,
            SubagentRunStatus::Killed
        );
        assert!(h.sink.sent().is_empty());
    }

    #[tokio::test]
    async fn spawn_without_task_is_a_tool_error_value() {
        let h = harness(FakeModelLoop::default());
        let command_deps = SubagentCommandDeps::new(h.deps.manager.clone(), h.deps.clone());
        let out = invoke_subagent_tool_call(
            &h.deps,
            &lookup(vec![conversation("conv", "user-1", None)]),
            &command_deps,
            &tool_call(json!({ "action": "spawn", "agentId": "qa" })),
        )
        .unwrap();
        assert_eq!(out["status"], json!("error"));
        assert_eq!(out["error"], json!("subagents spawn requires task."));
    }

    #[tokio::test]
    async fn unknown_conversation_is_reported_as_data() {
        let h = harness(FakeModelLoop::default());
        let command_deps = SubagentCommandDeps::new(h.deps.manager.clone(), h.deps.clone());
        let out = invoke_subagent_tool_call(
            &h.deps,
            &lookup(vec![]),
            &command_deps,
            &tool_call(json!({ "action": "list" })),
        )
        .unwrap();
        assert_eq!(out["status"], json!("error"));
        assert_eq!(
            out["error"],
            json!("Conversation not found for subagent tool context.")
        );
    }

    #[tokio::test]
    async fn list_action_is_case_insensitive_and_returns_status_ok() {
        let h = harness(FakeModelLoop::default());
        let command_deps = SubagentCommandDeps::new(h.deps.manager.clone(), h.deps.clone());
        let out = invoke_subagent_tool_call(
            &h.deps,
            &lookup(vec![conversation("conv", "user-1", None)]),
            &command_deps,
            &tool_call(json!({ "action": " LIST " })),
        )
        .unwrap();
        assert_eq!(out["status"], json!("ok"));
        assert_eq!(out["action"], json!("list"));
        assert!(out["text"].as_str().unwrap().starts_with("Subagents"));
    }
}
