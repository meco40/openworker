//! In-memory doubles of the S8 ports for the unit tests of this slice. They are
//! compiled only for `cargo test`. The real implementations belong to S11, S12,
//! and Agent C.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use crate::channels::messages::service::approval::handler::ApprovalHandlerDeps;
use crate::channels::messages::service::conversation::ports::SessionPort;
use crate::channels::messages::service::dispatchers::ai::types::ModelOutcome;
use crate::channels::messages::service::execution::ports::{
    AbortController, ConversationLookup, ModelLoopParams, ModelRoutingResolver, ModelToolLoop,
    PortError, PortResult, ToolManagerPort,
};
use crate::channels::messages::service::ports::{
    AutoMemoryCandidate, ChatStore, ConversationWindowInput, KnowledgeLayerFlags, PersonaPort,
    SendResponse, StoreMemoryInput, SummaryPort, UserMessageOptions, WorkspacePaths,
};
use crate::channels::messages::service::routing::model_routing::ModelRoutingConfig;
use crate::channels::messages::service::tool_manager::ToolCallRequest;
use crate::channels::messages::service::types::{
    PendingToolApproval, ResolvedToolContext, ToolExecutionResult,
};
use crate::personas::types::PersonaProfile;

use crate::channels::messages::service::handlers::memory_handler::{
    MemoryStoreRequest, MemoryWritePort,
};
use crate::channels::messages::service::handlers::web_ui_handler::{
    InboundPort, InboundRequest, WebUiMessageResult,
};
use crate::channels::messages::service::subagent::registry::{
    CreateSubagentRunInput, SubagentRegistry, SubagentRunRecord, SubagentRunStatus,
    SubagentRunsView,
};
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};
use crate::model_hub::http::BoxFuture;
use crate::model_hub::types::GatewayMessage;

pub const NOW: &str = "2026-10-11T00:00:00.000Z";

pub fn conversation(id: &str, user_id: &str, persona_id: Option<&str>) -> Conversation {
    Conversation {
        id: id.to_string(),
        channel_type: "WebChat".to_string(),
        external_chat_id: Some("web-1".to_string()),
        user_id: user_id.to_string(),
        workspace_id: None,
        title: "Test".to_string(),
        model_override: None,
        persona_id: persona_id.map(str::to_string),
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
    }
}

pub fn stored(conversation: &Conversation, content: &str) -> StoredMessage {
    StoredMessage {
        id: format!("msg-{}", content.len()),
        conversation_id: conversation.id.clone(),
        seq: None,
        role: "assistant".to_string(),
        content: content.to_string(),
        platform: "WebChat".to_string(),
        external_msg_id: None,
        sender_name: None,
        metadata: None,
        created_at: NOW.to_string(),
    }
}

pub fn routing() -> ModelRoutingResolver {
    Arc::new(|_conversation: &Conversation| ModelRoutingConfig {
        preferred_model_id: Some("model-a".to_string()),
        model_hub_profile_id: "p1".to_string(),
    })
}

pub fn lookup(conversations: Vec<Conversation>) -> ConversationLookup {
    Arc::new(move |id: &str, user_id: &str| {
        conversations
            .iter()
            .find(|conversation| conversation.id == id && conversation.user_id == user_id)
            .cloned()
    })
}

/// A subagent run record with the fields the tests look at. Other fields are empty.
pub fn run_record(
    run_id: &str,
    conversation_id: &str,
    status: SubagentRunStatus,
) -> SubagentRunRecord {
    SubagentRunRecord {
        run_id: run_id.to_string(),
        requester_conversation_id: conversation_id.to_string(),
        requester_user_id: "user-1".to_string(),
        agent_id: "worker".to_string(),
        profile_id: None,
        profile_name: None,
        skill_ids: None,
        tool_function_names: None,
        task: "do the thing".to_string(),
        guidance: None,
        model_override: None,
        project_id: None,
        workspace_path: None,
        workspace_relative_path: None,
        status,
        created_at: NOW.to_string(),
        started_at: NOW.to_string(),
        ended_at: None,
        result_preview: None,
        error: None,
        replaced_by_run_id: None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SentMessage {
    pub content: String,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub metadata: Option<Map<String, Value>>,
}

/// Records every send and returns a stored message with the same content.
#[derive(Default)]
pub struct FakeSink {
    sent: Mutex<Vec<SentMessage>>,
}

impl FakeSink {
    pub fn sent(&self) -> Vec<SentMessage> {
        self.sent.lock().unwrap().clone()
    }
}

impl SendResponse for FakeSink {
    fn send_response<'a>(
        &'a self,
        conversation: &'a Conversation,
        content: &'a str,
        platform: ChannelType,
        external_chat_id: &'a str,
        metadata: Option<Map<String, Value>>,
    ) -> BoxFuture<'a, PortResult<StoredMessage>> {
        Box::pin(async move {
            self.sent.lock().unwrap().push(SentMessage {
                content: content.to_string(),
                platform,
                external_chat_id: external_chat_id.to_string(),
                metadata,
            });
            Ok(stored(conversation, content))
        })
    }
}

