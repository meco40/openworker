//! Port of the SQLite side of `src/server/tasks/taskService.ts`: `listTasks`,
//! `getTaskById`, `createTask`, `updateTask`, `deleteTask` and
//! `getTaskWithRelations`. The statements and their order follow the source.
//!
//! Not ported: the process-wide connection singleton, the `task_updated`
//! broadcasts and the World-Model mirror calls. `updateTask` runs without a
//! transaction, as the source does. `createTask` and `deleteTask` run in one.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use uuid::Uuid;

use super::migrations::run_migrations;
use super::state::{approval_allowed, approval_requested, assignment_dispatch, plan_status_change};
use super::types::{AgentRow, Task};
use super::validation::{CreateTaskInput, UpdateTaskInput};
use super::{non_empty, workspace, TaskError};
use crate::db::{self, OpenOptions};
use crate::stats::util::now_iso;

/// `TaskListFilters` (`taskService.ts:37-43`). Empty strings count as absent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskListFilters {
    pub status: Option<String>,
    pub business_id: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_ids: Option<Vec<String>>,
    pub assigned_agent_id: Option<String>,
}

/// `UpdateTaskResult` (`taskService.ts:45-50`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateTaskResult {
    pub task: Option<Task>,
    pub should_dispatch: bool,
    pub should_auto_test: bool,
    pub previous_title: String,
}

const TASK_SELECT: &str = "SELECT t.*, \
      aa.name AS assigned_agent_name, aa.avatar_emoji AS assigned_agent_emoji, \
      ca.name AS created_by_agent_name, ca.avatar_emoji AS created_by_agent_emoji \
    FROM tasks t \
    LEFT JOIN agents aa ON t.assigned_agent_id = aa.id \
    LEFT JOIN agents ca ON t.created_by_agent_id = ca.id";

const INSERT_TASK: &str = "INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

pub(crate) const INSERT_EVENT: &str =
    "INSERT INTO events (id, type, agent_id, task_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)";

/// A row of `tasks` joined with its agents' names.
pub fn task_from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get("id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        status: row.get("status")?,
        priority: row.get("priority")?,
        assigned_agent_id: row.get("assigned_agent_id")?,
        created_by_agent_id: row.get("created_by_agent_id")?,
        workspace_id: row.get("workspace_id")?,
        business_id: row.get("business_id")?,
        due_date: row.get("due_date")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        assigned_agent_name: row.get("assigned_agent_name")?,
        assigned_agent_emoji: row.get("assigned_agent_emoji")?,
        created_by_agent_name: row.get("created_by_agent_name")?,
        created_by_agent_emoji: row.get("created_by_agent_emoji")?,
    })
}

/// `getTaskWithRelations`: one task with its agents' names, or `None`.
pub fn find_task(connection: &Connection, id: &str) -> rusqlite::Result<Option<Task>> {
    connection
        .query_row(
            &format!("{TASK_SELECT} WHERE t.id = ?"),
            [id],
            task_from_row,
        )
        .optional()
}

/// The agent with `id`, or `None`. `is_master` is `COALESCE`d as the source's
/// truthiness checks treat a missing value as false.
pub fn find_agent(connection: &Connection, id: &str) -> rusqlite::Result<Option<AgentRow>> {
    connection
        .query_row(
            "SELECT id, name, role, COALESCE(is_master, 0) FROM agents WHERE id = ?",
            [id],
            |row| {
                Ok(AgentRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    role: row.get(2)?,
                    is_master: row.get::<_, i64>(3)? != 0,
                })
            },
        )
        .optional()
}

/// The `Option<Option<_>>` form of an id: an empty or `null` id counts as absent,
/// which is what `data.x || null` does in `createTask`.
fn flatten(value: Option<&Option<String>>) -> Option<&str> {
    value.and_then(|inner| non_empty(inner.as_deref()))
}

/// The row values of `createTask` after its defaults are applied.
struct NewTask<'a> {
    id: &'a str,
    now: &'a str,
    title: &'a str,
    description: Option<&'a str>,
    status: &'a str,
    priority: &'a str,
    assigned_agent_id: Option<&'a str>,
    created_by_agent_id: Option<&'a str>,
    workspace_id: &'a str,
    business_id: &'a str,
    due_date: Option<&'a str>,
}

