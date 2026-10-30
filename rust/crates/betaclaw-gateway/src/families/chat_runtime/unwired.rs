//! Production subagent registry and tool invoker (`SubagentToolInvoker`).
//!
//! Bridges `betaclaw_core::agents::subagent_registry::SubagentRegistry` (S12) to
//! `betaclaw_core::channels::messages::service::subagent::registry::SubagentRegistry` (S8),
//! and implements [`SubagentToolInvoker`] over [`invoke_subagent_tool_call`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use betaclaw_core::agents::subagent_registry::{
    CreateSubagentRunInput as StoreCreateInput, SubagentRegistry as StoreRegistry,
    SubagentRunRecord as StoreRecord, SubagentRunStatus as StoreStatus,
};
use betaclaw_core::channels::messages::service::commands::types::SubagentManagerPort;
use betaclaw_core::channels::messages::service::execution::ports::{
    AbortController, ConversationLookup, PortError, PortResult,
};
use betaclaw_core::channels::messages::service::orchestration::subagent_tool_approval::{
    invoke_subagent_tool_call_operation, SubagentCommandDeps,
};
use betaclaw_core::channels::messages::service::ports::{
    BoxFuture, SubagentToolCallParams, SubagentToolInvoker,
};
use betaclaw_core::channels::messages::service::subagent::executor::{
    SubagentExecutorDeps, SubagentToolCall,
};
use betaclaw_core::channels::messages::service::subagent::manager::SubagentManager;
use betaclaw_core::channels::messages::service::subagent::registry::{
    CreateSubagentRunInput, SubagentRegistry, SubagentRunRecord, SubagentRunStatus,
    SubagentRunsView,
};
use betaclaw_core::channels::messages::service::subagent::types::{
    ActionResult, ParsedSubagentAction, SubagentManagerDeps,
};
use betaclaw_core::channels::messages::service::subagent::utils::parse_subagent_action;
use betaclaw_core::channels::messages::service::types::{SubagentAction, SubagentDispatchContext};
use betaclaw_core::model_hub::http::BoxFuture as HttpBoxFuture;
use serde_json::Value;

/// Bridges the JSON-backed `StoreRegistry` (`agents::subagent_registry`) to the S8
/// `SubagentRegistry` trait, and holds the watch-channel [`AbortController`] per active run.
pub struct FileSubagentRegistry {
    store: StoreRegistry,
    controllers: Mutex<HashMap<String, AbortController>>,
}

impl FileSubagentRegistry {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            store: StoreRegistry::new(path),
            controllers: Mutex::new(HashMap::new()),
        }
    }

    fn lock_controllers(&self) -> std::sync::MutexGuard<'_, HashMap<String, AbortController>> {
        self.controllers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

fn to_s8_status(status: StoreStatus) -> SubagentRunStatus {
    match status {
        StoreStatus::Running => SubagentRunStatus::Running,
        StoreStatus::Completed => SubagentRunStatus::Completed,
        StoreStatus::Error => SubagentRunStatus::Error,
        StoreStatus::Killed => SubagentRunStatus::Killed,
        StoreStatus::Other(_) => SubagentRunStatus::Error,
    }
}

fn to_s8_record(record: StoreRecord) -> SubagentRunRecord {
    SubagentRunRecord {
        run_id: record.run_id,
        requester_conversation_id: record.requester_conversation_id,
        requester_user_id: record.requester_user_id,
        agent_id: record.agent_id,
        profile_id: record.profile_id,
        profile_name: record.profile_name,
        skill_ids: record.skill_ids,
        tool_function_names: record.tool_function_names,
        task: record.task,
        guidance: record.guidance,
        model_override: record.model_override,
        project_id: record.project_id,
        workspace_path: record.workspace_path,
        workspace_relative_path: record.workspace_relative_path,
        status: to_s8_status(record.status),
        created_at: record.created_at,
        started_at: record.started_at,
        ended_at: record.ended_at,
        result_preview: record.result_preview,
        error: record.error,
        replaced_by_run_id: record.replaced_by_run_id,
    }
}

impl SubagentRegistry for FileSubagentRegistry {
    fn create_run(&self, input: CreateSubagentRunInput) -> SubagentRunRecord {
        let store_input = StoreCreateInput {
            requester_conversation_id: input.requester_conversation_id.clone(),
            requester_user_id: input.requester_user_id.clone(),
            agent_id: input.agent_id.clone(),
            profile_id: input.profile_id.clone(),
            profile_name: input.profile_name.clone(),
            skill_ids: input.skill_ids.clone(),
            tool_function_names: input.tool_function_names.clone(),
            task: input.task.clone(),
            guidance: input.guidance.clone(),
            model_override: input.model_override.clone(),
            project_id: input.project_id.clone(),
            workspace_path: input.workspace_path.clone(),
            workspace_relative_path: input.workspace_relative_path.clone(),
        };
        match self.store.create_run(store_input) {
            Ok(record) => to_s8_record(record),
            Err(error) => {
                tracing::warn!(error = %error, "chat_runtime: failed to persist subagent run");
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                SubagentRunRecord {
                    run_id: format!("subagent-{}", uuid::Uuid::new_v4()),
                    requester_conversation_id: input.requester_conversation_id,
                    requester_user_id: input.requester_user_id,
                    agent_id: input.agent_id,
                    profile_id: input.profile_id,
                    profile_name: input.profile_name,
                    skill_ids: input.skill_ids,
                    tool_function_names: input.tool_function_names,
                    task: input.task,
                    guidance: input.guidance,
                    model_override: input.model_override,
                    project_id: input.project_id,
                    workspace_path: input.workspace_path,
                    workspace_relative_path: input.workspace_relative_path,
                    status: SubagentRunStatus::Running,
                    created_at: now.clone(),
                    started_at: now,
                    ended_at: None,
                    result_preview: None,
                    error: None,
                    replaced_by_run_id: None,
                }
            }
        }
    }

