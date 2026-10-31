//! Trait-Ports fuer Abhaengigkeiten ausserhalb von `channels/messages/service`.
//!
//! Kein TypeScript-Original: dies sind die Naehte, an denen der S8-Dispatch andere
//! Slices anspricht. Jeder Trait nennt die TypeScript-Aufrufstelle, aus der seine
//! Methoden abgeleitet sind. Zielslice je Trait steht am Trait.
//!
//! Konvention: Methoden mit Futures erhalten nur `&self` als Referenz plus besessene
//! Argumente, damit die Lebensdauer eindeutig bleibt. Abhaengigkeiten, die in Futures
//! wandern, sind `Arc<dyn Trait>`.

use super::approval::handler::{ApprovalOutcome, ApprovalParams};
use super::conversation::ports::MessageRepositoryPort;
use super::execution::build_execution::PreflightResult;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};
use crate::model_hub::openai_compatible::StreamDeltaCallback;
use crate::model_hub::service::types::DispatchWithFallbackOptions;
use crate::model_hub::types::{GatewayMessage, GatewayRequest, GatewayResponse};
use crate::personas::types::PersonaProfile;

use super::execution::ports::PortResult;
use super::tool_manager::ToolManager;

/// Boxed future used by async ports. Borrows `&self` for `'a`.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ─── Records ────────────────────────────────────────────────────────────────

/// Argument of `createConversation` (`routeCommandStage.ts:47-52`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewConversation {
    pub channel_type: ChannelType,
    pub external_chat_id: Option<String>,
    pub title: Option<String>,
    pub user_id: Option<String>,
}

/// `getConversationContext` result, `summaryText` / `summaryUptoSeq`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationContext {
    pub summary_text: String,
    pub summary_upto_seq: i64,
}

/// `PersonaProjectRecord` fields that the S8 flow reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub workspace_path: String,
    pub workspace_relative_path: Option<String>,
}

/// `getConversationProjectState` result.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProjectState {
    pub active_project_id: Option<String>,
    pub guard_approved_without_project: bool,
}

/// Argument of `createProject` (`projectManagement.ts:137-143`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewProject {
    pub user_id: String,
    pub persona_id: String,
    pub name: String,
    pub workspace_path: String,
    pub workspace_relative_path: Option<String>,
}

/// `createPersonaProjectWorkspace` result (`projectManagement.ts:131-135`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePaths {
    pub absolute_path: String,
    pub relative_path: String,
}

/// Options of `appendUserMessage` (`inbound/stages/createInboundContextStage.ts:49-54`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UserMessageOptions {
    pub external_msg_id: Option<String>,
    pub sender_name: Option<String>,
    pub client_message_id: Option<String>,
    pub metadata: Option<Value>,
}

/// `StrictRecallReply` of `buildStrictEvidenceReply` (`prepareDispatchStage.ts:115-127`).
#[derive(Debug, Clone, PartialEq)]
pub struct StrictRecallReply {
    pub content: String,
    pub metadata: Option<Value>,
}

/// `getWorldModelConfig()` fields plus `isWorldModelRequired(mode)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorldModelFlags {
    pub enabled: bool,
    pub e2e_enabled: bool,
    pub required: bool,
}

/// Argument of `recordObservation` (`handleInbound.ts:111-135`). `source_type` is
/// always `chat_message` and `source_authority` is always `user` on this path.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordObservationInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub source_type: &'static str,
    pub source_id: String,
    pub occurred_at: String,
    pub payload: Value,
    pub source_authority: &'static str,
}

/// Argument of `correlateInboundResponse` (`handleInbound.ts:141-148`).
#[derive(Debug, Clone, PartialEq)]
pub struct CorrelateInput {
    pub conversation: Conversation,
    pub text: String,
    pub received_at: String,
    pub observation_id: Option<String>,
    pub source_id: String,
}