/// In-memory registry with the same visible behaviour as the S12 store: an
/// attached runtime is aborted by `abort_run`, which then reports `true`.
#[derive(Default)]
pub struct FakeRegistry {
    state: Mutex<RegistryState>,
}

#[derive(Default)]
struct RegistryState {
    runs: Vec<SubagentRunRecord>,
    runtimes: HashMap<String, AbortController>,
    next_id: usize,
}

impl FakeRegistry {
    pub fn seed(&self, run: SubagentRunRecord) {
        self.state.lock().unwrap().runs.push(run);
    }

    pub fn get(&self, run_id: &str) -> SubagentRunRecord {
        self.state
            .lock()
            .unwrap()
            .runs
            .iter()
            .find(|run| run.run_id == run_id)
            .cloned()
            .expect("run was seeded or created")
    }

    fn update(&self, run_id: &str, change: impl FnOnce(&mut SubagentRunRecord)) {
        let mut state = self.state.lock().unwrap();
        if let Some(run) = state.runs.iter_mut().find(|run| run.run_id == run_id) {
            change(run);
        }
    }
}

impl SubagentRegistry for FakeRegistry {
    fn create_run(&self, input: CreateSubagentRunInput) -> SubagentRunRecord {
        let mut state = self.state.lock().unwrap();
        state.next_id += 1;
        let run = SubagentRunRecord {
            run_id: format!("subagent-{:04}", state.next_id),
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
            created_at: NOW.to_string(),
            started_at: NOW.to_string(),
            ended_at: None,
            result_preview: None,
            error: None,
            replaced_by_run_id: None,
        };
        state.runs.push(run.clone());
        run
    }

    fn count_active_runs(&self, requester_conversation_id: &str) -> usize {
        self.list_active_runs(requester_conversation_id).len()
    }

    fn list_runs_for_conversation(
        &self,
        requester_conversation_id: &str,
        _recent_minutes: u64,
    ) -> SubagentRunsView {
        let state = self.state.lock().unwrap();
        let own: Vec<SubagentRunRecord> = state
            .runs
            .iter()
            .rev()
            .filter(|run| run.requester_conversation_id == requester_conversation_id)
            .cloned()
            .collect();
        SubagentRunsView {
            active: own
                .iter()
                .filter(|run| run.status == SubagentRunStatus::Running)
                .cloned()
                .collect(),
            recent: own
                .iter()
                .filter(|run| run.status != SubagentRunStatus::Running)
                .cloned()
                .collect(),
        }
    }

    fn list_active_runs(&self, requester_conversation_id: &str) -> Vec<SubagentRunRecord> {
        self.list_runs_for_conversation(requester_conversation_id, 0)
            .active
    }

    fn abort_run(&self, run_id: &str, reason: &str) -> bool {
        let controller = self.state.lock().unwrap().runtimes.get(run_id).cloned();
        self.mark_run_killed(run_id, reason);
        match controller {
            Some(controller) => {
                controller.abort();
                true
            }
            None => false,
        }
    }

    fn mark_run_killed(&self, run_id: &str, reason: &str) {
        self.update(run_id, |run| {
            run.status = SubagentRunStatus::Killed;
            run.ended_at = Some(NOW.to_string());
            run.error = Some(reason.to_string());
        });
    }

    fn replace_run(&self, previous_run_id: &str, next_run_id: &str) {
        self.update(previous_run_id, |run| {
            run.replaced_by_run_id = Some(next_run_id.to_string());
        });
    }

    fn attach_runtime(&self, run_id: &str, controller: AbortController) {
        self.state
            .lock()
            .unwrap()
            .runtimes
            .insert(run_id.to_string(), controller);
    }

