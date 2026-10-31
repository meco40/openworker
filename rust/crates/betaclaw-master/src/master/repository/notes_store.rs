//! Port of `src/server/master/repository/notes.store.ts:1-84`.
//!
//! Four CRUD helpers over `master_notes`, scoped by `(user_id, workspace_id)`.
//!
//! # Screen/db
//!
//! The TypeScript takes the `MasterSqliteDb` as its first argument; the port
//! takes the `rusqlite::Connection` the same way. `crypto.randomUUID()` becomes
//! [`uuid::Uuid::new_v4`] and `nowIso()` comes from
//! [`crate::master::repository::helpers`].
//!
//! # Dynamic UPDATE
//!
//! `updateNote` builds the `SET` list from the keys that are present in the
//! patch and appends `updated_at = ?` last. The port keeps the same column
//! order and the same `id, user_id, workspace_id` predicate; the assignment list
//! is joined with `, ` exactly like `updates.join(', ')`.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};

use crate::master::repository::helpers::now_iso;
use crate::master::repository::mappers::to_note;
use crate::master::types::{MasterNote, WorkspaceScope};

/// `Partial<Pick<MasterNote, 'title' | 'content' | 'tags'>>` — `notes.store.ts:50`.
///
/// `Some` is "the key is present", mirroring `patch.x !== undefined`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotePatch {
    pub title: Option<String>,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
}

/// `createNote` from `notes.store.ts:7-33`.
pub fn create_note(
    connection: &Connection,
    scope: &WorkspaceScope,
    input: &MasterNoteInput,
) -> rusqlite::Result<MasterNote> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let tags = serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".to_string());
    connection.execute(
        "INSERT INTO master_notes (
           id, user_id, workspace_id, title, content, tags, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            scope.user_id,
            scope.workspace_id,
            input.title,
            input.content,
            tags,
            now,
            now,
        ],
    )?;
    let note = connection.query_row(
        "SELECT * FROM master_notes WHERE id = ?",
        params![id],
        to_note,
    )?;
    Ok(note)
}

/// `listNotes` from `notes.store.ts:35-44`.
pub fn list_notes(
    connection: &Connection,
    scope: &WorkspaceScope,
    limit: i64,
) -> rusqlite::Result<Vec<MasterNote>> {
    let mut statement = connection.prepare(
        "SELECT * FROM master_notes
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC LIMIT ?",
    )?;
    let rows = statement.query_map(params![scope.user_id, scope.workspace_id, limit], to_note)?;
    rows.collect()
}

/// `updateNote` from `notes.store.ts:46-77`.
pub fn update_note(
    connection: &Connection,
    scope: &WorkspaceScope,
    note_id: &str,
    patch: &NotePatch,
) -> rusqlite::Result<Option<MasterNote>> {
    let mut assignments: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    if let Some(title) = &patch.title {
        assignments.push("title = ?".to_string());
        values.push(Value::Text(title.clone()));
    }
    if let Some(content) = &patch.content {
        assignments.push("content = ?".to_string());
        values.push(Value::Text(content.clone()));
    }
    if let Some(tags) = &patch.tags {
        assignments.push("tags = ?".to_string());
        let encoded = serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string());
        values.push(Value::Text(encoded));
    }
    if assignments.is_empty() {
        return Ok(None);
    }
    assignments.push("updated_at = ?".to_string());
    values.push(Value::Text(now_iso()));
    values.push(Value::Text(note_id.to_string()));
    values.push(Value::Text(scope.user_id.clone()));
    values.push(Value::Text(scope.workspace_id.clone()));
    let sql = format!(
        "UPDATE master_notes SET {}
         WHERE id = ? AND user_id = ? AND workspace_id = ?",
        assignments.join(", ")
    );
    connection.execute(&sql, params_from_iter(values))?;
    let row = connection.query_row(
        "SELECT * FROM master_notes WHERE id = ? AND user_id = ? AND workspace_id = ?",
        params![note_id, scope.user_id, scope.workspace_id],
        to_note,
    );
    match row {
        Ok(note) => Ok(Some(note)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `deleteNote` from `notes.store.ts:79-84`.
pub fn delete_note(
    connection: &Connection,
    scope: &WorkspaceScope,
    note_id: &str,
) -> rusqlite::Result<bool> {
    let changes = connection.execute(
        "DELETE FROM master_notes WHERE id = ? AND user_id = ? AND workspace_id = ?",
        params![note_id, scope.user_id, scope.workspace_id],
    )?;
    Ok(changes > 0)
}

/// `Omit<MasterNote, 'id' | 'userId' | 'workspaceId' | 'createdAt' | 'updatedAt'>`
/// — `notes.store.ts:10`.
pub struct MasterNoteInput {
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
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

    #[test]
    fn create_list_update_delete_round_trip() {
        let connection = setup();
        let created = create_note(
            &connection,
            &scope(),
            &MasterNoteInput {
                title: "T".to_string(),
                content: "B".to_string(),
                tags: vec!["x".to_string()],
            },
        )
        .unwrap();
        assert_eq!(created.tags, vec!["x".to_string()]);

        let listed = list_notes(&connection, &scope(), 100).unwrap();
        assert_eq!(listed.len(), 1);

        let patch = NotePatch {
            title: Some("T2".to_string()),
            content: None,
            tags: Some(vec!["y".to_string(), "z".to_string()]),
        };
        let updated = update_note(&connection, &scope(), &created.id, &patch)
            .unwrap()
            .unwrap();
        assert_eq!(updated.title, "T2");
        assert_eq!(updated.content, "B");
        assert_eq!(updated.tags, vec!["y".to_string(), "z".to_string()]);

        assert!(delete_note(&connection, &scope(), &created.id).unwrap());
        assert!(list_notes(&connection, &scope(), 100).unwrap().is_empty());
    }

    #[test]
    fn empty_patch_is_a_no_op_returning_none() {
        let connection = setup();
        let created = create_note(
            &connection,
            &scope(),
            &MasterNoteInput {
                title: "T".to_string(),
                content: "B".to_string(),
                tags: Vec::new(),
            },
        )
        .unwrap();
        assert!(
            update_note(&connection, &scope(), &created.id, &NotePatch::default())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn scope_isolation_hides_other_workspaces() {
        let connection = setup();
        let created = create_note(
            &connection,
            &scope(),
            &MasterNoteInput {
                title: "T".to_string(),
                content: "B".to_string(),
                tags: Vec::new(),
            },
        )
        .unwrap();
        let other = WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w2".to_string(),
        };
        assert!(list_notes(&connection, &other, 100).unwrap().is_empty());
        assert!(!delete_note(&connection, &other, &created.id).unwrap());
    }
}