/// `chat.summary.refreshed` payload (`summaryService.ts:114-122`).
#[derive(Debug, Clone, PartialEq)]
pub struct SummaryRefreshedEvent {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: Option<String>,
    pub summary_text: String,
    pub summary_upto_seq: i64,
    pub messages: Vec<StoredMessage>,
    pub created_at: String,
}

/// Targets of `messageRouter.ts`, which the command stage matches on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteTarget {
    SessionCommand,
    AutomationCommand,
    PersonaCommand,
    ProjectCommand,
    ApprovalCommand,
    ShellCommand,
    SubagentCommand,
    /// Every other target: the message continues into the model dispatch.
    None,
}

/// `RouteResult` of `messageRouter.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteResult {
    pub target: RouteTarget,
    pub payload: Option<String>,
    pub command: Option<String>,
}

/// Command handlers that `routeCommandStage` dispatches to (`commands/index.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Automation,
    Persona,
    Project,
    Approval,
    Shell,
    Subagent,
}

/// Input of one command handler. Owned, so the returned future owns it.
#[derive(Clone)]
pub struct CommandInput {
    pub conversation: Conversation,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub payload: Option<String>,
    pub command: Option<String>,
    pub send: Arc<dyn SendResponse>,
    pub repo: Arc<dyn MessageRepositoryPort>,
    pub approvals: Arc<dyn ApprovalResponder>,
}

/// Argument of `resolveMaxToolCalls` (`execution/buildExecution.ts`, used at
/// `dispatchModelStage.ts:105-110`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaxToolCallsInput {
    pub is_autonomous_persona: bool,
    pub persona_max_tool_calls: Option<i64>,
    pub build_intent: bool,
    pub override_max_tool_calls: Option<i64>,
}

/// Argument of `handleMemorySave` (`prepareDispatchStage.ts:62-71`).
#[derive(Debug, Clone, PartialEq)]
pub struct MemorySaveInput {
    pub conversation: Conversation,
    pub content: String,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub memory_enabled: bool,
}

/// Argument of `handleInferredShellQuestion` (`prepareDispatchStage.ts:94-111`).
#[derive(Clone)]
pub struct ShellInferenceInput {
    pub conversation: Conversation,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub user_input: String,
    pub command: String,
    pub on_stream_delta: Option<StreamDeltaCallback>,
}

/// Context of `dispatchSkill` (`toolManager.ts:271-280`).
#[derive(Clone)]
pub struct SkillDispatchContext {
    pub bypass_approval: bool,
    pub workspace_cwd: Option<String>,
    pub conversation_id: String,
    pub user_id: String,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub subagent_invoker: Option<Arc<dyn SubagentToolInvoker>>,
}

/// One installed skill row (`skillRepository.listSkills()`), the fields S8 reads.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub installed: bool,
    pub version: String,
    pub function_name: String,
    pub source: String,
    pub source_url: Option<String>,
    pub tool_definition: Value,
}

/// Result of `evaluateNodeCommandPolicy` (`gateway/node-command-policy`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandPolicy {
    pub allowed: bool,
    pub normalized_command: String,
    pub reason: Option<String>,
}

/// Argument of `invokeSubagentToolCall` (`skills/types.ts` `SubagentToolCallParams`).
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentToolCallParams {
    pub args: Value,
    pub conversation_id: String,
    pub user_id: String,
    pub platform: ChannelType,
    pub external_chat_id: String,
}

/// One candidate of `buildAutoMemoryCandidates` (`autoMemory.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct AutoMemoryCandidate {
    pub memory_type: String,
    pub content: String,
    pub importance: f64,
}

/// Argument of `memoryService.storeMemory` (`summaryService.ts:209-225`). `metadata`
/// carries `subject`, `sourceRole`, `sourceType` and `idempotencyKey`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreMemoryInput {
    pub persona_id: String,
    pub memory_type: String,
    pub content: String,
    pub importance: f64,
    pub user_id: String,
    pub metadata: Value,
}