    fn detach_runtime(&self, run_id: &str) {
        self.state.lock().unwrap().runtimes.remove(run_id);
    }

    fn complete_run(&self, run_id: &str, result_preview: Option<&str>) {
        self.update(run_id, |run| {
            run.status = SubagentRunStatus::Completed;
            run.ended_at = Some(NOW.to_string());
            run.result_preview = result_preview.map(str::to_string);
        });
    }

    fn fail_run(&self, run_id: &str, error: &str) {
        self.update(run_id, |run| {
            if run.status != SubagentRunStatus::Killed {
                run.status = SubagentRunStatus::Error;
            }
            run.error = Some(error.to_string());
        });
    }
}

/// Tool manager with scripted outcomes. Every call is recorded.
#[derive(Default)]
pub struct FakeTools {
    pub pending: Mutex<HashMap<String, PendingToolApproval>>,
    pub context: Mutex<ResolvedToolContext>,
    pub outcomes: Mutex<VecDeque<ToolExecutionResult>>,
    pub calls: Mutex<Vec<ToolCallRequest>>,
    pub approved_commands: Mutex<Vec<String>>,
}

impl ToolManagerPort for FakeTools {
    fn prune_pending_tool_approvals(&self) {}

    fn get_pending_approval(&self, token: &str) -> Option<PendingToolApproval> {
        self.pending.lock().unwrap().get(token).cloned()
    }

    fn delete_pending_approval(&self, token: &str) -> bool {
        self.pending.lock().unwrap().remove(token).is_some()
    }

    fn approve_command<'a>(&'a self, command: &'a str) -> BoxFuture<'a, PortResult<()>> {
        Box::pin(async move {
            self.approved_commands
                .lock()
                .unwrap()
                .push(command.to_string());
            Ok(())
        })
    }

    fn resolve_tool_context(&self) -> BoxFuture<'_, PortResult<ResolvedToolContext>> {
        Box::pin(async move { Ok(self.context.lock().unwrap().clone()) })
    }

    fn execute_tool_function_call(
        &self,
        request: ToolCallRequest,
    ) -> BoxFuture<'_, PortResult<ToolExecutionResult>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(request);
            let next = self.outcomes.lock().unwrap().pop_front();
            next.ok_or_else(|| PortError::Failed("no scripted tool outcome".to_string()))
        })
    }
}

/// What the model loop saw in one call.
#[derive(Debug, Clone)]
pub struct LoopCall {
    pub messages: Vec<GatewayMessage>,
    pub preferred_model_id: Option<String>,
    pub workspace_cwd: Option<String>,
    pub had_abort_signal: bool,
}

/// Model loop with a fixed reply. With `wait_for_abort` it waits for the signal
/// and then fails with `PortError::Aborted`, as the real loop does.
#[derive(Default)]
pub struct FakeModelLoop {
    pub reply: Mutex<Option<PortResult<ModelOutcome>>>,
    pub calls: Mutex<Vec<LoopCall>>,
    pub wait_for_abort: bool,
}

impl FakeModelLoop {
    pub fn replying(content: &str) -> Self {
        Self {
            reply: Mutex::new(Some(Ok(ModelOutcome {
                content: content.to_string(),
                metadata: Map::new(),
            }))),
            ..Self::default()
        }
    }
}

impl ModelToolLoop for FakeModelLoop {
    fn run_model_tool_loop<'a>(
        &'a self,
        _tools: &'a dyn ToolManagerPort,
        mut params: ModelLoopParams,
    ) -> BoxFuture<'a, PortResult<ModelOutcome>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(LoopCall {
                messages: params.messages.clone(),
                preferred_model_id: params.preferred_model_id.clone(),
                workspace_cwd: params.workspace_cwd.clone(),
                had_abort_signal: params.abort_signal.is_some(),
            });
            if self.wait_for_abort {
                if let Some(signal) = params.abort_signal.as_mut() {
                    signal.aborted().await;
                }
                return Err(PortError::Aborted);
            }
            let reply = self.reply.lock().unwrap().clone();
            reply.unwrap_or_else(|| Err(PortError::Failed("no scripted reply".to_string())))
        })
    }
}

pub struct FakeContext {
    pub messages: Vec<GatewayMessage>,
}

