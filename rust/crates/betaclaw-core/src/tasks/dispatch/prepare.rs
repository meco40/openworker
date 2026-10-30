//! Port of `prepareDispatch` (`src/server/tasks/dispatch/prepareDispatch.ts`).
//!
//! Ported: the checks in the source's order (task, assignee, agent, other
//! orchestrators), the `betaclaw_sessions` get-or-create with its event, and the
//! project directory. Not ported: the skill check (`getSkillRepository`, S11) and
//! the connect step of the Mission Control client (`getBetaClawClient`, S8). The
//! caller runs those between the two checks and the session step.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use super::DispatchHttpResponse;
use crate::tasks::deliverables::project_slug;
use crate::tasks::types::{AgentRow, SessionRow, Task};
use crate::tasks::{is_js_whitespace, non_empty};

/// A master agent that is still available in the same workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrchestratorSummary {
    pub id: String,
    pub name: String,
    pub role: String,
}

/// `${projectsPath}/${buildProjectDirectory(title)}`.
pub fn task_project_dir(projects_path: &str, task_title: &str) -> String {
    format!("{projects_path}/{}", project_slug(task_title))
}

fn error_response(status: u16, message: &str) -> DispatchHttpResponse {
    DispatchHttpResponse {
        status,
        body: json!({ "error": message }),
    }
}

fn other_orchestrators_message(orchestrators: &[OrchestratorSummary]) -> String {
    let count = orchestrators.len();
    let plural = if count == 1 { "" } else { "s" };
    let verb = if count == 1 { "is" } else { "are" };
    let names = orchestrators
        .iter()
        .map(|orchestrator| orchestrator.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "There {verb} {count} other orchestrator{plural} available in this workspace: {names}. Consider assigning this task to them instead."
    )
}

/// The checks of `prepareDispatch` before the skill and connect steps. The other
/// orchestrators are loaded only for a master agent, as in the source.
pub fn check_dispatch_target(
    task: Option<&Task>,
    agent: Option<&AgentRow>,
    load_orchestrators: impl FnOnce() -> Vec<OrchestratorSummary>,
) -> Result<(), DispatchHttpResponse> {
    let task = task.ok_or_else(|| error_response(404, "Task not found"))?;
    if non_empty(task.assigned_agent_id.as_deref()).is_none() {
        return Err(error_response(400, "Task has no assigned agent"));
    }
    let agent = agent.ok_or_else(|| error_response(404, "Assigned agent not found"))?;
    if agent.is_master {
        let others = load_orchestrators();
        if !others.is_empty() {
            return Err(DispatchHttpResponse {
                status: 409,
                body: json!({
                    "success": false,
                    "warning": "Other orchestrators available",
                    "message": other_orchestrators_message(&others),
                    "otherOrchestrators": others,
                }),
            });
        }
    }
    Ok(())
}