/// `resolveKnowledgeConfig()` fields read by `summaryService.ts:335-338`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnowledgeLayerFlags {
    pub layer_enabled: bool,
    pub episode_enabled: bool,
    pub ledger_enabled: bool,
}

/// Argument of `ingestConversationWindow` (`summaryService.ts:342-351`).
#[derive(Debug, Clone, PartialEq)]
pub struct ConversationWindowInput {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub messages: Vec<StoredMessage>,
    pub summary_text: String,
}

// ─── Ports ──────────────────────────────────────────────────────────────────

/// Session, history and context managers (`historyManager.ts`, `contextBuilder.ts`). Repository
/// calls live in [`MessageRepositoryPort`] and session resolution in `SessionPort`. Target: `messages_store`.
pub trait ChatStore: Send + Sync {
    /// `historyManager.appendUserMessage` (`createInboundContextStage.ts:49-54`).
    fn append_user_message(
        &self,
        conversation_id: &str,
        platform: ChannelType,
        content: &str,
        options: UserMessageOptions,
    ) -> PortResult<StoredMessage>;
    /// `historyManager.appendAgentMessage` (`responseHelper.ts:49-54`).
    fn append_agent_message(
        &self,
        conversation_id: &str,
        platform: ChannelType,
        content: &str,
        metadata: Option<Value>,
    ) -> PortResult<StoredMessage>;
    /// `historyManager.listRecentMessages` (`approvalCommand.ts`, `commands/types.ts`).
    fn list_recent_messages(
        &self,
        conversation_id: &str,
        user_id: &str,
        limit: usize,
    ) -> PortResult<Vec<StoredMessage>>;
    /// `contextBuilder.buildGatewayMessages` (`ai/prepareDispatchMessages.ts:95-100`).
    fn build_gateway_messages(
        &self,
        conversation_id: &str,
        user_id: &str,
        limit: usize,
        persona_id: Option<&str>,
    ) -> PortResult<Vec<GatewayMessage>>;
    /// `applyChannelBindingPersona(repo, conversation, platform)`
    /// (`createInboundContextStage.ts:67`).
    fn apply_channel_binding_persona(
        &self,
        conversation: &Conversation,
        platform: ChannelType,
    ) -> PortResult<Conversation>;
}

/// Side effects of a persisted message: event bus, websocket broadcast, inbox
/// update, world-model bridge, outbound delivery. Target: gateway, events, inbox,
/// world-model and channel adapters (other slices).
pub trait ChatEvents: Send + Sync {
    /// `getServerEventBus().publish('chat.message.persisted', ...)`.
    fn message_persisted(&self, conversation: &Conversation, message: &StoredMessage);
    /// `broadcastToUser(userId, GatewayEvents.CHAT_MESSAGE, message)`.
    fn broadcast_chat_message(&self, user_id: &str, message: &StoredMessage);
    /// `buildInboxItemFromConversation(conversation, message)`.
    fn build_inbox_item(&self, conversation: &Conversation, message: &StoredMessage) -> Value;
    /// `emitInboxUpdated({ userId, action, conversationId, item })`.
    fn emit_inbox_updated(&self, user_id: &str, action: &str, conversation_id: &str, item: Value);
    /// `emitInboxUpdated({ action: 'upsert', item: buildInboxItemFromConversation(...) })`.
    fn inbox_upserted(&self, conversation: &Conversation, message: &StoredMessage) {
        let item = self.build_inbox_item(conversation, message);
        self.emit_inbox_updated(&conversation.user_id, "upsert", &conversation.id, item);
    }
    /// `bridgeStoredChatMessage({ conversation, message })`.
    fn bridge_stored_message(
        &self,
        conversation: Conversation,
        message: StoredMessage,
    ) -> BoxFuture<'_, PortResult<()>>;
    /// `deliverOutbound(platform, externalChatId, content, { personaId })`.
    fn deliver_outbound(
        &self,
        platform: ChannelType,
        external_chat_id: String,
        content: String,
        persona_id: Option<String>,
    ) -> BoxFuture<'_, PortResult<()>>;
    /// `getServerEventBus().publish('chat.summary.refreshed', ...)`.
    fn summary_refreshed(&self, event: SummaryRefreshedEvent);
}

