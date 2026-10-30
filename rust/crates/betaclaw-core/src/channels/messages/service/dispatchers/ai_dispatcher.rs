//! Port of `src/server/channels/messages/service/dispatchers/aiDispatcher.ts`.
//!
//! `dispatchToAI` prepares the transcript, registers the abort signal for the
//! conversation, runs the tool loop, and then starts the summary refresh in the
//! background. A failure inside the try block becomes a reply, not an error.
//! Only the transcript preparation can fail the call.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::channels::messages::service::conversation::ports::MessageRepositoryPort;
use crate::channels::messages::service::core::project_management::resolve_conversation_workspace_cwd;
use crate::channels::messages::service::core::types::lock;
use crate::channels::messages::service::dispatchers::ai::prepare_dispatch_messages::{
    prepare_dispatch_messages, PrepareDispatchDeps, PrepareDispatchParams,
};
use crate::channels::messages::service::dispatchers::ai::run_model_tool_loop::run_model_tool_loop;
use crate::channels::messages::service::dispatchers::ai::types::{
    AuditContextExtras, DispatchToAiParams, ModelOutcome, RunModelToolLoopParams,
};
use crate::channels::messages::service::dispatchers::skills_prompt::SkillMdPort;
use crate::channels::messages::service::execution::ports::{PortError, PortResult};
use crate::channels::messages::service::ports::{ChatStore, ModelGateway, PersonaPort, RecallPort};
use crate::channels::messages::service::routing::model_routing::resolve_chat_model_routing;
use crate::channels::messages::service::summary_service::SummaryService;
use crate::channels::messages::service::tool_manager::ToolManager;
use crate::channels::messages::service::types::ResolvedToolContext;
use crate::messages_store::types::Conversation;
use crate::model_hub::env::EnvOverrides;
use crate::model_hub::http::AbortSignal;

/// Dependencies of [`dispatch_to_ai`] (`AIDispatcherDeps`).
pub struct AiDispatcherDeps<'a> {
    pub context: &'a dyn ChatStore,
    pub repo: &'a dyn MessageRepositoryPort,
    pub recall: &'a dyn RecallPort,
    pub skills: &'a dyn SkillMdPort,
    pub personas: &'a dyn PersonaPort,
    pub model: &'a dyn ModelGateway,
    pub tools: &'a ToolManager,
    pub env: &'a EnvOverrides,
    pub summary: Arc<SummaryService>,
    /// `activeRequests`: one abort signal per conversation.
    pub active_requests: &'a Mutex<HashMap<String, AbortSignal>>,
}

/// `createEmptyToolContext()` (`aiDispatcher.ts:32-38`).
fn create_empty_tool_context() -> ResolvedToolContext {
    ResolvedToolContext::default()
}

/// `resolveDispatchFailure(error)` (`aiDispatcher.ts:40-54`).
fn resolve_dispatch_failure(error: &PortError) -> ModelOutcome {
    if matches!(error, PortError::Aborted) {
        return ModelOutcome {
            content: "Generation aborted.".to_string(),
            metadata: map_of([("ok", json!(false)), ("aborted", json!(true))]),
        };
    }
    ModelOutcome {
        content: format!("AI dispatch failed: {}", error),
        metadata: map_of([("ok", json!(false)), ("error", json!(error.to_string()))]),
    }
}

/// `enforceRequiredToolExecution` (`aiDispatcher.ts:56-76`). With `requireToolCall`,
/// a turn that ran no tool fails, unless it is waiting for approval.
fn enforce_required_tool_execution(outcome: ModelOutcome, require_tool_call: bool) -> ModelOutcome {
    let executed = outcome
        .metadata
        .get("executedToolCalls")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let status = match outcome.metadata.get("status") {
        Some(Value::String(text)) => text.as_str(),
        _ => "",
    };
    if !require_tool_call || executed >= 1 || status == "approval_required" {
        return outcome;
    }

    let mut metadata = outcome.metadata.clone();
    metadata.insert("ok".into(), json!(false));
    metadata.insert("status".into(), json!("tool_execution_required_unmet"));
    metadata.insert("executedToolCalls".into(), json!(executed));
    ModelOutcome {
        content: "Execution failed: no real tool execution happened for this task. Retry dispatch with an execution-capable agent response.".to_string(),
        metadata,
    }
}