/// Master agents of the workspace other than `agent_id` that are not offline.
pub fn other_orchestrators(
    connection: &Connection,
    agent_id: &str,
    workspace_id: &str,
) -> rusqlite::Result<Vec<OrchestratorSummary>> {
    let mut statement = connection.prepare(
        "SELECT id, name, role FROM agents
         WHERE is_master = 1 AND id != ? AND workspace_id = ? AND status != 'offline'",
    )?;
    let rows = statement.query_map(params![agent_id, workspace_id], |row| {
        Ok(OrchestratorSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            role: row.get(2)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

fn session_from_row(row: &Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get("id")?,
        agent_id: row.get("agent_id")?,
        betaclaw_session_id: row.get("betaclaw_session_id")?,
        status: row.get("status")?,
    })
}

/// `mission-control-${name.toLowerCase().replace(/\s+/g, '-')}`. Each run of
/// whitespace becomes one `-`, and nothing is trimmed.
pub fn dispatch_session_id(agent_name: &str) -> String {
    let mut slug = String::new();
    let mut in_whitespace_run = false;
    for c in agent_name.to_lowercase().chars() {
        if is_js_whitespace(c) {
            if !in_whitespace_run {
                slug.push('-');
            }
            in_whitespace_run = true;
        } else {
            slug.push(c);
            in_whitespace_run = false;
        }
    }
    format!("mission-control-{slug}")
}

/// The active session of the agent, or a new one with its `agent_status_changed`
/// event. `None` only when the inserted row cannot be read back.
pub fn find_or_create_session(
    connection: &Connection,
    agent: &AgentRow,
    now: &str,
) -> rusqlite::Result<Option<SessionRow>> {
    let active = connection
        .query_row(
            "SELECT id, agent_id, betaclaw_session_id, status FROM betaclaw_sessions
             WHERE agent_id = ? AND status = 'active'",
            [&agent.id],
            session_from_row,
        )
        .optional()?;
    if active.is_some() {
        return Ok(active);
    }

    let session_id = Uuid::new_v4().to_string();
    connection.execute(
        "INSERT INTO betaclaw_sessions (id, agent_id, betaclaw_session_id, channel, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            session_id,
            agent.id,
            dispatch_session_id(&agent.name),
            "mission-control",
            "active",
            now,
            now
        ],
    )?;
    let created = connection
        .query_row(
            "SELECT id, agent_id, betaclaw_session_id, status FROM betaclaw_sessions WHERE id = ?",
            [&session_id],
            session_from_row,
        )
        .optional()?;
    connection.execute(
        "INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)",
        params![
            Uuid::new_v4().to_string(),
            "agent_status_changed",
            agent.id,
            format!("{} session created", agent.name),
            now
        ],
    )?;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::repository::find_agent;
    use crate::tasks::test_support::{insert_agent, memory_connection};

    fn task(assigned: Option<&str>) -> Task {
        Task {
            id: "task-1".to_string(),
            title: "Build Page!".to_string(),
            description: None,
            status: "assigned".to_string(),
            priority: "normal".to_string(),
            assigned_agent_id: assigned.map(str::to_string),
            created_by_agent_id: None,
            workspace_id: "default".to_string(),
            business_id: "default".to_string(),
            due_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            assigned_agent_name: None,
            assigned_agent_emoji: None,
            created_by_agent_name: None,
            created_by_agent_emoji: None,
        }
    }

    fn agent(is_master: bool) -> AgentRow {
        AgentRow {
            id: "agent-1".to_string(),
            name: "Builder".to_string(),
            role: "worker".to_string(),
            is_master,
        }
    }

    fn orchestrator(name: &str) -> OrchestratorSummary {
        OrchestratorSummary {
            id: format!("id-{name}"),
            name: name.to_string(),
            role: "master".to_string(),
        }
    }

    #[test]
    fn project_directory_uses_the_title_slug() {
        assert_eq!(
            task_project_dir("/projects", "Build Page!"),
            "/projects/build-page"
        );
    }

    #[test]
    fn checks_run_in_the_source_order() {
        let no_load = || -> Vec<OrchestratorSummary> { panic!("orchestrators must not be loaded") };

        let missing = check_dispatch_target(None, None, no_load).unwrap_err();
        assert_eq!(
            (missing.status, missing.body),
            (404, json!({"error": "Task not found"}))
        );

        let unassigned = check_dispatch_target(Some(&task(None)), None, no_load).unwrap_err();
        assert_eq!(unassigned.status, 400);

        let no_agent =
            check_dispatch_target(Some(&task(Some("agent-1"))), None, no_load).unwrap_err();
        assert_eq!(no_agent.body, json!({"error": "Assigned agent not found"}));

        assert!(
            check_dispatch_target(Some(&task(Some("agent-1"))), Some(&agent(false)), no_load)
                .is_ok()
        );
    }

    #[test]
    fn master_with_another_orchestrator_gets_a_409_with_the_list() {
        let outcome =
            check_dispatch_target(Some(&task(Some("agent-1"))), Some(&agent(true)), || {
                vec![orchestrator("Ops")]
            })
            .unwrap_err();
        assert_eq!(outcome.status, 409);
        assert_eq!(
            outcome.body["message"],
            "There is 1 other orchestrator available in this workspace: Ops. Consider assigning this task to them instead."
        );
        assert_eq!(outcome.body["otherOrchestrators"][0]["name"], "Ops");

        let plural =
            check_dispatch_target(Some(&task(Some("agent-1"))), Some(&agent(true)), || {
                vec![orchestrator("Ops"), orchestrator("Lead")]
            })
            .unwrap_err();
        assert!(plural.body["message"]
            .as_str()
            .unwrap()
            .starts_with("There are 2 other orchestrators"));
    }

    #[test]
    fn session_id_collapses_whitespace_runs_without_trimming() {
        assert_eq!(
            dispatch_session_id("Scout Two"),
            "mission-control-scout-two"
        );
        assert_eq!(dispatch_session_id("A  \t B"), "mission-control-a-b");
        assert_eq!(dispatch_session_id(" Lead"), "mission-control--lead");
    }

    #[test]
    fn session_is_created_once_and_reused() {
        let connection = memory_connection();
        insert_agent(&connection, "agent-1", "Builder Bot", false, "standby");
        let agent = agent_row(&connection);

        let first = find_or_create_session(&connection, &agent, "2026-01-01T00:00:00.000Z")
            .unwrap()
            .unwrap();
        assert_eq!(first.betaclaw_session_id, "mission-control-builder-bot");
        assert_eq!(first.status, "active");

        let second = find_or_create_session(&connection, &agent, "2026-01-02T00:00:00.000Z")
            .unwrap()
            .unwrap();
        assert_eq!(second.id, first.id);

        let events: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM events WHERE type = 'agent_status_changed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(events, 1);
    }

    #[test]
    fn other_orchestrators_skip_self_offline_and_other_workspaces() {
        let connection = memory_connection();
        insert_agent(&connection, "me", "Me", true, "standby");
        insert_agent(&connection, "ops", "Ops", true, "standby");
        insert_agent(&connection, "gone", "Gone", true, "offline");
        insert_agent(&connection, "worker", "Worker", false, "standby");

        let found = other_orchestrators(&connection, "me", "default").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Ops");
    }

    fn agent_row(connection: &Connection) -> AgentRow {
        find_agent(connection, "agent-1").unwrap().unwrap()
    }
}
