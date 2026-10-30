//! Port of `src/server/tasks/dispatch/finalizeDispatch.ts`. The decisions come from
//! `state::completion_plan` and `message::extract_task_complete_summary`. This file
//! applies the SQL effects in the order of the source.
//!
//! Not ported: `broadcast({ type: 'task_updated' })`, the HTTP trigger
//! `triggerAutomatedTaskTest` (the runtime of S10) and the World-Model calls.

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use uuid::Uuid;

use super::message::extract_task_complete_summary;
use super::DispatchHttpResponse;
use crate::tasks::deliverables::ensure_from_project_dir;
use crate::tasks::repository::INSERT_EVENT;
use crate::tasks::state::completion_plan;
use crate::tasks::types::{AgentRow, SessionRow, Task};

/// The context that `prepareDispatch` hands to `finalizeDispatch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedDispatch {
    pub task: Task,
    pub agent: AgentRow,
    pub session: SessionRow,
    pub now: String,
    pub task_project_dir: String,
}

/// `finalizeDispatch`. A `TASK_COMPLETE:` reply completes the dispatch, otherwise
/// the task is in progress.
pub fn finalize_dispatch(
    connection: &Connection,
    context: &PreparedDispatch,
    agent_content: Option<&str>,
) -> rusqlite::Result<DispatchHttpResponse> {
    match extract_task_complete_summary(agent_content) {
        Some(summary) => finish_completed(connection, context, &summary),
        None => finish_in_progress(connection, context),
    }
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn success_payload(context: &PreparedDispatch) -> Value {
    json!({
        "success": true,
        "task_id": context.task.id,
        "agent_id": context.agent.id,
        "session_id": context.session.betaclaw_session_id,
        "message": "Task dispatched to agent",
    })
}

fn finish_completed(
    connection: &Connection,
    context: &PreparedDispatch,
    summary: &str,
) -> rusqlite::Result<DispatchHttpResponse> {
    let task = &context.task;
    let agent = &context.agent;
    let now = context.now.as_str();
    let plan = completion_plan(&task.status);

    if plan.set_testing {
        connection.execute(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
            params!["testing", now, task.id],
        )?;
    }
    if plan.auto_test {
        ensure_from_project_dir(connection, &task.id, &context.task_project_dir, now)?;
    }

    connection.execute(
        "UPDATE agents SET status = ?, updated_at = ? WHERE id = ?",
        params!["standby", now, agent.id],
    )?;
    connection.execute(
        INSERT_EVENT,
        params![
            new_id(),
            "task_dispatched",
            agent.id,
            task.id,
            format!("Task \"{}\" dispatched to {}", task.title, agent.name),
            now
        ],
    )?;
    connection.execute(
        INSERT_EVENT,
        params![
            new_id(),
            "task_completed",
            agent.id,
            task.id,
            format!("{} completed: {summary}", agent.name),
            now
        ],
    )?;
    connection.execute(
        "INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            new_id(),
            task.id,
            agent.id,
            "completed",
            format!("Agent reported completion: {summary}"),
            now
        ],
    )?;

    Ok(DispatchHttpResponse {
        status: 200,
        body: json!({
            "success": true,
            "task_id": task.id,
            "agent_id": agent.id,
            "session_id": context.session.betaclaw_session_id,
            "completed": true,
            "new_status": "testing",
            "summary": summary,
            "message": "Task dispatched and completed by agent",
        }),
    })
}