/// Persona catalogue and project workspace folders. Target: `personas` (S2, in Rust).
/// The single persona port of the S8 flow: the persona command, the project command and
/// project management all read through it. The record form is the TS `PersonaProfile`.
pub trait PersonaPort: Send + Sync {
    /// `getPersonaRepository().listPersonas(userId)`. TS lists `PersonaSummary`, a subset of
    /// `PersonaProfile`; the port uses the profile so there is one record form.
    fn list_personas(&self, user_id: &str) -> PortResult<Vec<PersonaProfile>>;
    /// `getPersonaRepository().getPersona(id)`.
    fn get_persona(&self, id: &str) -> PortResult<Option<PersonaProfile>>;
    /// `createPersonaProjectWorkspace({ personaSlug, task, requestedName })`.
    fn create_project_workspace(
        &self,
        persona_slug: &str,
        task: &str,
        requested_name: &str,
    ) -> PortResult<WorkspacePaths>;
    /// `removePersonaProjectWorkspace({ personaSlug, workspacePath })`.
    fn remove_project_workspace(&self, persona_slug: &str, workspace_path: &str) -> PortResult<()>;
    /// `getPersonaRepository().getPersona(id)` reduced to `memoryPersonaType`, which the
    /// approval path reads. `None` when the persona is missing or has no such type.
    fn memory_persona_type(&self, persona_id: &str) -> PortResult<Option<String>>;
}

/// World-model hooks of `handleInbound.ts`. Target: `world_model` (S6).
pub trait WorldModelPort: Send + Sync {
    /// `getWorldModelConfig()` together with `isWorldModelRequired(mode)`.
    fn flags(&self) -> WorldModelFlags;
    /// `looksLikeResponse(content)`.
    fn looks_like_response(&self, content: &str) -> bool;
    /// `recordObservation(input, scope)`; returns the observation id.
    fn record_observation(
        &self,
        input: RecordObservationInput,
    ) -> BoxFuture<'_, PortResult<String>>;
    /// `correlateInboundResponse(...)`.
    fn correlate_inbound_response(&self, input: CorrelateInput) -> BoxFuture<'_, PortResult<()>>;
}

/// Recall service (`recall/index.ts`). Target: Agent A, `recall/`.
pub trait RecallPort: Send + Sync {
    /// `buildRecallContext(conversation, userInput)` (`ai/prepareDispatchMessages.ts:105`).
    fn build_recall_context(
        &self,
        conversation: Conversation,
        user_input: String,
    ) -> BoxFuture<'_, PortResult<Option<String>>>;
    /// `maybeLearnFromFeedback(conversation, content)`. Fire-and-forget in TypeScript.
    fn maybe_learn_from_feedback(&self, conversation: Conversation, content: String);
    /// `RecallService.clearConversationState` (`maintenance/operations.ts`).
    fn clear_conversation_state(&self, conversation_id: &str);
    /// `buildStrictEvidenceReply(conversation, userInput)` (`prepareDispatchStage.ts:115`).
    fn build_strict_evidence_reply(
        &self,
        conversation: Conversation,
        user_input: String,
    ) -> BoxFuture<'_, PortResult<Option<StrictRecallReply>>>;
}

/// Command handlers (`commands/*`) and the message router (`messageRouter.ts`).
/// Target: Agent D, `commands/`.
pub trait CommandPort: Send + Sync {
    /// `routeMessage(content)` (`inbound/stages/createInboundContextStage.ts:79`).
    fn route_message(&self, content: &str) -> RouteResult;
    /// Runs one `handle*Command` (`routeCommandStage.ts:62-177`).
    fn handle_command(
        &self,
        kind: CommandKind,
        input: CommandInput,
    ) -> BoxFuture<'_, PortResult<StoredMessage>>;
}

