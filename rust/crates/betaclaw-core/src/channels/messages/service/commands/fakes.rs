//! Test doubles for the command handlers (test builds only).

use std::collections::VecDeque;
use std::future::ready;
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::channels::messages::service::commands::types::{
    CommandHandlerDeps, SubagentManagerPort,
};
use crate::channels::messages::service::execution::ports::{
    PortError, PortResult, ToolManagerPort,
};
use crate::channels::messages::service::ports::{ChatStore, SendResponse, UserMessageOptions};
use crate::channels::messages::service::subagent::registry::SubagentRunRecord;
use crate::channels::messages::service::subagent::types::{
    ActionResult, ParsedSubagentAction, RunSubagentParams, StartSubagentRunParams,
    SubagentManagerDeps,
};
use crate::channels::messages::service::tool_manager::ToolCallRequest;
use crate::channels::messages::service::types::{
    PendingToolApproval, ResolvedToolContext, SubagentAction, SubagentDispatchContext,
    ToolExecutionResult,
};
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};
use crate::model_hub::http::BoxFuture;
use crate::model_hub::types::GatewayMessage;
use crate::personas::types::{MemoryPersonaType, PersonaProfile};

/// A persona profile with the given identity and default settings.
pub fn persona_profile(
    id: &str,
    name: &str,
    slug: &str,
    emoji: &str,
    vibe: &str,
) -> PersonaProfile {
    PersonaProfile {
        id: id.to_string(),
        name: name.to_string(),
        slug: slug.to_string(),
        emoji: emoji.to_string(),
        vibe: vibe.to_string(),
        system_persona_key: None,
        preferred_model_id: None,
        model_hub_profile_id: None,
        memory_persona_type: MemoryPersonaType::General,
        is_autonomous: false,
        max_tool_calls: 120,
        allowed_tool_function_names: Vec::new(),
        user_id: "user-1".to_string(),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

/// One message handed to `send_response`.
#[derive(Debug, Clone, PartialEq)]
pub struct SentMessage {
    pub content: String,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub metadata: Option<Map<String, Value>>,
}

/// Records every reply and returns it as a stored message with id `sent-<n>`.
#[derive(Default)]
pub struct RecordingSender {
    pub sent: Mutex<Vec<SentMessage>>,
}

impl RecordingSender {
    pub fn contents(&self) -> Vec<String> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|message| message.content.clone())
            .collect()
    }

    pub fn last(&self) -> SentMessage {
        self.sent
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("a reply was sent")
    }
}

impl SendResponse for RecordingSender {
    fn send_response<'a>(
        &'a self,
        conversation: &'a Conversation,
        content: &'a str,
        platform: ChannelType,
        external_chat_id: &'a str,
        metadata: Option<Map<String, Value>>,
    ) -> BoxFuture<'a, Result<StoredMessage, PortError>> {
        let mut sent = self.sent.lock().unwrap();
        sent.push(SentMessage {
            content: content.to_string(),
            platform,
            external_chat_id: external_chat_id.to_string(),
            metadata,
        });
        let id = format!("sent-{}", sent.len());
        let message = crate::channels::messages::service::conversation::fakes::stored_message(
            &id,
            &conversation.id,
            "agent",
            content,
        );
        Box::pin(ready(Ok(message)))
    }
}

/// Returns the queued snapshots call by call; once empty, calls return no messages.
#[derive(Default)]
pub struct FakeHistory {
    pub snapshots: Mutex<VecDeque<Vec<StoredMessage>>>,
}

/// Only `list_recent_messages` is reached by the command tests; the other [`ChatStore`] methods
/// belong to the inbound pipeline and are not called here.
impl ChatStore for FakeHistory {
    fn append_user_message(
        &self,
        _conversation_id: &str,
        _platform: ChannelType,
        _content: &str,
        _options: UserMessageOptions,
    ) -> PortResult<StoredMessage> {
        unreachable!("not used by the command tests")
    }

    fn append_agent_message(
        &self,
        _conversation_id: &str,
        _platform: ChannelType,
        _content: &str,
        _metadata: Option<Value>,
    ) -> PortResult<StoredMessage> {
        unreachable!("not used by the command tests")
    }

