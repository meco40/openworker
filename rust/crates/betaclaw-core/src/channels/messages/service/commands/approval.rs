//! Port of `src/server/channels/messages/service/commands/approvalCommand.ts` (S8).
//!
//! The TS `respondToolApproval` callback is [`ApprovalResponder`]. History and replies go through
//! [`CommandHandlerDeps`]. The handler reads only the status of the approval outcome, so `ok` and
//! `policyUpdated` are not used here.

use std::collections::HashSet;

use crate::channels::messages::service::approval::handler::{ApprovalParams, ApprovalStatus};
use crate::channels::messages::service::commands::types::{reply, CommandHandlerDeps};
use crate::channels::messages::service::execution::ports::PortError;
use crate::channels::messages::service::ports::ApprovalResponder;
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};

/// `/approve <token>` and `/deny <token>`. If the approval itself emits a new agent message, that
/// message is the reply. Otherwise the status decides the reply text.
pub async fn handle_approval_command(
    conversation: &Conversation,
    payload: &str,
    command: Option<&str>,
    platform: ChannelType,
    external_chat_id: &str,
    deps: &dyn CommandHandlerDeps,
    approvals: &dyn ApprovalResponder,
) -> Result<StoredMessage, PortError> {
    let token = payload.trim();
    let approved = command.unwrap_or("").trim().to_lowercase() == "/approve";

    if token.is_empty() {
        return reply(
            deps,
            conversation,
            "Usage: /approve <token> oder /deny <token>",
            platform,
            external_chat_id,
        )
        .await;
    }

    let history = deps.history();
    let before: HashSet<String> = history
        .list_recent_messages(&conversation.id, &conversation.user_id, 20)?
        .into_iter()
        .map(|message| message.id)
        .collect();

    let status = approvals
        .respond_tool_approval(ApprovalParams {
            conversation_id: conversation.id.clone(),
            user_id: conversation.user_id.clone(),
            approval_token: token.to_string(),
            approved,
            approve_always: false,
            tool_id: None,
            tool_function_name: None,
        })
        .await?
        .status;

    let after = history.list_recent_messages(&conversation.id, &conversation.user_id, 20)?;
    if let Some(emitted) = after
        .into_iter()
        .find(|message| message.role == "agent" && !before.contains(&message.id))
    {
        return Ok(emitted);
    }

    let text = match status {
        ApprovalStatus::NotFound => "⚠️ Approval-Token nicht gefunden oder abgelaufen.",
        ApprovalStatus::ApprovalRequired => "Weitere Genehmigung erforderlich.",
        ApprovalStatus::Denied => "Freigabe abgelehnt.",
        ApprovalStatus::Approved => "Freigabe verarbeitet.",
    };
    reply(deps, conversation, text, platform, external_chat_id).await
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::channels::messages::service::approval::handler::ApprovalOutcome;
    use crate::channels::messages::service::commands::fakes::FakeDeps;
    use crate::channels::messages::service::conversation::fakes::{conversation, stored_message};
    use crate::model_hub::http::BoxFuture;

    struct FakeApprovals {
        status: ApprovalStatus,
        requests: Mutex<Vec<ApprovalParams>>,
    }

    impl ApprovalResponder for FakeApprovals {
        fn respond_tool_approval(
            &self,
            request: ApprovalParams,
        ) -> BoxFuture<'_, Result<ApprovalOutcome, PortError>> {
            self.requests.lock().unwrap().push(request);
            Box::pin(std::future::ready(Ok(ApprovalOutcome {
                ok: true,
                status: self.status,
                policy_updated: false,
            })))
        }
    }

    fn approvals(status: ApprovalStatus) -> FakeApprovals {
        FakeApprovals {
            status,
            requests: Mutex::new(Vec::new()),
        }
    }

    #[tokio::test]
    async fn empty_token_prints_the_usage() {
        let deps = FakeDeps::default();
        let conv = conversation("c1", "user-1", None, "WebChat");
        let port = approvals(ApprovalStatus::Approved);

        handle_approval_command(
            &conv,
            "  ",
            Some("/approve"),
            ChannelType::WebChat,
            "chat",
            &deps,
            &port,
        )
        .await
        .unwrap();

        assert_eq!(
            deps.sender.last().content,
            "Usage: /approve <token> oder /deny <token>"
        );
        assert!(port.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn deny_passes_approved_false_and_reports_the_denial() {
        let deps = FakeDeps::default();
        let conv = conversation("c1", "user-1", None, "WebChat");
        let port = approvals(ApprovalStatus::Denied);

        handle_approval_command(
            &conv,
            "tok-9",
            Some(" /Deny "),
            ChannelType::WebChat,
            "chat",
            &deps,
            &port,
        )
        .await
        .unwrap();

        let requests = port.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].approval_token, "tok-9");
        assert!(!requests[0].approved);
        assert!(!requests[0].approve_always);
        assert_eq!(deps.sender.last().content, "Freigabe abgelehnt.");
    }

    #[tokio::test]
    async fn an_agent_message_emitted_by_the_approval_is_the_reply() {
        let deps = FakeDeps::default();
        deps.history.snapshots.lock().unwrap().extend([
            vec![stored_message("u1", "c1", "user", "rm -rf")],
            vec![
                stored_message("u1", "c1", "user", "rm -rf"),
                stored_message("a1", "c1", "agent", "Erledigt."),
            ],
        ]);
        let conv = conversation("c1", "user-1", None, "WebChat");
        let port = approvals(ApprovalStatus::Approved);

        let reply_message = handle_approval_command(
            &conv,
            "tok-1",
            Some("/approve"),
            ChannelType::WebChat,
            "chat",
            &deps,
            &port,
        )
        .await
        .unwrap();

        assert_eq!(reply_message.id, "a1");
        assert!(deps.sender.contents().is_empty());
    }

    #[tokio::test]
    async fn an_unknown_token_reports_not_found() {
        let deps = FakeDeps::default();
        let conv = conversation("c1", "user-1", None, "WebChat");
        let port = approvals(ApprovalStatus::NotFound);

        handle_approval_command(
            &conv,
            "nope",
            Some("/approve"),
            ChannelType::WebChat,
            "chat",
            &deps,
            &port,
        )
        .await
        .unwrap();

        assert_eq!(
            deps.sender.last().content,
            "⚠️ Approval-Token nicht gefunden oder abgelaufen."
        );
    }
}
