//! Port of `src/server/channels/messages/service/commands/types.ts` (S8).
//!
//! The shapes that `service/types.ts` owns (`ToolExecutionResult`, `PendingToolApproval`,
//! `ResolvedToolContext`, `SubagentDispatchContext`, `SubagentAction`,
//! `extractMemorySaveContent`) are imported from [`crate::channels::messages::service::types`].
//! The subagent records (`ParsedSubagentAction`, `ActionResult`) come from
//! [`crate::channels::messages::service::subagent::types`]. The tool manager port and its
//! call argument (`ToolCallRequest`) come from `execution::ports` and `tool_manager`.

use crate::channels::messages::service::ports::{ChatStore, SendResponse};
use serde_json::{Map, Value};

use crate::channels::messages::service::execution::ports::{PortError, ToolManagerPort};
use crate::channels::messages::service::subagent::types::{
    ActionResult, ParsedSubagentAction, SubagentManagerDeps,
};
use crate::channels::messages::service::types::SubagentAction;
use crate::channels::messages::service::types::SubagentDispatchContext;
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};
use crate::model_hub::http::BoxFuture;

/// Builds a JSON object from literal entries, for the `metadata` arguments of the TS handlers.
pub fn json_map<const N: usize>(entries: [(&str, Value); N]) -> Map<String, Value> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

/// `SubagentManager` as the command handler uses it. The start and run callbacks of the TS
/// `CommandHandlerDeps` are [`SubagentManagerDeps`], the same port the executor uses.
pub trait SubagentManagerPort: Send + Sync {
    fn parse_subagent_action(&self, payload: &str, command: Option<&str>) -> ParsedSubagentAction;

    fn execute_subagent_action<'a>(
        &'a self,
        context: &'a SubagentDispatchContext,
        action: SubagentAction,
        args: &'a [String],
        host: &'a dyn SubagentManagerDeps,
    ) -> BoxFuture<'a, Result<ActionResult, PortError>>;
}

/// `CommandHandlerDeps` from `types.ts:7-34`. `resolve_workspace_cwd` is optional in TS and
/// defaults to `None` here. `history()` is the TS `historyManager`, which is [`ChatStore`].
pub trait CommandHandlerDeps: SendResponse + SubagentManagerDeps {
    fn subagent_manager(&self) -> &dyn SubagentManagerPort;

    fn tool_manager(&self) -> &dyn ToolManagerPort;

    fn history(&self) -> &dyn ChatStore;

    fn resolve_workspace_cwd(&self, _conversation: &Conversation) -> Option<String> {
        None
    }
}

/// Sends a plain text reply through the response sender of the chat.
pub async fn reply(
    sender: &dyn SendResponse,
    conversation: &Conversation,
    content: &str,
    platform: ChannelType,
    external_chat_id: &str,
) -> Result<StoredMessage, PortError> {
    sender
        .send_response(conversation, content, platform, external_chat_id, None)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::tool_manager::ToolCallRequest;
    use crate::channels::messages::service::types::{
        PendingToolApproval, ResolvedToolContext, ToolExecutionResult,
    };

    #[test]
    fn approval_metadata_lets_the_fixed_keys_win() {
        struct Tools;
        impl ToolManagerPort for Tools {
            fn prune_pending_tool_approvals(&self) {}

            fn get_pending_approval(&self, _token: &str) -> Option<PendingToolApproval> {
                None
            }

            fn delete_pending_approval(&self, _token: &str) -> bool {
                false
            }

            fn approve_command<'a>(
                &'a self,
                _command: &'a str,
            ) -> BoxFuture<'a, Result<(), PortError>> {
                Box::pin(std::future::ready(Ok(())))
            }

            fn resolve_tool_context(
                &self,
            ) -> BoxFuture<'_, Result<ResolvedToolContext, PortError>> {
                Box::pin(std::future::ready(Ok(ResolvedToolContext::default())))
            }

            fn execute_tool_function_call(
                &self,
                _request: ToolCallRequest,
            ) -> BoxFuture<'_, Result<ToolExecutionResult, PortError>> {
                Box::pin(std::future::ready(Err(PortError::Failed(
                    "unused".to_string(),
                ))))
            }
        }
        let pending = PendingToolApproval {
            token: "tok-1".to_string(),
            user_id: "user-1".to_string(),
            conversation_id: "c1".to_string(),
            platform: ChannelType::WebChat,
            external_chat_id: "chat".to_string(),
            tool_function_name: "shell_execute".to_string(),
            tool_id: None,
            args: Map::new(),
            command: None,
            created_at_ms: 0,
        };
        let extra = json_map([
            ("status", Value::from("ignored")),
            ("ok", Value::Bool(false)),
        ]);

        let metadata = Tools.build_approval_metadata(&pending, "Freigeben?", extra);

        assert_eq!(metadata["status"], "approval_required");
        assert_eq!(metadata["approval_token"], "tok-1");
        assert_eq!(metadata["approvalToolId"], Value::Null);
        assert_eq!(metadata["approvalToolFunction"], "shell_execute");
        assert_eq!(metadata["ok"], false);
    }
}