fn finish_in_progress(
    connection: &Connection,
    context: &PreparedDispatch,
) -> rusqlite::Result<DispatchHttpResponse> {
    let task = &context.task;
    let agent = &context.agent;
    let now = context.now.as_str();

    connection.execute(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
        params!["in_progress", now, task.id],
    )?;
    connection.execute(
        "UPDATE agents SET status = ?, updated_at = ? WHERE id = ?",
        params!["working", now, agent.id],
    )?;
    connection.execute(
        INSERT_EVENT,
        params![
            new_id(),
            "task_dispatched",
            agent.id,
            task.id,
            format!("Task \"{}\" dispatched to {}", task.title, agent.name),
            now
        ],
    )?;
    connection.execute(
        "INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            new_id(),
            task.id,
            agent.id,
            "status_changed",
            format!(
                "Task dispatched to {} - Agent is now working on this task",
                agent.name
            ),
            now
        ],
    )?;

    Ok(DispatchHttpResponse {
        status: 200,
        body: success_payload(context),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::dispatch::prepare::find_or_create_session;
    use crate::tasks::repository::{find_agent, find_task};
    use crate::tasks::test_support::{insert_agent, insert_task, memory_connection};

    /// A connection with one agent, one task in `status` and its session.
    fn prepared(status: &str) -> (Connection, PreparedDispatch) {
        let connection = memory_connection();
        insert_agent(&connection, "agent-1", "Builder", false, "standby");
        insert_task(&connection, "task-1", "Site", status, Some("agent-1"));
        let now = "2026-01-01T00:00:00.000Z";
        let agent = find_agent(&connection, "agent-1").unwrap().unwrap();
        let session = find_or_create_session(&connection, &agent, now)
            .unwrap()
            .unwrap();
        let task = find_task(&connection, "task-1").unwrap().unwrap();
        let context = PreparedDispatch {
            task,
            agent,
            session,
            now: now.to_string(),
            // A directory that does not exist, so no deliverable is registered.
            task_project_dir: "/nonexistent-betaclaw-test/site".to_string(),
        };
        (connection, context)
    }

    fn scalar(connection: &Connection, sql: &str) -> String {
        connection.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn completion_marks_the_task_for_testing_and_the_agent_standby() {
        let (connection, context) = prepared("assigned");
        let response =
            finalize_dispatch(&connection, &context, Some("TASK_COMPLETE: built the page"))
                .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body["completed"], true);
        assert_eq!(response.body["new_status"], "testing");
        assert_eq!(response.body["summary"], "built the page");
        assert_eq!(response.body["session_id"], "mission-control-builder");
        assert_eq!(
            scalar(&connection, "SELECT status FROM tasks WHERE id = 'task-1'"),
            "testing"
        );
        assert_eq!(
            scalar(
                &connection,
                "SELECT status FROM agents WHERE id = 'agent-1'"
            ),
            "standby"
        );
        assert_eq!(
            scalar(
                &connection,
                "SELECT message FROM events WHERE type = 'task_completed'"
            ),
            "Builder completed: built the page"
        );
        assert_eq!(
            scalar(
                &connection,
                "SELECT message FROM task_activities WHERE activity_type = 'completed'"
            ),
            "Agent reported completion: built the page"
        );
    }

    #[test]
    fn completion_of_a_reviewed_task_keeps_its_status_but_still_reports_testing() {
        let (connection, context) = prepared("review");
        let response =
            finalize_dispatch(&connection, &context, Some("TASK_COMPLETE: again")).unwrap();
        assert_eq!(response.body["new_status"], "testing");
        assert_eq!(
            scalar(&connection, "SELECT status FROM tasks WHERE id = 'task-1'"),
            "review"
        );
    }

    #[test]
    fn a_reply_without_the_marker_leaves_the_task_in_progress() {
        let (connection, context) = prepared("assigned");
        let response = finalize_dispatch(&connection, &context, Some("Still working")).unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.body["message"], "Task dispatched to agent");
        assert_eq!(response.body.get("completed"), None);
        assert_eq!(
            scalar(&connection, "SELECT status FROM tasks WHERE id = 'task-1'"),
            "in_progress"
        );
        assert_eq!(
            scalar(
                &connection,
                "SELECT status FROM agents WHERE id = 'agent-1'"
            ),
            "working"
        );
        assert_eq!(
            scalar(
                &connection,
                "SELECT message FROM task_activities WHERE activity_type = 'status_changed'"
            ),
            "Task dispatched to Builder - Agent is now working on this task"
        );
    }
}