/// Only `build_gateway_messages` is reached by the approval and shell tests.
impl ChatStore for FakeContext {
    fn append_user_message(
        &self,
        _conversation_id: &str,
        _platform: ChannelType,
        _content: &str,
        _options: UserMessageOptions,
    ) -> PortResult<StoredMessage> {
        unreachable!("not used by the execution tests")
    }

    fn append_agent_message(
        &self,
        _conversation_id: &str,
        _platform: ChannelType,
        _content: &str,
        _metadata: Option<Value>,
    ) -> PortResult<StoredMessage> {
        unreachable!("not used by the execution tests")
    }

    fn build_gateway_messages(
        &self,
        _conversation_id: &str,
        _user_id: &str,
        _limit: usize,
        _persona_id: Option<&str>,
    ) -> PortResult<Vec<GatewayMessage>> {
        Ok(self.messages.clone())
    }

    fn list_recent_messages(
        &self,
        _conversation_id: &str,
        _user_id: &str,
        _limit: usize,
    ) -> PortResult<Vec<StoredMessage>> {
        unreachable!("not used by the execution tests")
    }

    fn apply_channel_binding_persona(
        &self,
        _conversation: &Conversation,
        _platform: ChannelType,
    ) -> PortResult<Conversation> {
        unreachable!("not used by the execution tests")
    }
}

#[derive(Default)]
pub struct FakeSummary {
    pub scheduled: Mutex<Vec<String>>,
}

impl SummaryPort for FakeSummary {
    fn schedule_summary_refresh(&self, conversation: Conversation) {
        self.scheduled.lock().unwrap().push(conversation.id);
    }

    fn is_ai_summary_enabled(&self) -> bool {
        unreachable!("not used by the execution tests")
    }

    fn build_fallback_summary(&self, _previous: &str, _messages: &[(String, String)]) -> String {
        unreachable!("not used by the execution tests")
    }

    fn is_auto_session_memory_enabled(&self) -> bool {
        unreachable!("not used by the execution tests")
    }

    fn auto_session_memory_mode(&self) -> String {
        unreachable!("not used by the execution tests")
    }

    fn build_auto_memory_candidates(
        &self,
        _messages: &[StoredMessage],
    ) -> Vec<AutoMemoryCandidate> {
        unreachable!("not used by the execution tests")
    }

    fn resolve_memory_user_id(&self, _conversation: &Conversation) -> String {
        unreachable!("not used by the execution tests")
    }

    fn store_memory(&self, _input: StoreMemoryInput) -> BoxFuture<'_, PortResult<()>> {
        unreachable!("not used by the execution tests")
    }

    fn is_inline_knowledge_ingestion_enabled(&self) -> bool {
        unreachable!("not used by the execution tests")
    }

    fn knowledge_layer_flags(&self) -> KnowledgeLayerFlags {
        unreachable!("not used by the execution tests")
    }

    fn ingest_conversation_window(
        &self,
        _input: ConversationWindowInput,
    ) -> BoxFuture<'_, PortResult<()>> {
        unreachable!("not used by the execution tests")
    }

    fn trace_auto_session_memory(&self, _name: &str, _fields: Value) {
        unreachable!("not used by the execution tests")
    }

    fn clear_in_flight(&self, _conversation_id: &str) {
        unreachable!("not used by the execution tests")
    }
}

pub struct FakeSession {
    pub conversation: Option<Conversation>,
}

impl SessionPort for FakeSession {
    fn get_or_create_conversation(
        &self,
        _channel: ChannelType,
        _external_chat_id: &str,
        _title: Option<&str>,
        _user_id: Option<&str>,
    ) -> PortResult<Conversation> {
        unreachable!("not used by the execution tests")
    }

    fn resolve_conversation_for_web_chat(
        &self,
        _conversation_id: &str,
        _user_id: &str,
    ) -> PortResult<Conversation> {
        self.conversation
            .clone()
            .ok_or_else(|| PortError::Failed("Conversation not found for current user.".into()))
    }
}

pub struct FakePersona {
    pub memory_types: HashMap<String, String>,
}

impl PersonaPort for FakePersona {
    fn list_personas(&self, _user_id: &str) -> PortResult<Vec<PersonaProfile>> {
        unreachable!("not used by the execution tests")
    }

    fn get_persona(&self, _id: &str) -> PortResult<Option<PersonaProfile>> {
        unreachable!("not used by the execution tests")
    }

    fn create_project_workspace(
        &self,
        _persona_slug: &str,
        _task: &str,
        _requested_name: &str,
    ) -> PortResult<WorkspacePaths> {
        unreachable!("not used by the execution tests")
    }