/// `dispatchToAI(deps, params)` (`aiDispatcher.ts:78-138`).
pub async fn dispatch_to_ai(
    deps: &AiDispatcherDeps<'_>,
    params: DispatchToAiParams,
) -> PortResult<ModelOutcome> {
    let conversation: &Conversation = &params.conversation;

    let prepared = prepare_dispatch_messages(
        PrepareDispatchDeps {
            context: deps.context,
            repo: deps.repo,
            recall: deps.recall,
            skills: deps.skills,
            tools: deps.tools,
        },
        PrepareDispatchParams {
            conversation: conversation.clone(),
            user_input: params.user_input.clone(),
            execution_directive: params.execution_directive.clone(),
            tools_disabled: params.tools_disabled,
        },
    )
    .await?;

    let abort = AbortSignal::new();
    {
        let mut active = lock(deps.active_requests);
        if let Some(existing) = active.get(&conversation.id) {
            existing.abort();
        }
        active.insert(conversation.id.clone(), abort.clone());
    }

    let inner = async {
        let routing = resolve_chat_model_routing(conversation, deps.personas, deps.env);
        let workspace_cwd = resolve_conversation_workspace_cwd(conversation, deps.repo)?;
        let tool_context = if params.tools_disabled {
            create_empty_tool_context()
        } else {
            deps.tools.resolve_tool_context().await?
        };

        run_model_tool_loop(
            deps.model,
            deps.tools,
            RunModelToolLoopParams {
                conversation: conversation.clone(),
                messages: prepared.messages.clone(),
                model_hub_profile_id: routing.model_hub_profile_id,
                preferred_model_id: routing.preferred_model_id,
                workspace_cwd,
                tool_context,
                max_tool_calls: params.max_tool_calls,
                abort_signal: Some(abort.clone()),
                on_stream_delta: params.on_stream_delta.clone(),
                audit_context_extras: AuditContextExtras {
                    turn_seq: params.turn_seq,
                    memory_context: prepared.memory_context.clone(),
                },
            },
        )
        .await
    };

    let model_outcome = match inner.await {
        Ok(outcome) => outcome,
        Err(error) => resolve_dispatch_failure(&error),
    };
    lock(deps.active_requests).remove(&conversation.id);

    if !params.skip_summary_refresh {
        let summary = Arc::clone(&deps.summary);
        let conversation_for_summary = conversation.clone();
        tokio::spawn(async move {
            // Fire-and-forget, like `void summaryService.maybeRefresh...`.
            let _ = summary
                .maybe_refresh_conversation_summary(&conversation_for_summary)
                .await;
        });
    }

    Ok(enforce_required_tool_execution(
        model_outcome,
        params.require_tool_call,
    ))
}

fn map_of<const N: usize>(entries: [(&str, Value); N]) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(status: Option<&str>, executed: i64) -> ModelOutcome {
        let mut metadata = map_of([("ok", json!(true)), ("executedToolCalls", json!(executed))]);
        if let Some(status) = status {
            metadata.insert("status".into(), json!(status));
        }
        ModelOutcome {
            content: "reply".into(),
            metadata,
        }
    }

    #[test]
    fn required_tool_call_is_enforced_when_nothing_ran() {
        let unmet = enforce_required_tool_execution(outcome(None, 0), true);
        assert_eq!(unmet.metadata["status"], "tool_execution_required_unmet");
        assert_eq!(unmet.metadata["ok"], json!(false));
        assert!(unmet
            .content
            .starts_with("Execution failed: no real tool execution"));
    }

    #[test]
    fn required_tool_call_passes_with_a_tool_or_an_approval_pause() {
        assert_eq!(
            enforce_required_tool_execution(outcome(None, 1), true).content,
            "reply"
        );
        assert_eq!(
            enforce_required_tool_execution(outcome(Some("approval_required"), 0), true).content,
            "reply"
        );
        assert_eq!(
            enforce_required_tool_execution(outcome(None, 0), false).content,
            "reply"
        );
    }

    #[test]
    fn aborted_and_failed_dispatches_map_to_replies() {
        let aborted = resolve_dispatch_failure(&PortError::Aborted);
        assert_eq!(aborted.content, "Generation aborted.");
        assert_eq!(aborted.metadata["aborted"], json!(true));

        let failed = resolve_dispatch_failure(&PortError::from("gateway down"));
        assert_eq!(failed.content, "AI dispatch failed: gateway down");
        assert_eq!(failed.metadata["error"], json!("gateway down"));
    }
}