/// Inserts the task and its `task_created` event in one transaction.
fn insert_new_task(connection: &mut Connection, task: &NewTask<'_>) -> rusqlite::Result<()> {
    let creator = match task.created_by_agent_id {
        Some(agent_id) => find_agent(connection, agent_id)?,
        None => None,
    };
    let event_message = match creator {
        Some(creator) => format!("{} created task: {}", creator.name, task.title),
        None => format!("New task: {}", task.title),
    };
    let transaction = connection.transaction()?;
    transaction.execute(
        INSERT_TASK,
        params![
            task.id,
            task.title,
            task.description,
            task.status,
            task.priority,
            task.assigned_agent_id,
            task.created_by_agent_id,
            task.workspace_id,
            task.business_id,
            task.due_date,
            task.now,
            task.now
        ],
    )?;
    transaction.execute(
        INSERT_EVENT,
        params![
            Uuid::new_v4().to_string(),
            "task_created",
            task.created_by_agent_id,
            task.id,
            event_message,
            task.now
        ],
    )?;
    transaction.commit()
}

/// The SQLite repository of the task service. One connection, guarded by a mutex.
pub struct TaskRepository {
    connection: Mutex<Connection>,
}

impl TaskRepository {
    /// Opens the database with the pragmas of the source and runs the migrations.
    pub fn open(db_path: &str) -> Result<Self, TaskError> {
        let mut connection = db::open(OpenOptions::new(db_path))?;
        run_migrations(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn in_memory() -> Result<Self, TaskError> {
        Self::open(":memory:")
    }

    /// The guarded connection, for the dispatch and testing repositories of this slice.
    /// Do not hold the guard across a call to a method of this type.
    pub fn connection(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// `listTasks`. A list of workspace ids that is present but empty yields no tasks.
    pub fn list_tasks(&self, filters: &TaskListFilters) -> Result<Vec<Task>, TaskError> {
        let connection = self.connection();
        let mut sql = format!("{TASK_SELECT} WHERE 1=1");
        let mut params: Vec<String> = Vec::new();

        if let Some(status) = non_empty(filters.status.as_deref()) {
            let statuses: Vec<&str> = status
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .collect();
            match statuses.len() {
                0 => {}
                1 => {
                    sql.push_str(" AND t.status = ?");
                    params.push(statuses[0].to_string());
                }
                count => {
                    sql.push_str(&format!(
                        " AND t.status IN ({})",
                        vec!["?"; count].join(",")
                    ));
                    params.extend(statuses.iter().map(|item| item.to_string()));
                }
            }
        }
        if let Some(business_id) = non_empty(filters.business_id.as_deref()) {
            sql.push_str(" AND t.business_id = ?");
            params.push(business_id.to_string());
        }
        if let Some(workspace_id) = non_empty(filters.workspace_id.as_deref()) {
            sql.push_str(" AND t.workspace_id = ?");
            params.push(workspace_id.to_string());
        } else if let Some(workspace_ids) = &filters.workspace_ids {
            if workspace_ids.is_empty() {
                return Ok(Vec::new());
            }
            sql.push_str(&format!(
                " AND t.workspace_id IN ({})",
                vec!["?"; workspace_ids.len()].join(", ")
            ));
            params.extend(workspace_ids.iter().cloned());
        }
        if let Some(agent_id) = non_empty(filters.assigned_agent_id.as_deref()) {
            sql.push_str(" AND t.assigned_agent_id = ?");
            params.push(agent_id.to_string());
        }
        sql.push_str(" ORDER BY t.created_at DESC");

        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(params.iter()), task_from_row)?;
        let tasks = rows.collect::<rusqlite::Result<Vec<Task>>>()?;
        Ok(tasks)
    }

    /// `getTaskById`: `NotFound` when the task does not exist.
    pub fn get_task(&self, id: &str) -> Result<Task, TaskError> {
        find_task(&self.connection(), id)?.ok_or(TaskError::NotFound)
    }

    pub fn find_task(&self, id: &str) -> Result<Option<Task>, TaskError> {
        Ok(find_task(&self.connection(), id)?)
    }

    /// `createTask`. The workspace directory comes first. It is removed again when
    /// the rows cannot be written, as the source does.
    pub fn create_task(&self, root: &Path, input: &CreateTaskInput) -> Result<Task, TaskError> {
        let mut connection = self.connection();
        let id = Uuid::new_v4().to_string();
        let now = now_iso();
        workspace::ensure_task_workspace(root, &id, "general")?;

        let new_task = NewTask {
            id: &id,
            now: &now,
            title: &input.title,
            description: non_empty(input.description.as_deref()),
            status: non_empty(input.status.as_deref()).unwrap_or("inbox"),
            priority: non_empty(input.priority.as_deref()).unwrap_or("normal"),
            assigned_agent_id: flatten(input.assigned_agent_id.as_ref()),
            created_by_agent_id: flatten(input.created_by_agent_id.as_ref()),
            workspace_id: non_empty(input.workspace_id.as_deref()).unwrap_or("default"),
            business_id: non_empty(input.business_id.as_deref()).unwrap_or("default"),
            due_date: flatten(input.due_date.as_ref()),
        };
        if let Err(error) = insert_new_task(&mut connection, &new_task) {
            if let Err(cleanup) = workspace::delete_task_workspace(root, &id) {
                tracing::error!(%cleanup, "failed to roll back task workspace after create error");
            }
            return Err(error.into());
        }
        find_task(&connection, &id)?.ok_or(TaskError::NotFound)
    }

    /// `updateTask`. Writes one event per status or assignee change and reports
    /// whether the caller should dispatch or auto-test.
    pub fn update_task(
        &self,
        id: &str,
        input: &UpdateTaskInput,
    ) -> Result<UpdateTaskResult, TaskError> {
        let connection = self.connection();
        let existing = find_task(&connection, id)?.ok_or(TaskError::NotFound)?;
        let now = now_iso();
        let requested = input.status.as_deref();
        let updated_by = input.updated_by_agent_id.as_deref();

        if approval_requested(&existing.status, requested, updated_by) {
            let updater = match updated_by {
                Some(agent_id) => find_agent(&connection, agent_id)?,
                None => None,
            };
            if !approval_allowed(updater.map(|agent| agent.is_master)) {
                return Err(TaskError::Forbidden(
                    "Forbidden: only the master agent can approve tasks".to_string(),
                ));
            }
        }

        let mut set_clauses: Vec<&'static str> = Vec::new();
        let mut values: Vec<Option<String>> = Vec::new();
        if let Some(title) = &input.title {
            set_clauses.push("title = ?");
            values.push(Some(title.clone()));
        }
        if let Some(description) = &input.description {
            set_clauses.push("description = ?");
            values.push(Some(description.clone()));
        }
        if let Some(priority) = &input.priority {
            set_clauses.push("priority = ?");
            values.push(Some(priority.clone()));
        }
        if let Some(due_date) = &input.due_date {
            set_clauses.push("due_date = ?");
            values.push(due_date.clone());
        }

        let mut should_dispatch = false;
        let mut should_auto_test = false;
        if let Some(status) = requested {
            if let Some(change) = plan_status_change(
                &existing.status,
                existing.assigned_agent_id.as_deref(),
                requested,
            ) {
                should_dispatch = change.dispatch;
                should_auto_test = change.auto_test;
                set_clauses.push("status = ?");
                values.push(Some(status.to_string()));
                connection.execute(
                    INSERT_EVENT,
                    params![
                        Uuid::new_v4().to_string(),
                        change.event_type,
                        None::<&str>,
                        id,
                        format!("Task \"{}\" moved to {status}", existing.title),
                        now
                    ],
                )?;
            }
        }

        if let Some(assigned) = &input.assigned_agent_id {
            let next = assigned.as_deref();
            if next != existing.assigned_agent_id.as_deref() {
                set_clauses.push("assigned_agent_id = ?");
                values.push(assigned.clone());
                if let Some(agent_id) = non_empty(next) {
                    if let Some(agent) = find_agent(&connection, agent_id)? {
                        connection.execute(
                            INSERT_EVENT,
                            params![
                                Uuid::new_v4().to_string(),
                                "task_assigned",
                                agent_id,
                                id,
                                format!("\"{}\" assigned to {}", existing.title, agent.name),
                                now
                            ],
                        )?;
                        if assignment_dispatch(&existing.status, requested) {
                            should_dispatch = true;
                        }
                    }
                }
            }
        }

        if set_clauses.is_empty() {
            return Err(TaskError::NoUpdates);
        }
        set_clauses.push("updated_at = ?");
        values.push(Some(now.clone()));
        values.push(Some(id.to_string()));
        let sql = format!("UPDATE tasks SET {} WHERE id = ?", set_clauses.join(", "));
        connection.execute(&sql, params_from_iter(values.iter()))?;

        let task = find_task(&connection, id)?;
        Ok(UpdateTaskResult {
            task,
            should_dispatch,
            should_auto_test,
            previous_title: existing.title,
        })
    }

    /// `deleteTask`: the sessions, events and task links go in one transaction with
    /// the row. The workspace directory is removed inside the same transaction.
    pub fn delete_task(&self, root: &Path, id: &str) -> Result<(), TaskError> {
        let mut connection = self.connection();
        if find_task(&connection, id)?.is_none() {
            return Err(TaskError::NotFound);
        }
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM betaclaw_sessions WHERE task_id = ?", [id])?;
        transaction.execute("DELETE FROM events WHERE task_id = ?", [id])?;
        transaction.execute(
            "UPDATE conversations SET task_id = NULL WHERE task_id = ?",
            [id],
        )?;
        transaction.execute("DELETE FROM tasks WHERE id = ?", [id])?;
        workspace::delete_task_workspace(root, id)?;
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::test_support::{insert_agent, insert_task, temp_root};
    use crate::tasks::types::TaskStatus;

    fn new_task(title: &str) -> CreateTaskInput {
        CreateTaskInput {
            title: title.to_string(),
            ..CreateTaskInput::default()
        }
    }

    fn event_message(repo: &TaskRepository, task_id: &str, event_type: &str) -> String {
        repo.connection()
            .query_row(
                "SELECT message FROM events WHERE task_id = ? AND type = ?",
                params![task_id, event_type],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn create_applies_defaults_and_writes_the_created_event() {
        let repo = TaskRepository::in_memory().unwrap();
        let root = temp_root("create");
        let task = repo.create_task(&root, &new_task("Write docs")).unwrap();
        assert_eq!(task.status, TaskStatus::Inbox.as_str());
        assert_eq!(task.priority, "normal");
        assert_eq!(task.workspace_id, "default");
        assert_eq!(task.business_id, "default");
        assert_eq!(
            event_message(&repo, &task.id, "task_created"),
            "New task: Write docs"
        );
        assert!(root
            .join(&task.id)
            .join(workspace::METADATA_FILENAME)
            .exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_names_the_creating_agent_in_the_event() {
        let repo = TaskRepository::in_memory().unwrap();
        insert_agent(&repo.connection(), "agent-1", "Builder", false, "standby");
        let root = temp_root("creator");
        let input = CreateTaskInput {
            created_by_agent_id: Some(Some("agent-1".to_string())),
            ..new_task("Ship it")
        };
        let task = repo.create_task(&root, &input).unwrap();
        assert_eq!(
            event_message(&repo, &task.id, "task_created"),
            "Builder created task: Ship it"
        );
        assert_eq!(task.created_by_agent_name.as_deref(), Some("Builder"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_filters_by_status_list_and_empty_workspace_ids() {
        let repo = TaskRepository::in_memory().unwrap();
        let root = temp_root("list");
        for (title, status) in [("a", "inbox"), ("b", "assigned"), ("c", "done")] {
            let input = CreateTaskInput {
                status: Some(status.to_string()),
                ..new_task(title)
            };
            repo.create_task(&root, &input).unwrap();
        }

        let all = repo.list_tasks(&TaskListFilters::default()).unwrap();
        assert_eq!(all.len(), 3);

        let filtered = repo
            .list_tasks(&TaskListFilters {
                status: Some("inbox, done".to_string()),
                ..TaskListFilters::default()
            })
            .unwrap();
        assert_eq!(filtered.len(), 2);

        let none = repo
            .list_tasks(&TaskListFilters {
                workspace_ids: Some(Vec::new()),
                ..TaskListFilters::default()
            })
            .unwrap();
        assert!(none.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn status_change_writes_an_event_and_flags_auto_test() {
        let repo = TaskRepository::in_memory().unwrap();
        let root = temp_root("status");
        let task = repo.create_task(&root, &new_task("Site")).unwrap();
        let result = repo
            .update_task(
                &task.id,
                &UpdateTaskInput {
                    status: Some("testing".to_string()),
                    ..UpdateTaskInput::default()
                },
            )
            .unwrap();
        assert!(result.should_auto_test);
        assert!(!result.should_dispatch);
        assert_eq!(result.previous_title, "Site");
        assert_eq!(result.task.unwrap().status, "testing");
        assert_eq!(
            event_message(&repo, &task.id, "task_status_changed"),
            "Task \"Site\" moved to testing"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn approval_to_done_needs_a_master_agent_when_an_updater_is_named() {
        let repo = TaskRepository::in_memory().unwrap();
        insert_agent(&repo.connection(), "worker", "Worker", false, "standby");
        insert_agent(&repo.connection(), "boss", "Boss", true, "standby");
        let root = temp_root("approval");
        let task = repo.create_task(&root, &new_task("Review me")).unwrap();
        repo.update_task(
            &task.id,
            &UpdateTaskInput {
                status: Some("review".to_string()),
                ..UpdateTaskInput::default()
            },
        )
        .unwrap();

        let by_worker = UpdateTaskInput {
            status: Some("done".to_string()),
            updated_by_agent_id: Some("worker".to_string()),
            ..UpdateTaskInput::default()
        };
        match repo.update_task(&task.id, &by_worker) {
            Err(TaskError::Forbidden(message)) => {
                assert_eq!(
                    message,
                    "Forbidden: only the master agent can approve tasks"
                );
            }
            other => panic!("expected Forbidden, got {other:?}"),
        }

        let by_boss = UpdateTaskInput {
            updated_by_agent_id: Some("boss".to_string()),
            ..by_worker
        };
        repo.update_task(&task.id, &by_boss).unwrap();
        assert_eq!(
            event_message(&repo, &task.id, "task_completed"),
            "Task \"Review me\" moved to done"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn assigning_an_agent_writes_an_event_and_dispatches_an_assigned_task() {
        let repo = TaskRepository::in_memory().unwrap();
        insert_agent(&repo.connection(), "builder", "Builder", false, "standby");
        let root = temp_root("assign");
        let task = repo.create_task(&root, &new_task("Build")).unwrap();
        let result = repo
            .update_task(
                &task.id,
                &UpdateTaskInput {
                    status: Some("assigned".to_string()),
                    assigned_agent_id: Some(Some("builder".to_string())),
                    ..UpdateTaskInput::default()
                },
            )
            .unwrap();
        assert!(result.should_dispatch);
        assert_eq!(
            event_message(&repo, &task.id, "task_assigned"),
            "\"Build\" assigned to Builder"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn update_without_changes_and_unknown_tasks_are_errors() {
        let repo = TaskRepository::in_memory().unwrap();
        let root = temp_root("errors");
        let task = repo.create_task(&root, &new_task("Noop")).unwrap();
        assert!(matches!(
            repo.update_task(&task.id, &UpdateTaskInput::default()),
            Err(TaskError::NoUpdates)
        ));
        assert!(matches!(
            repo.update_task("missing", &UpdateTaskInput::default()),
            Err(TaskError::NotFound)
        ));
        assert!(matches!(repo.get_task("missing"), Err(TaskError::NotFound)));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_removes_the_row_its_events_the_workspace_and_unlinks_conversations() {
        let repo = TaskRepository::in_memory().unwrap();
        let root = temp_root("delete");
        let task = repo.create_task(&root, &new_task("Gone")).unwrap();
        repo.connection()
            .execute(
                "INSERT INTO conversations (id, title, type, task_id) VALUES ('conv-1', 'x', 'task', ?)",
                [&task.id],
            )
            .unwrap();

        repo.delete_task(&root, &task.id).unwrap();

        assert!(repo.find_task(&task.id).unwrap().is_none());
        assert!(!root.join(&task.id).exists());
        let linked: Option<String> = repo
            .connection()
            .query_row(
                "SELECT task_id FROM conversations WHERE id = 'conv-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(linked, None);
        let events: i64 = repo
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM events WHERE task_id = ?",
                [&task.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(events, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn joined_agent_names_come_back_with_the_task() {
        let repo = TaskRepository::in_memory().unwrap();
        insert_agent(&repo.connection(), "agent-9", "Scout", false, "standby");
        insert_task(
            &repo.connection(),
            "task-9",
            "Scouting",
            "assigned",
            Some("agent-9"),
        );
        let task = repo.get_task("task-9").unwrap();
        assert_eq!(task.assigned_agent_name.as_deref(), Some("Scout"));
        assert_eq!(task.assigned_agent_id.as_deref(), Some("agent-9"));
    }
}