    fn count_active_runs(&self, requester_conversation_id: &str) -> usize {
        self.store
            .count_active(requester_conversation_id)
            .unwrap_or(0)
    }

    fn list_runs_for_conversation(
        &self,
        requester_conversation_id: &str,
        recent_minutes: u64,
    ) -> SubagentRunsView {
        let minutes = i64::try_from(recent_minutes).unwrap_or(60);
        match self
            .store
            .list_for_conversation(requester_conversation_id, minutes)
        {
            Ok(runs) => SubagentRunsView {
                active: runs.active.into_iter().map(to_s8_record).collect(),
                recent: runs.recent.into_iter().map(to_s8_record).collect(),
            },
            Err(_) => SubagentRunsView::default(),
        }
    }

    fn list_active_runs(&self, requester_conversation_id: &str) -> Vec<SubagentRunRecord> {
        self.store
            .list_active(requester_conversation_id)
            .map(|runs| runs.into_iter().map(to_s8_record).collect())
            .unwrap_or_default()
    }

    fn abort_run(&self, run_id: &str, reason: &str) -> bool {
        let controller = self.lock_controllers().remove(run_id);
        if let Some(controller) = &controller {
            controller.abort();
        }
        let store_signalled = self.store.abort_run(run_id, Some(reason)).unwrap_or(false);
        controller.is_some() || store_signalled
    }

    fn mark_run_killed(&self, run_id: &str, reason: &str) {
        self.lock_controllers().remove(run_id);
        let _ = self.store.mark_killed(run_id, Some(reason));
    }

    fn replace_run(&self, previous_run_id: &str, next_run_id: &str) {
        let _ = self.store.replace_run(previous_run_id, next_run_id);
    }

    fn attach_runtime(&self, run_id: &str, controller: AbortController) {
        self.lock_controllers()
            .insert(run_id.to_string(), controller);
    }

    fn detach_runtime(&self, run_id: &str) {
        self.lock_controllers().remove(run_id);
        let _ = self.store.detach_runtime(run_id);
    }

    fn complete_run(&self, run_id: &str, result_preview: Option<&str>) {
        self.lock_controllers().remove(run_id);
        let _ = self.store.complete_run(run_id, result_preview);
    }

    fn fail_run(&self, run_id: &str, error: &str) {
        self.lock_controllers().remove(run_id);
        let _ = self.store.fail_run(run_id, error);
    }
}

/// Adapts [`SubagentManager`] to [`SubagentManagerPort`] for `/subagents`, `/kill`, `/steer`.
pub struct SubagentManagerAdapter(pub Arc<SubagentManager>);

impl SubagentManagerPort for SubagentManagerAdapter {
    fn parse_subagent_action(&self, payload: &str, command: Option<&str>) -> ParsedSubagentAction {
        parse_subagent_action(payload, command)
    }

    fn execute_subagent_action<'a>(
        &'a self,
        context: &'a SubagentDispatchContext,
        action: SubagentAction,
        args: &'a [String],
        host: &'a dyn SubagentManagerDeps,
    ) -> HttpBoxFuture<'a, Result<ActionResult, PortError>> {
        let result = self.0.execute_subagent_action(context, action, args, host);
        Box::pin(std::future::ready(result))
    }
}

/// Production [`SubagentToolInvoker`]. Bound after [`ToolManager`] is constructed to break
/// the circular reference between `ToolManager` -> `SubagentToolInvoker` -> `SubagentExecutorDeps` -> `ToolManager`.
#[derive(Default)]
pub struct WiredSubagentInvoker {
    inner: OnceLock<(
        Arc<SubagentExecutorDeps>,
        ConversationLookup,
        Arc<SubagentCommandDeps>,
    )>,
}

impl WiredSubagentInvoker {
    pub fn new() -> Self {
        Self {
            inner: OnceLock::new(),
        }
    }

    pub fn bind(
        &self,
        executor: Arc<SubagentExecutorDeps>,
        lookup: ConversationLookup,
        command_deps: Arc<SubagentCommandDeps>,
    ) {
        let _ = self.inner.set((executor, lookup, command_deps));
    }
}

impl SubagentToolInvoker for WiredSubagentInvoker {
    fn invoke(&self, params: SubagentToolCallParams) -> BoxFuture<'_, PortResult<Value>> {
        let result = (|| {
            let (executor, lookup, command_deps) = self.inner.get().ok_or_else(|| {
                PortError::Failed("chat_runtime: SubagentToolInvoker is not bound".to_string())
            })?;
            let args = params.args.as_object().cloned().unwrap_or_default();
            let call = SubagentToolCall {
                args,
                conversation_id: params.conversation_id,
                user_id: params.user_id,
                platform: params.platform,
                external_chat_id: params.external_chat_id,
            };
            let payload = invoke_subagent_tool_call_operation(
                executor,
                lookup,
                command_deps.as_ref(),
                &call,
            )?;
            Ok(Value::Object(payload))
        })();
        Box::pin(std::future::ready(result))
    }
}