    fn build_gateway_messages(
        &self,
        _conversation_id: &str,
        _user_id: &str,
        _limit: usize,
        _persona_id: Option<&str>,
    ) -> PortResult<Vec<GatewayMessage>> {
        unreachable!("not used by the command tests")
    }

    fn apply_channel_binding_persona(
        &self,
        _conversation: &Conversation,
        _platform: ChannelType,
    ) -> PortResult<Conversation> {
        unreachable!("not used by the command tests")
    }

    fn list_recent_messages(
        &self,
        _conversation_id: &str,
        _user_id: &str,
        _limit: usize,
    ) -> PortResult<Vec<StoredMessage>> {
        Ok(self
            .snapshots
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_default())
    }
}

/// Stand-in for a manager a test does not exercise. Every call fails.
pub struct UnusedTools;

impl ToolManagerPort for UnusedTools {
    fn prune_pending_tool_approvals(&self) {}

    fn get_pending_approval(&self, _token: &str) -> Option<PendingToolApproval> {
        None
    }

    fn delete_pending_approval(&self, _token: &str) -> bool {
        false
    }

    fn approve_command<'a>(&'a self, _command: &'a str) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(ready(Err(PortError::Failed("tools not faked".to_string()))))
    }

    fn resolve_tool_context(&self) -> BoxFuture<'_, Result<ResolvedToolContext, PortError>> {
        Box::pin(ready(Err(PortError::Failed("tools not faked".to_string()))))
    }

    fn execute_tool_function_call(
        &self,
        _call: ToolCallRequest,
    ) -> BoxFuture<'_, Result<ToolExecutionResult, PortError>> {
        Box::pin(ready(Err(PortError::Failed("tools not faked".to_string()))))
    }
}

/// Stand-in for the subagent manager. Every execution fails.
pub struct UnusedSubagents;

impl SubagentManagerPort for UnusedSubagents {
    fn parse_subagent_action(
        &self,
        _payload: &str,
        _command: Option<&str>,
    ) -> ParsedSubagentAction {
        ParsedSubagentAction {
            action: SubagentAction::Help,
            args: Vec::new(),
        }
    }

    fn execute_subagent_action<'a>(
        &'a self,
        _context: &'a SubagentDispatchContext,
        _action: SubagentAction,
        _args: &'a [String],
        _host: &'a dyn SubagentManagerDeps,
    ) -> BoxFuture<'a, Result<ActionResult, PortError>> {
        Box::pin(ready(Err(PortError::Failed(
            "subagents not faked".to_string(),
        ))))
    }
}

/// `CommandHandlerDeps` double. Replace `tools` or `subagents` in a test that needs them.
pub struct FakeDeps {
    pub sender: RecordingSender,
    pub history: FakeHistory,
    pub tools: Box<dyn ToolManagerPort>,
    pub subagents: Box<dyn SubagentManagerPort>,
    pub workspace_cwd: Option<String>,
}

impl Default for FakeDeps {
    fn default() -> Self {
        Self {
            sender: RecordingSender::default(),
            history: FakeHistory::default(),
            tools: Box::new(UnusedTools),
            subagents: Box::new(UnusedSubagents),
            workspace_cwd: None,
        }
    }
}

impl SendResponse for FakeDeps {
    fn send_response<'a>(
        &'a self,
        conversation: &'a Conversation,
        content: &'a str,
        platform: ChannelType,
        external_chat_id: &'a str,
        metadata: Option<Map<String, Value>>,
    ) -> BoxFuture<'a, Result<StoredMessage, PortError>> {
        self.sender
            .send_response(conversation, content, platform, external_chat_id, metadata)
    }
}

impl SubagentManagerDeps for FakeDeps {
    fn start_subagent_run(&self, _params: StartSubagentRunParams) -> PortResult<SubagentRunRecord> {
        Err(PortError::Failed("start not faked".to_string()))
    }

    fn run_subagent(&self, _params: RunSubagentParams) {}
}

impl CommandHandlerDeps for FakeDeps {
    fn subagent_manager(&self) -> &dyn SubagentManagerPort {
        self.subagents.as_ref()
    }

    fn tool_manager(&self) -> &dyn ToolManagerPort {
        self.tools.as_ref()
    }

    fn history(&self) -> &dyn ChatStore {
        &self.history
    }

    fn resolve_workspace_cwd(&self, _conversation: &Conversation) -> Option<String> {
        self.workspace_cwd.clone()
    }
}