/// `respondToolApproval(params)` (`messageService.ts:406-418`). The single approval port: the
/// command handler and the inbound pipeline both use it. The implementation is the handler in
/// `approval::handler`.
pub trait ApprovalResponder: Send + Sync {
    fn respond_tool_approval(
        &self,
        params: ApprovalParams,
    ) -> BoxFuture<'_, PortResult<ApprovalOutcome>>;
}

/// Memory save and inferred shell question (`handlers/*`, Agent A/B).
pub trait HandlersPort: Send + Sync {
    /// `handleMemorySave(input, sendResponse)`: `Some(message)` ends the turn.
    fn handle_memory_save(
        &self,
        input: MemorySaveInput,
        send: Arc<dyn SendResponse>,
    ) -> BoxFuture<'_, PortResult<Option<StoredMessage>>>;
    /// `handleInferredShellQuestion(deps, sendResponse, input)`.
    fn handle_inferred_shell_question(
        &self,
        input: ShellInferenceInput,
        send: Arc<dyn SendResponse>,
    ) -> BoxFuture<'_, PortResult<StoredMessage>>;
}

/// Execution helpers (`execution/buildExecution.ts`, Agent B).
pub trait ExecutionPort: Send + Sync {
    /// `buildAutonomousExecutionDirective({ workspaceCwd, buildIntent, isAutonomousPersona })`.
    fn autonomous_execution_directive(
        &self,
        workspace_cwd: Option<String>,
        build_intent: bool,
        is_autonomous_persona: bool,
    ) -> Option<String>;
    /// `resolveMaxToolCalls({...})`.
    fn resolve_max_tool_calls(&self, input: MaxToolCallsInput) -> i64;
    /// `runBuildWorkspacePreflight({...})`.
    fn run_build_workspace_preflight(
        &self,
        conversation: Conversation,
        platform: ChannelType,
        external_chat_id: String,
        workspace_cwd: String,
        tools: Arc<ToolManager>,
        send: Arc<dyn SendResponse>,
    ) -> BoxFuture<'_, PortResult<PreflightResult>>;
}

/// Subagent orchestration (`orchestration/subagentToolApproval.ts`, Agent B).
pub trait SubagentToolInvoker: Send + Sync {
    /// `invokeSubagentToolCallOperation(...)`, also the callback that
    /// `ToolManager` hands to `dispatchSkill` (`messageService.ts:81-84`).
    fn invoke(&self, params: SubagentToolCallParams) -> BoxFuture<'_, PortResult<Value>>;
}

/// `sendResponse(conversation, content, platform, externalChatId, metadata?)`: the reply
/// sender that every flow uses (`utils/responseHelper.ts`). Implemented by
/// [`crate::channels::messages::service::utils::response_helper::ResponseHelper`].
pub trait SendResponse: Send + Sync {
    fn send_response<'a>(
        &'a self,
        conversation: &'a Conversation,
        content: &'a str,
        platform: ChannelType,
        external_chat_id: &'a str,
        metadata: Option<Map<String, Value>>,
    ) -> BoxFuture<'a, PortResult<StoredMessage>>;
}

/// Model gateway (`model-hub/runtime.ts`), Agent-independent since S4 (`model_hub`).
pub trait ModelGateway: Send + Sync {
    /// `getModelHubEncryptionKey()`.
    fn encryption_key(&self) -> PortResult<String>;
    /// `getModelHubService().dispatchWithFallback(profileId, key, request, options)`.
    fn dispatch_with_fallback(
        &self,
        profile_id: String,
        encryption_key: String,
        request: GatewayRequest,
        options: DispatchWithFallbackOptions,
    ) -> BoxFuture<'_, PortResult<GatewayResponse>>;
}

