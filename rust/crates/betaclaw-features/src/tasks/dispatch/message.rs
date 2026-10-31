//! Port of `src/server/tasks/dispatch/message.ts`: the text the agent receives,
//! and the `TASK_COMPLETE:` marker that the agent answers with.

use crate::tasks::types::Task;
use crate::tasks::{is_js_whitespace, js_trim};

/// `PRIORITY_EMOJI[priority] || '⚪'`.
pub fn priority_emoji(priority: &str) -> &'static str {
    match priority {
        "low" => "🔵",
        "high" => "🟡",
        "urgent" => "🔴",
        _ => "⚪",
    }
}

/// `buildDispatchTaskMessage`. The lines follow the template of the source. The
/// description and due-date lines appear only when the value is non-empty.
pub fn build_dispatch_task_message(
    task: &Task,
    mission_control_url: &str,
    task_project_dir: &str,
) -> String {
    let emoji = priority_emoji(&task.priority);
    let priority = task.priority.to_uppercase();
    let description_line = match task.description.as_deref().filter(|text| !text.is_empty()) {
        Some(description) => format!("**Description:** {description}\n"),
        None => String::new(),
    };
    let due_line = match task.due_date.as_deref().filter(|text| !text.is_empty()) {
        Some(due) => format!("**Due:** {due}\n"),
        None => String::new(),
    };
    let title = &task.title;
    let id = &task.id;
    let url = mission_control_url;
    let dir = task_project_dir;
    format!(
        "{emoji} **NEW TASK ASSIGNED**\n\n\
**Title:** {title}\n\
{description_line}\n\
**Priority:** {priority}\n\
{due_line}\n\
**Task ID:** {id}\n\
\n\
**OUTPUT DIRECTORY:** {dir}\n\
Create this directory and save all deliverables there.\n\
\n\
**IMPORTANT:** After completing work, you MUST call these APIs:\n\
1. Log activity: POST {url}/api/tasks/{id}/activities\n   Body: {{\"activity_type\": \"completed\", \"message\": \"Description of what was done\"}}\n\
2. Register deliverable: POST {url}/api/tasks/{id}/deliverables\n   Body: {{\"deliverable_type\": \"file\", \"title\": \"File name\", \"path\": \"{dir}/filename.html\"}}\n\
3. Update status: PATCH {url}/api/tasks/{id}\n   Body: {{\"status\": \"review\"}}\n\
\n\
When complete, reply with:\n\
`TASK_COMPLETE: [brief summary of what you did]`\n\
\n\
If you need help or clarification, ask the orchestrator."
    )
}

/// `extractTaskCompleteSummary`: the text after the first `TASK_COMPLETE:`
/// (case-insensitive), up to the end of its line, trimmed. An empty summary is `None`.
pub fn extract_task_complete_summary(text: Option<&str>) -> Option<String> {
    let raw = text.unwrap_or_default();
    // ASCII lower-casing keeps the byte offsets of `raw`.
    let marker = "task_complete:";
    let start = raw.to_ascii_lowercase().find(marker)? + marker.len();
    let body = raw[start..].trim_start_matches(is_js_whitespace);
    let line = body
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .next()
        .unwrap_or_default();
    let summary = js_trim(line);
    (!summary.is_empty()).then(|| summary.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(description: Option<&str>, due: Option<&str>) -> Task {
        Task {
            id: "task-1".to_string(),
            title: "Build page".to_string(),
            description: description.map(str::to_string),
            status: "assigned".to_string(),
            priority: "high".to_string(),
            assigned_agent_id: Some("agent-1".to_string()),
            created_by_agent_id: None,
            workspace_id: "default".to_string(),
            business_id: "default".to_string(),
            due_date: due.map(str::to_string),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            assigned_agent_name: None,
            assigned_agent_emoji: None,
            created_by_agent_name: None,
            created_by_agent_emoji: None,
        }
    }

    #[test]
    fn message_without_optional_lines_keeps_the_blank_line_of_the_template() {
        let message = build_dispatch_task_message(&task(None, None), "http://mc", "/p/build-page");
        assert!(message.starts_with("🟡 **NEW TASK ASSIGNED**\n\n**Title:** Build page\n\n**Priority:** HIGH\n\n**Task ID:** task-1\n\n"));
        assert!(!message.contains("**Description:**"));
        assert!(!message.contains("**Due:**"));
        assert!(message.contains("POST http://mc/api/tasks/task-1/activities"));
        assert!(message.contains("\"path\": \"/p/build-page/filename.html\""));
        assert!(message.contains("\n   Body: {\"status\": \"review\"}\n"));
        assert!(message.ends_with("If you need help or clarification, ask the orchestrator."));
    }

    #[test]
    fn message_with_description_and_due_date_adds_both_lines() {
        let message = build_dispatch_task_message(
            &task(Some("Landing page"), Some("2026-02-01")),
            "http://mc",
            "/p/x",
        );
        assert!(message.contains("**Title:** Build page\n**Description:** Landing page\n\n**Priority:** HIGH\n**Due:** 2026-02-01\n\n**Task ID:**"));
    }

    #[test]
    fn empty_description_counts_as_absent() {
        let message = build_dispatch_task_message(&task(Some(""), Some("")), "http://mc", "/p");
        assert!(!message.contains("**Description:**"));
        assert!(!message.contains("**Due:**"));
    }

    #[test]
    fn priority_emoji_falls_back_to_white_circle() {
        assert_eq!(priority_emoji("low"), "🔵");
        assert_eq!(priority_emoji("normal"), "⚪");
        assert_eq!(priority_emoji("urgent"), "🔴");
        assert_eq!(priority_emoji("unknown"), "⚪");
    }

    #[test]
    fn marker_is_found_case_insensitively_and_read_to_the_line_end() {
        assert_eq!(
            extract_task_complete_summary(Some("Done.\nTask_Complete: wrote the page\nthanks")),
            Some("wrote the page".to_string())
        );
        assert_eq!(
            extract_task_complete_summary(Some("TASK_COMPLETE:  \n  second line")),
            Some("second line".to_string())
        );
    }

    #[test]
    fn empty_or_missing_marker_gives_none() {
        assert_eq!(
            extract_task_complete_summary(Some("TASK_COMPLETE:   ")),
            None
        );
        assert_eq!(extract_task_complete_summary(Some("no marker here")), None);
        assert_eq!(extract_task_complete_summary(None), None);
    }
}
