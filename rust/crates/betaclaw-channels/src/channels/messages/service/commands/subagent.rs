//! Port of `src/server/channels/messages/service/commands/subagentCommand.ts` (S8).
//!
//! Parses the subagent action, runs it through [`SubagentManagerPort`] and replies. The subagent
//! manager receives the handler's run callbacks as [`SubagentManagerDeps`].

use serde_json::Value;

use crate::channels::messages::service::commands::types::{json_map, CommandHandlerDeps};
use crate::channels::messages::service::execution::ports::PortError;
use crate::channels::messages::service::subagent::types::SubagentManagerDeps;
use crate::channels::messages::service::types::SubagentDispatchContext;
use crate::messages_store::types::StoredMessage;

pub async fn handle_subagent_command(
    context: &SubagentDispatchContext,
    payload: &str,
    command: Option<&str>,
    deps: &dyn CommandHandlerDeps,
) -> Result<StoredMessage, PortError> {
    let parsed = deps
        .subagent_manager()
        .parse_subagent_action(payload, command);
    let host: &dyn SubagentManagerDeps = deps;
    let result = deps
        .subagent_manager()
        .execute_subagent_action(context, parsed.action, &parsed.args, host)
        .await?;

    // The result payload is spread after `runtime` and `action`, so it wins on conflicts.
    let mut metadata = json_map([
        ("runtime", Value::from("subagents-command")),
        ("action", Value::from(parsed.action.as_str())),
    ]);
    metadata.extend(result.payload);

    deps.send_response(
        &context.conversation,
        &result.text,
        context.platform,
        &context.external_chat_id,
        Some(metadata),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::commands::fakes::FakeDeps;
    use crate::channels::messages::service::commands::types::SubagentManagerPort;
    use crate::channels::messages::service::conversation::fakes::conversation;
    use crate::channels::messages::service::subagent::types::{ActionResult, ParsedSubagentAction};
    use crate::channels::messages::service::types::SubagentAction;
    use crate::messages_store::types::ChannelType;
    use crate::model_hub::http::BoxFuture;

    struct FakeSubagents {
        payload: Option<serde_json::Map<String, Value>>,
    }

    impl SubagentManagerPort for FakeSubagents {
        fn parse_subagent_action(
            &self,
            _payload: &str,
            _command: Option<&str>,
        ) -> ParsedSubagentAction {
            ParsedSubagentAction {
                action: SubagentAction::List,
                args: vec!["all".to_string()],
            }
        }

        fn execute_subagent_action<'a>(
            &'a self,
            _context: &'a SubagentDispatchContext,
            action: SubagentAction,
            args: &'a [String],
            _host: &'a dyn SubagentManagerDeps,
        ) -> BoxFuture<'a, Result<ActionResult, PortError>> {
            assert_eq!(action, SubagentAction::List);
            assert_eq!(args.to_vec(), vec!["all".to_string()]);
            Box::pin(std::future::ready(Ok(ActionResult {
                text: "2 Subagents".to_string(),
                payload: self.payload.clone().unwrap_or_default(),
            })))
        }
    }

    #[tokio::test]
    async fn the_reply_carries_runtime_and_action_with_the_payload_merged_last() {
        let deps = FakeDeps {
            subagents: Box::new(FakeSubagents {
                payload: Some(json_map([
                    ("count", Value::from(2)),
                    ("runtime", Value::from("override")),
                ])),
            }),
            ..FakeDeps::default()
        };
        let context = SubagentDispatchContext {
            conversation: conversation("c1", "user-1", None, "WebChat"),
            platform: ChannelType::WebChat,
            external_chat_id: "chat".to_string(),
        };

        handle_subagent_command(&context, "all", Some("/subagents"), &deps)
            .await
            .unwrap();

        let sent = deps.sender.last();
        assert_eq!(sent.content, "2 Subagents");
        let metadata = sent.metadata.expect("metadata");
        assert_eq!(metadata["action"], "list");
        assert_eq!(metadata["count"], 2);
        assert_eq!(metadata["runtime"], "override");
    }

    #[tokio::test]
    async fn a_result_without_payload_keeps_the_two_base_keys() {
        let deps = FakeDeps {
            subagents: Box::new(FakeSubagents { payload: None }),
            ..FakeDeps::default()
        };
        let context = SubagentDispatchContext {
            conversation: conversation("c1", "user-1", None, "WebChat"),
            platform: ChannelType::WebChat,
            external_chat_id: "chat".to_string(),
        };

        handle_subagent_command(&context, "", None, &deps)
            .await
            .unwrap();

        let metadata = deps.sender.last().metadata.expect("metadata");
        assert_eq!(metadata.len(), 2);
        assert_eq!(metadata["runtime"], "subagents-command");
    }
}