    fn remove_project_workspace(
        &self,
        _persona_slug: &str,
        _workspace_path: &str,
    ) -> PortResult<()> {
        unreachable!("not used by the execution tests")
    }

    fn memory_persona_type(&self, persona_id: &str) -> PortResult<Option<String>> {
        Ok(self.memory_types.get(persona_id).cloned())
    }
}

#[derive(Default)]
pub struct FakeMemory {
    pub blocked: bool,
    pub fail: bool,
    pub stored: Mutex<Vec<MemoryStoreRequest>>,
}

impl MemoryWritePort for FakeMemory {
    fn is_mem0_factual_write_blocked(&self) -> bool {
        self.blocked
    }

    fn store_memory<'a>(&'a self, request: MemoryStoreRequest) -> BoxFuture<'a, PortResult<()>> {
        Box::pin(async move {
            self.stored.lock().unwrap().push(request);
            if self.fail {
                return Err(PortError::Failed("db down".to_string()));
            }
            Ok(())
        })
    }
}

/// Inbound pipeline that records its arguments and answers with stored messages.
#[derive(Default)]
pub struct FakeInbound {
    pub requests: Mutex<Vec<InboundRequest>>,
}

impl InboundPort for FakeInbound {
    fn handle_inbound<'a>(
        &'a self,
        request: InboundRequest,
    ) -> BoxFuture<'a, PortResult<WebUiMessageResult>> {
        Box::pin(async move {
            let conv = conversation("inbound", &request.user_id, None);
            let result = WebUiMessageResult {
                user_msg: stored(&conv, &request.content),
                agent_msg: stored(&conv, "reply"),
                new_conversation_id: None,
            };
            self.requests.lock().unwrap().push(request);
            Ok(result)
        })
    }
}

/// Approval deps wired to the doubles. Tests change the fields they need.
pub struct ApprovalFixture {
    pub tools: Arc<FakeTools>,
    pub model: Arc<FakeModelLoop>,
    pub summary: Arc<FakeSummary>,
    pub persona: Arc<FakePersona>,
    pub guard_calls: Arc<Mutex<Vec<(String, String, bool)>>>,
    pub conversation: Conversation,
}

impl ApprovalFixture {
    pub fn new(conversation: Conversation) -> Self {
        Self {
            tools: Arc::new(FakeTools::default()),
            model: Arc::new(FakeModelLoop::replying("model answer")),
            summary: Arc::new(FakeSummary::default()),
            persona: Arc::new(FakePersona {
                memory_types: HashMap::new(),
            }),
            guard_calls: Arc::new(Mutex::new(Vec::new())),
            conversation,
        }
    }

    pub fn deps(&self) -> ApprovalHandlerDeps {
        let guard_calls = Arc::clone(&self.guard_calls);
        ApprovalHandlerDeps {
            session: Arc::new(FakeSession {
                conversation: Some(self.conversation.clone()),
            }),
            chat: Arc::new(FakeContext {
                messages: vec![GatewayMessage::user("earlier question")],
            }),
            tool_manager: self.tools.clone(),
            summary: self.summary.clone(),
            persona: self.persona.clone(),
            model_loop: self.model.clone(),
            get_conversation: lookup(vec![self.conversation.clone()]),
            set_project_guard_approved: Arc::new(
                move |conversation_id: &str, user_id: &str, approved: bool| {
                    guard_calls.lock().unwrap().push((
                        conversation_id.to_string(),
                        user_id.to_string(),
                        approved,
                    ));
                },
            ),
            resolve_workspace_cwd: Arc::new(|_conversation: &Conversation| {
                Some("/work/space".to_string())
            }),
            resolve_routing: routing(),
        }
    }
}

/// A pending approval for `shell_execute` in the given conversation.
pub fn pending(token: &str, conversation: &Conversation, tool: &str) -> PendingToolApproval {
    PendingToolApproval {
        token: token.to_string(),
        user_id: conversation.user_id.clone(),
        conversation_id: conversation.id.clone(),
        platform: ChannelType::WebChat,
        external_chat_id: "web-1".to_string(),
        tool_function_name: tool.to_string(),
        tool_id: Some("shell-access".to_string()),
        args: Map::new(),
        command: Some("ls -la".to_string()),
        created_at_ms: 0,
    }
}
