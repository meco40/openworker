//! Port of `src/server/channels/messages/service/commands/shellCommand.ts` (S8).
//!
//! Runs the `shell_execute` tool through [`ToolManagerPort`]. A tool that needs approval answers
//! with the approval prompt and its metadata instead.

use serde_json::Value;

use crate::channels::messages::service::commands::types::{json_map, reply, CommandHandlerDeps};
use crate::channels::messages::service::execution::ports::PortError;
use crate::channels::messages::service::tool_manager::ToolCallRequest;
use crate::channels::messages::service::types::ToolExecutionResult;
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};

const SHELL_FUNCTION: &str = "shell_execute";
const SHELL_SKILL_FALLBACK: &str = "shell-access";
const RUNTIME: &str = "chat-shell-command";

pub async fn handle_shell_command(
    conversation: &Conversation,
    payload: &str,
    platform: ChannelType,
    external_chat_id: &str,
    deps: &dyn CommandHandlerDeps,
) -> Result<StoredMessage, PortError> {
    let command = payload.trim();
    if command.is_empty() {
        return reply(
            deps,
            conversation,
            "Bitte nutze /shell <command> oder !<command>.",
            platform,
            external_chat_id,
        )
        .await;
    }

    let tools = deps.tool_manager();
    let context = tools.resolve_tool_context().await?;
    let tool_id = context
        .function_to_skill_id
        .get(SHELL_FUNCTION)
        .cloned()
        .unwrap_or_else(|| SHELL_SKILL_FALLBACK.to_string());

    let execution = tools
        .execute_tool_function_call(ToolCallRequest {
            conversation: conversation.clone(),
            platform,
            external_chat_id: external_chat_id.to_string(),
            function_name: SHELL_FUNCTION.to_string(),
            args: Value::Object(json_map([("command", Value::from(command))])),
            workspace_cwd: deps.resolve_workspace_cwd(conversation),
            installed_functions: context.installed_function_names,
            tool_id: Some(tool_id),
            skip_approval_check: false,
        })
        .await?;

    let (ok, text) = match execution {
        ToolExecutionResult::ApprovalRequired { prompt, pending } => {
            let metadata = tools.build_approval_metadata(
                &pending,
                &prompt,
                json_map([
                    ("ok", Value::Bool(false)),
                    ("runtime", Value::from(RUNTIME)),
                ]),
            );
            return deps
                .send_response(
                    conversation,
                    &prompt,
                    platform,
                    external_chat_id,
                    Some(metadata),
                )
                .await;
        }
        ToolExecutionResult::Ok { output } => (true, format!("CLI command completed:\n{output}")),
        ToolExecutionResult::Error { output } => (false, format!("CLI command failed:\n{output}")),
    };

    let metadata = json_map([
        ("ok", Value::Bool(ok)),
        ("runtime", Value::from(RUNTIME)),
        ("tool", Value::from(SHELL_FUNCTION)),
        ("command", Value::from(command)),
    ]);
    deps.send_response(
        conversation,
        &text,
        platform,
        external_chat_id,
        Some(metadata),
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::future::ready;
    use std::sync::Mutex;

    use super::*;
    use crate::channels::messages::service::commands::fakes::FakeDeps;
    use crate::channels::messages::service::conversation::fakes::conversation;
    use crate::channels::messages::service::execution::ports::ToolManagerPort;
    use crate::channels::messages::service::types::{PendingToolApproval, ResolvedToolContext};
    use crate::model_hub::http::BoxFuture;

    struct FakeTools {
        result: Mutex<Option<ToolExecutionResult>>,
        calls: Mutex<Vec<(String, Option<String>)>>,
    }

    impl ToolManagerPort for FakeTools {
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
            Box::pin(ready(Ok(())))
        }

        fn resolve_tool_context(&self) -> BoxFuture<'_, Result<ResolvedToolContext, PortError>> {
            Box::pin(ready(Ok(ResolvedToolContext {
                tools: Vec::new(),
                installed_function_names: HashSet::from(["shell_execute".to_string()]),
                function_to_skill_id: HashMap::from([(
                    "shell_execute".to_string(),
                    "skill-shell".to_string(),
                )]),
            })))
        }

        fn execute_tool_function_call(
            &self,
            call: ToolCallRequest,
        ) -> BoxFuture<'_, Result<ToolExecutionResult, PortError>> {
            self.calls
                .lock()
                .unwrap()
                .push((call.function_name.clone(), call.tool_id.clone()));
            let result = self.result.lock().unwrap().take().expect("one result");
            Box::pin(ready(Ok(result)))
        }
    }

    fn tools(result: ToolExecutionResult) -> FakeTools {
        FakeTools {
            result: Mutex::new(Some(result)),
            calls: Mutex::new(Vec::new()),
        }
    }

    #[tokio::test]
    async fn empty_command_prints_the_usage_without_running_a_tool() {
        let deps = FakeDeps {
            tools: Box::new(tools(ToolExecutionResult::Ok {
                output: String::new(),
            })),
            ..FakeDeps::default()
        };
        let conv = conversation("c1", "user-1", None, "WebChat");

        handle_shell_command(&conv, "   ", ChannelType::WebChat, "chat", &deps)
            .await
            .unwrap();

        assert_eq!(
            deps.sender.last().content,
            "Bitte nutze /shell <command> oder !<command>."
        );
    }

    #[tokio::test]
    async fn a_successful_run_reports_the_output_with_its_metadata() {
        let fake = tools(ToolExecutionResult::Ok {
            output: "hi".to_string(),
        });
        let deps = FakeDeps {
            tools: Box::new(fake),
            ..FakeDeps::default()
        };
        let conv = conversation("c1", "user-1", None, "WebChat");

        handle_shell_command(&conv, " echo hi ", ChannelType::WebChat, "chat", &deps)
            .await
            .unwrap();

        let sent = deps.sender.last();
        assert_eq!(sent.content, "CLI command completed:\nhi");
        let metadata = sent.metadata.expect("metadata");
        assert_eq!(metadata["ok"], true);
        assert_eq!(metadata["runtime"], RUNTIME);
        assert_eq!(metadata["tool"], SHELL_FUNCTION);
        assert_eq!(metadata["command"], "echo hi");
    }

    #[tokio::test]
    async fn a_failed_run_is_marked_not_ok_and_uses_the_skill_id() {
        let fake = tools(ToolExecutionResult::Error {
            output: "boom".to_string(),
        });
        let deps = FakeDeps {
            tools: Box::new(fake),
            ..FakeDeps::default()
        };
        let conv = conversation("c1", "user-1", None, "WebChat");

        handle_shell_command(&conv, "false", ChannelType::WebChat, "chat", &deps)
            .await
            .unwrap();

        let sent = deps.sender.last();
        assert_eq!(sent.content, "CLI command failed:\nboom");
        assert_eq!(sent.metadata.expect("metadata")["ok"], false);
    }

    #[tokio::test]
    async fn approval_required_sends_the_prompt_with_approval_metadata() {
        let pending = PendingToolApproval {
            token: "tok-7".to_string(),
            user_id: "user-1".to_string(),
            conversation_id: "c1".to_string(),
            platform: ChannelType::WebChat,
            external_chat_id: "chat".to_string(),
            tool_function_name: SHELL_FUNCTION.to_string(),
            tool_id: Some("skill-shell".to_string()),
            args: serde_json::Map::new(),
            command: Some("rm -rf /".to_string()),
            created_at_ms: 0,
        };
        let fake = tools(ToolExecutionResult::ApprovalRequired {
            prompt: "Befehl freigeben?".to_string(),
            pending: Box::new(pending),
        });
        let deps = FakeDeps {
            tools: Box::new(fake),
            ..FakeDeps::default()
        };
        let conv = conversation("c1", "user-1", None, "WebChat");

        handle_shell_command(&conv, "rm -rf /", ChannelType::WebChat, "chat", &deps)
            .await
            .unwrap();

        let sent = deps.sender.last();
        assert_eq!(sent.content, "Befehl freigeben?");
        let metadata = sent.metadata.expect("metadata");
        assert_eq!(metadata["status"], "approval_required");
        assert_eq!(metadata["approvalToken"], "tok-7");
        assert_eq!(metadata["approvalToolId"], "skill-shell");
        assert_eq!(metadata["ok"], false);
        assert_eq!(metadata["runtime"], RUNTIME);
    }
}