/// Skill registry and dispatch seam (`skillRepository`, `executeSkill`,
/// `pythonExecute`, `playwrightCliCommand`, `skills/definitions`, exec approvals,
/// node command policy). Target: Agent B (`execution/`) and S11 (skills).
pub trait ToolBackend: Send + Sync {
    /// `getSkillRepository().listSkills()` (`toolManager.ts:120-122`).
    fn list_skills(&self) -> BoxFuture<'_, PortResult<Vec<SkillRow>>>;
    /// `mapSkillsToTools(installedSkills, 'openai')`.
    fn map_skills_to_tools(&self, installed: &[SkillRow]) -> Vec<Value>;
    /// `evaluateNodeCommandPolicy(command)`.
    fn evaluate_command_policy(&self, command: &str) -> CommandPolicy;
    /// `isCommandApproved(normalizedCommand)`.
    fn is_command_approved(&self, normalized_command: &str) -> bool;
    /// `approveCommand(command)`.
    fn approve_command(&self, command: &str);
    /// `buildPythonCommand(code)`.
    fn build_python_command(&self, code: &str) -> String;
    /// `resolvePlaywrightCliTokens(args)` followed by `assertPlaywrightSubcommandAllowed`.
    fn resolve_playwright_tokens(&self, args: &Value) -> PortResult<Vec<String>>;
    /// `buildPlaywrightCliCommand(tokens)`.
    fn build_playwright_cli_command(&self, tokens: &[String]) -> String;
    /// `normalizeSkillArgs(args)` (`executeSkill.ts`, applied at `toolManager.ts:271`).
    fn normalize_skill_args(&self, args: &Value) -> Value;
    /// `dispatchSkill(functionName, args, options)`.
    fn dispatch_skill(
        &self,
        function_name: String,
        args: Value,
        context: SkillDispatchContext,
    ) -> BoxFuture<'_, PortResult<Value>>;
}

/// Summary, auto session memory and knowledge ingestion (`summary.ts`,
/// `autoMemory.ts`, `memory/runtime.ts`, `knowledge/*`). Targets: S5, S7 and
/// `channels/messages` (other slices).
pub trait SummaryPort: Send + Sync {
    /// `isAiSummaryEnabled()`.
    fn is_ai_summary_enabled(&self) -> bool;
    /// `buildFallbackSummary(previousSummary, messages)`.
    fn build_fallback_summary(&self, previous: &str, messages: &[(String, String)]) -> String;
    /// `isAutoSessionMemoryEnabled()`.
    fn is_auto_session_memory_enabled(&self) -> bool;
    /// `getAutoSessionMemoryMode()`.
    fn auto_session_memory_mode(&self) -> String;
    /// `buildAutoMemoryCandidates(messages)`.
    fn build_auto_memory_candidates(&self, messages: &[StoredMessage]) -> Vec<AutoMemoryCandidate>;
    /// `resolveMemoryScopedUserId({ userId, channelType, externalChatId })`.
    fn resolve_memory_user_id(&self, conversation: &Conversation) -> String;
    /// `memoryService.storeMemory(...)`, raced against a timeout by the caller.
    fn store_memory(&self, input: StoreMemoryInput) -> BoxFuture<'_, PortResult<()>>;
    /// `isInlineKnowledgeIngestionEnabled()`.
    fn is_inline_knowledge_ingestion_enabled(&self) -> bool;
    /// `resolveKnowledgeConfig()` flags.
    fn knowledge_layer_flags(&self) -> KnowledgeLayerFlags;
    /// `getKnowledgeIngestionService().ingestConversationWindow(...)`.
    fn ingest_conversation_window(
        &self,
        input: ConversationWindowInput,
    ) -> BoxFuture<'_, PortResult<()>>;
    /// `logAutoSessionMemoryTrace(name, fields)`. Log-only.
    fn trace_auto_session_memory(&self, name: &str, fields: Value);
    /// `SummaryService.clearInFlight` (`maintenance/operations.ts`): drops the cache entry.
    fn clear_in_flight(&self, conversation_id: &str);
    /// `maybeRefreshConversationSummary(...)`, which the TS callers start without awaiting.
    fn schedule_summary_refresh(&self, conversation: Conversation);
}
