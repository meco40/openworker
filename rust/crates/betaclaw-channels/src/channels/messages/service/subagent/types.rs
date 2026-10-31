//! Port of `src/server/channels/messages/service/subagent/types.ts`. `SubagentAction` and
//! `SubagentDispatchContext` belong to `service/types.ts` and are imported from there.

use serde_json::{Map, Value};

use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::types::SubagentAction;
use crate::messages_store::types::{ChannelType, Conversation};

use super::registry::SubagentRunRecord;

/// `ParsedSubagentAction` from `subagent/types.ts:31-34`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSubagentAction {
    pub action: SubagentAction,
    pub args: Vec<String>,
}

/// `SpawnInputResult` from `subagent/types.ts:36-41`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SpawnInputResult {
    pub agent_id: String,
    pub task: String,
    pub model_override: Option<String>,
    pub error: Option<String>,
}

/// `SubagentTargetResult` from `subagent/types.ts:43-46`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SubagentTargetResult {
    pub run: Option<SubagentRunRecord>,
    pub error: Option<String>,
}

/// `ActionResult` from `subagent/types.ts:48-51`. Every action sets a payload.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionResult {
    pub text: String,
    pub payload: Map<String, Value>,
}

/// `startSubagentRun` params, `subagent/types.ts:6-20` and `lifecycle/start.ts:7-15`.
#[derive(Debug, Clone, PartialEq)]
pub struct StartSubagentRunParams {
    pub conversation: Conversation,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub agent_id: String,
    pub task: String,
    pub guidance: Option<String>,
    pub model_override: Option<String>,
}

/// `runSubagent({ conversation, platform, externalChatId, run })`, `subagent/types.ts:21-29`.
#[derive(Debug, Clone, PartialEq)]
pub struct RunSubagentParams {
    pub conversation: Conversation,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub run: SubagentRunRecord,
}

/// `SubagentManagerDeps` from `subagent/types.ts:6-29`, without the `sendResponse`
/// member: `executeSubagentAction` never calls it.
pub trait SubagentManagerDeps: Send + Sync {
    fn start_subagent_run(&self, params: StartSubagentRunParams) -> PortResult<SubagentRunRecord>;
    /// `void deps.runSubagent(...)`: the implementation starts the run in the
    /// background and does not report its result to the caller.
    fn run_subagent(&self, params: RunSubagentParams);
}
