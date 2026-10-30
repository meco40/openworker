//! Port of `src/server/channels/messages/service/transcriptRepair.ts`.
//!
//! An assistant stub `[Tool call: <name>]` without a matching `Tool "<name>" result:`
//! or `Tool "<name>" failed:` reply after a crash, timeout or abort gets a synthetic
//! failure reply, so the model does not see an incomplete exchange.

use std::sync::LazyLock;

use regex::Regex;

use crate::channels::messages::service::utils::js_regex::js_regex;
use crate::model_hub::types::{GatewayMessage, GatewayRole};

/// `/^\[Tool call: ([^\]]+)\]$/` applied to `content.trim()`.
static TOOL_CALL_STUB_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^\[Tool call: ([^\]]+)\]$"));

/// `/^Tool "([^"]+)" (?:result|failed):/`.
static TOOL_RESULT_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r#"^Tool "([^"]+)" (?:result|failed):"#));

/// `repairOrphanedToolCalls(messages)`. Returns a new list; the input is not changed.
/// Idempotent: a repaired transcript has an answer after every stub.
pub fn repair_orphaned_tool_calls(messages: &[GatewayMessage]) -> Vec<GatewayMessage> {
    let mut output = Vec::with_capacity(messages.len());

    for (index, message) in messages.iter().enumerate() {
        output.push(message.clone());

        if message.role != GatewayRole::Assistant {
            continue;
        }
        let Some(stub) = TOOL_CALL_STUB_RE.captures(message.content.trim()) else {
            continue;
        };
        let tool_name = stub.get(1).map(|m| m.as_str()).unwrap_or_default();

        let is_answered = messages.get(index + 1).is_some_and(|next| {
            next.role == GatewayRole::User
                && TOOL_RESULT_PREFIX_RE
                    .captures(&next.content)
                    .and_then(|m| m.get(1))
                    .is_some_and(|name| name.as_str() == tool_name)
        });

        if !is_answered {
            output.push(GatewayMessage::user(format!(
                "Tool \"{tool_name}\" failed:\n\
                 [System: Tool result was lost — the session was interrupted or the call timed out. \
                 Do NOT repeat the same tool call. Re-evaluate your plan and continue with the \
                 information you already have, or choose a different approach.]"
            )));
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unanswered_stub_gets_a_synthetic_failure_reply() {
        let messages = vec![
            GatewayMessage::user("hi"),
            GatewayMessage::new(GatewayRole::Assistant, "[Tool call: shell_execute]"),
        ];
        let repaired = repair_orphaned_tool_calls(&messages);
        assert_eq!(repaired.len(), 3);
        assert_eq!(repaired[2].role, GatewayRole::User);
        assert!(repaired[2]
            .content
            .starts_with("Tool \"shell_execute\" failed:\n"));
        assert!(repaired[2]
            .content
            .contains("Do NOT repeat the same tool call."));
    }

    #[test]
    fn an_answered_stub_is_left_alone() {
        let messages = vec![
            GatewayMessage::new(GatewayRole::Assistant, "  [Tool call: file_read]  "),
            GatewayMessage::user("Tool \"file_read\" result:\nbody"),
        ];
        assert_eq!(repair_orphaned_tool_calls(&messages), messages);
    }

    #[test]
    fn a_reply_for_another_tool_does_not_count_as_an_answer() {
        let messages = vec![
            GatewayMessage::new(GatewayRole::Assistant, "[Tool call: file_read]"),
            GatewayMessage::user("Tool \"shell_execute\" failed:\nno"),
        ];
        let repaired = repair_orphaned_tool_calls(&messages);
        assert_eq!(repaired.len(), 3);
    }

    #[test]
    fn repair_is_idempotent() {
        let messages = vec![GatewayMessage::new(
            GatewayRole::Assistant,
            "[Tool call: web_fetch]",
        )];
        let once = repair_orphaned_tool_calls(&messages);
        assert_eq!(repair_orphaned_tool_calls(&once), once);
    }
}
