//! Port of `src/server/channels/messages/service/subagent/actions/list.ts`.

use serde_json::json;

use super::super::constants::SUBAGENT_RECENT_MINUTES;
use super::super::registry::SubagentRegistry;
use super::super::types::ActionResult;
use super::super::utils::{object, short_id, truncate_utf16};

/// `formatSubagentList(conversationId)`.
pub fn format_subagent_list(registry: &dyn SubagentRegistry, conversation_id: &str) -> String {
    let runs = registry.list_runs_for_conversation(conversation_id, SUBAGENT_RECENT_MINUTES);
    let mut lines: Vec<String> = vec!["Subagents".into(), String::new(), "active:".into()];

    if runs.active.is_empty() {
        lines.push("(none)".into());
    } else {
        for (index, run) in runs.active.iter().enumerate() {
            lines.push(format!(
                "{}. {} ({}) - running",
                index + 1,
                run.agent_id,
                short_id(&run.run_id)
            ));
        }
    }

    lines.push(String::new());
    lines.push(format!("recent (last {SUBAGENT_RECENT_MINUTES}m):"));
    if runs.recent.is_empty() {
        lines.push("(none)".into());
    } else {
        for (index, run) in runs.recent.iter().enumerate() {
            // JavaScript: `run.resultPreview || run.error || ''`, then trimmed.
            let preview = run
                .result_preview
                .as_deref()
                .filter(|text| !text.is_empty())
                .or(run.error.as_deref().filter(|text| !text.is_empty()))
                .unwrap_or("")
                .trim();
            let suffix = if preview.is_empty() {
                String::new()
            } else {
                format!(" - {}", truncate_utf16(preview, 80))
            };
            lines.push(format!(
                "{}. {} ({}) - {}{}",
                index + 1,
                run.agent_id,
                short_id(&run.run_id),
                run.status.as_str(),
                suffix
            ));
        }
    }
    lines.join("\n")
}

/// `executeListAction(conversationId)`.
pub fn execute_list_action(registry: &dyn SubagentRegistry, conversation_id: &str) -> ActionResult {
    let runs = registry.list_runs_for_conversation(conversation_id, SUBAGENT_RECENT_MINUTES);
    ActionResult {
        text: format_subagent_list(registry, conversation_id),
        payload: object(json!({
            "status": "ok",
            "action": "list",
            "active": runs.active,
            "recent": runs.recent,
        })),
    }
}
