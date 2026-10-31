//! Port of `src/server/master/repository/reminders.store.ts:1-94`.
//!
//! CRUD over `master_reminders`, scoped by `(user_id, workspace_id)`.
//! `updateReminder` builds its `SET` list from the fixed key→column map in
//! source order (`title, message, remindAt, cronExpression, status`); a key that
//! is absent is skipped, and a nullable field that is present with value `null`
//! still writes `NULL` (`patch[key] ?? null`). The port models "absent" as
//! `None` and "present" as `Some(..)`, with `Option<Option<String>>` for the
//! nullable `cron_expression`.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::to_reminder;
use crate::master::types::{MasterReminder, WorkspaceScope};

/// `Omit<MasterReminder, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>`
/// — `reminders.store.ts:10`.
pub struct MasterReminderInput {
    pub title: String,
    pub message: String,
    pub remind_at: String,
    pub cron_expression: Option<String>,
    pub status: String,
}

/// `Partial<MasterReminder>` — `reminders.store.ts:56`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReminderPatch {
    pub title: Option<String>,
    pub message: Option<String>,
    pub remind_at: Option<String>,
    /// Outer `Some` is "present"; inner `None` is an explicit `null`.
    pub cron_expression: Option<Option<String>>,
    pub status: Option<String>,
}

/// `createReminder` from `reminders.store.ts:7-35`.
pub fn create_reminder(
    connection: &Connection,
    scope: &WorkspaceScope,
    input: &MasterReminderInput,
) -> rusqlite::Result<MasterReminder> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    connection.execute(
        "INSERT INTO master_reminders (
           id, user_id, workspace_id, title, message, remind_at, cron_expression, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            scope.user_id,
            scope.workspace_id,
            input.title,
            input.message,
            input.remind_at,
            input.cron_expression,
            input.status,
            now,
            now,
        ],
    )?;
    connection.query_row(
        "SELECT * FROM master_reminders WHERE id = ?",
        params![id],
        to_reminder,
    )
}

/// `listReminders` from `reminders.store.ts:37-50`.
pub fn list_reminders(
    connection: &Connection,
    scope: &WorkspaceScope,
    limit: i64,
) -> rusqlite::Result<Vec<MasterReminder>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_reminders
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY remind_at ASC LIMIT ?",
    )?;
    let rows = statement.query_map(
        params![scope.user_id, scope.workspace_id, limit],
        to_reminder,
    )?;
    rows.collect()
}

/// `updateReminder` from `reminders.store.ts:52-83`.
pub fn update_reminder(
    connection: &Connection,
    scope: &WorkspaceScope,
    reminder_id: &str,
    patch: &ReminderPatch,
) -> rusqlite::Result<Option<MasterReminder>> {
    let mut assignments: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(title) = &patch.title {
        assignments.push("title = ?".to_string());
        values.push(Value::Text(title.clone()));
    }
    if let Some(message) = &patch.message {
        assignments.push("message = ?".to_string());
        values.push(Value::Text(message.clone()));
    }
    if let Some(remind_at) = &patch.remind_at {
        assignments.push("remind_at = ?".to_string());
        values.push(Value::Text(remind_at.clone()));
    }
    if let Some(cron_expression) = &patch.cron_expression {
        assignments.push("cron_expression = ?".to_string());
        values.push(match cron_expression {
            Some(value) => Value::Text(value.clone()),
            None => Value::Null,
        });
    }
    if let Some(status) = &patch.status {
        assignments.push("status = ?".to_string());
        values.push(Value::Text(status.clone()));
    }
    if assignments.is_empty() {
        return Ok(None);
    }
    assignments.push("updated_at = ?".to_string());
    values.push(Value::Text(now_iso()));
    values.push(Value::Text(reminder_id.to_string()));
    values.push(Value::Text(scope.user_id.clone()));
    values.push(Value::Text(scope.workspace_id.clone()));
    let sql = format!(
        "UPDATE master_reminders SET {}
         WHERE id = ? AND user_id = ? AND workspace_id = ?",
        assignments.join(", ")
    );
    connection.execute(&sql, params_from_iter(values))?;
    let row = connection.query_row(
        "SELECT * FROM master_reminders WHERE id = ? AND user_id = ? AND workspace_id = ?",
        params![reminder_id, scope.user_id, scope.workspace_id],
        to_reminder,
    );
    match row {
        Ok(reminder) => Ok(Some(reminder)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `deleteReminder` from `reminders.store.ts:85-94`.
pub fn delete_reminder(
    connection: &Connection,
    scope: &WorkspaceScope,
    reminder_id: &str,
) -> rusqlite::Result<bool> {
    let changes = connection.execute(
        "DELETE FROM master_reminders WHERE id = ? AND user_id = ? AND workspace_id = ?",
        params![reminder_id, scope.user_id, scope.workspace_id],
    )?;
    Ok(changes > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open, OpenOptions};
    use crate::master::migrations::run_master_migrations;

    fn setup() -> Connection {
        let connection = open(OpenOptions::new(":memory:")).unwrap();
        run_master_migrations(&connection).unwrap();
        connection
    }

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn input() -> MasterReminderInput {
        MasterReminderInput {
            title: "T".to_string(),
            message: "M".to_string(),
            remind_at: "2026-01-01T00:00:00.000Z".to_string(),
            cron_expression: None,
            status: "pending".to_string(),
        }
    }

    #[test]
    fn create_and_list() {
        let connection = setup();
        let created = create_reminder(&connection, &scope(), &input()).unwrap();
        assert_eq!(created.status, "pending");
        assert!(created.cron_expression.is_none());
        assert_eq!(list_reminders(&connection, &scope(), 100).unwrap().len(), 1);
    }

    #[test]
    fn update_writes_only_present_keys_and_null_for_explicit_null() {
        let connection = setup();
        let created = create_reminder(&connection, &scope(), &input()).unwrap();
        let updated = update_reminder(
            &connection,
            &scope(),
            &created.id,
            &ReminderPatch {
                status: Some("fired".to_string()),
                cron_expression: Some(None),
                ..ReminderPatch::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.status, "fired");
        assert_eq!(updated.message, "M");
        assert!(updated.cron_expression.is_none());
    }

    #[test]
    fn empty_patch_returns_none() {
        let connection = setup();
        let created = create_reminder(&connection, &scope(), &input()).unwrap();
        assert!(update_reminder(
            &connection,
            &scope(),
            &created.id,
            &ReminderPatch::default()
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn delete_reports_changes() {
        let connection = setup();
        let created = create_reminder(&connection, &scope(), &input()).unwrap();
        assert!(delete_reminder(&connection, &scope(), &created.id).unwrap());
        assert!(!delete_reminder(&connection, &scope(), &created.id).unwrap());
    }
}
