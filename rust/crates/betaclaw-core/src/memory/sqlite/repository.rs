//! Port of `src/server/memory/sqliteMemoryRepository.ts`.
//!
//! | TypeScript                                            | Rust |
//! | ----------------------------------------------------- | ---- |
//! | `sqliteMemoryRepository.ts:11-21` (`MemoryRow`)        | the private column readers of [`to_node`] |
//! | `sqliteMemoryRepository.ts:36-49` (`toNode`)           | [`to_node`] |
//! | `sqliteMemoryRepository.ts:51-59` (constructor)        | [`SqliteMemoryRepository::open`], [`SqliteMemoryRepository::open_default`] |
//! | `sqliteMemoryRepository.ts:61-118` (`migrate`)         | [`run_migrations`](super::migrations::run_migrations) |
//! | `sqliteMemoryRepository.ts:120-123` (`resolveUserId`)  | [`resolve_user_id`](crate::memory::validators::resolve_user_id) |
//! | `sqliteMemoryRepository.ts:125-130` (`hasColumn`)      | [`has_column`](super::migrations::has_column) |
//! | `sqliteMemoryRepository.ts:132-140` (`listNodes`)      | [`SqliteMemoryRepository::list_nodes`] |
//! | `sqliteMemoryRepository.ts:142-185` (`listNodesPage`)  | [`SqliteMemoryRepository::list_nodes_page`] |
//! | `sqliteMemoryRepository.ts:187-210` (`listAllNodes*`)  | [`SqliteMemoryRepository::list_all_nodes`], [`SqliteMemoryRepository::list_all_nodes_with_scope`] |
//! | `sqliteMemoryRepository.ts:212-238` (`insertNode`)     | [`SqliteMemoryRepository::insert_node`] |
//! | `sqliteMemoryRepository.ts:240-267` (`updateNode`)     | [`SqliteMemoryRepository::update_node`] |
//! | `sqliteMemoryRepository.ts:269-279` (`getNodeById`)    | [`SqliteMemoryRepository::get_node_by_id`] |
//! | `sqliteMemoryRepository.ts:281-301` (`listNodeHistory`)| [`SqliteMemoryRepository::list_node_history`] |
//! | `sqliteMemoryRepository.ts:303-310` (`appendHistory`)  | [`SqliteMemoryRepository::append_history`] |
//! | `sqliteMemoryRepository.ts:312-318` (`deleteNode`)     | [`SqliteMemoryRepository::delete_node`] |
//! | `sqliteMemoryRepository.ts:320-359` (`updateMany`)     | [`SqliteMemoryRepository::update_many`] |
//! | `sqliteMemoryRepository.ts:361-377` (`deleteMany`)     | [`SqliteMemoryRepository::delete_many`] |
//! | `sqliteMemoryRepository.ts:379-385` (`deleteByPersona`)| [`SqliteMemoryRepository::delete_by_persona`] |
//! | `sqliteMemoryRepository.ts:387-503` (`getStorageSnapshot`) | [`SqliteMemoryRepository::get_storage_snapshot`] |
//! | `sqliteMemoryRepository.ts:54-55` (database path)      | [`default_memory_db_path`] |
//! | `memory/repository.ts:15-34` (`MemoryRepository`)      | [`MemoryRepository`] |
//! | `memory/repository.ts:26-31` (inline update object)    | [`MemoryNodeUpdates`] |
//!
//! The row shapes, the history row and the storage snapshot come from
//! [`crate::memory::types`]; none of them is redefined here.
//!
//! # Statement parity
//!
//! Every statement is the TypeScript string with the same `WHERE` clauses, the
//! same `ORDER BY` and the same `LIMIT`/`OFFSET` binding order, so both
//! implementations keep reading the same `.local/messages.db`. `SELECT *` stays
//! `SELECT *` (the readers address columns by name, exactly like `row.id` does),
//! and the two bulk mutations still run inside one transaction, so a failing
//! member rolls the whole batch back.
//! # Tolerant coercions
//!
//! The columns carry SQLite's dynamic types, not the declared ones, and the
//! TypeScript reader leans on that:
//!
//! | Column | TypeScript | Rust |
//! | --- | --- | --- |
//! | `embedding_json` | `row.embedding_json ? JSON.parse(…) : []` | empty text/`NULL` → `[]`, otherwise `serde_json::from_str::<Vec<f64>>` |
//! | `metadata_json` | `row.metadata_json ? JSON.parse(…) : undefined` | empty text/`NULL` → `None`, otherwise a JSON object |
//! | `importance`, `confidence` | `row.importance` verbatim | `Number()` coercion ([`js_number`]) |
//! | `id`, `type`, `content`, `timestamp`, `user_id`, `persona_id` | `row.x` verbatim | `String()` coercion ([`js_string`]) |
//! | every count/byte column | `Number(x \|\| 0)` | `Option<i64>` with a `0` fallback |
//!
//! # Deviations
//!
//! 1. **Errors instead of exceptions.** The TypeScript throws and the caller sees
//!    a rejected call; the port returns `Result<_, MemoryError>` with the same
//!    messages ([`MemoryError::message`] for the client-level errors, the `From`
//!    conversions of [`crate::memory::errors`] for a failed statement).
//! 2. **`type` is an enum.** `row.type as MemoryNode['type']` is a compile-time
//!    cast through which any text survives. `MemoryNode::node_type` is a closed
//!    [`MemoryType`], so the port reads through
//!    [`as_memory_type`](crate::memory::validators::as_memory_type) and an
//!    unknown spelling becomes `fact` — the fallback every other reader of this
//!    slice applies.
//! 3. **`metadata_json` must hold an object.** The TypeScript returns whatever
//!    `JSON.parse` produced and only fails later, when the value is used as a
//!    bag; [`MemoryMetadata`] *is* a JSON object, so a scalar or an array is a
//!    `MemoryError::Storage` here instead of a silently wrong node.
//! 4. **`embedding_json` must hold a numeric array.** The source casts to
//!    `number[]` and keeps junk; the port parses into `Vec<f64>` and errors.
//! 5. **Blobs.** A `BLOB` in a text column reaches the TypeScript as a `Buffer`
//!    (`JSON.parse` then throws a `SyntaxError`); the port reports
//!    `MemoryError::Storage` naming the value it could not read.
//! 6. **`NaN`/`Infinity` reals.** `serde_json::Number` cannot hold them, so such
//!    a `REAL` reads back as `Number(null)` (`0`) resp. `String(null)` (`''`)
//!    instead of `Number(NaN)`/`String(NaN)`. The repository never writes one on
//!    its own.
//! 7. **`Math.floor` on the page arguments** is the identity function here:
//!    [`MemoryListPageInput`] carries `i64`, and a JavaScript `NaN` page has no
//!    representation at all.
//! 8. **Float rendering in the stored text.** `JSON.stringify([3])` writes `[3]`,
//!    `serde_json` writes `[3.0]`; an integral embedding entry therefore costs
//!    two bytes more and the snapshot byte accounting differs by that amount for
//!    such rows. The parsed value is identical.
//! 9. **Integer-like metadata keys.** `JSON.stringify` emits canonical array
//!    indices (`"0"`, `"1"`, …) in ascending numeric order *before* the other
//!    keys; `serde_json` with `preserve_order` keeps insertion order. The JSON is
//!    equivalent, the byte sequence is not, for a bag that has such a key.
//! 10. **`MEMORY_DB_PATH` whitespace.** `"  "` is truthy in JavaScript and would
//!     become the path verbatim; [`default_memory_db_path`] trims and drops it
//!     like [`default_messages_db_path`](crate::messages_store::default_messages_db_path)
//!     does, because both must resolve to the same file.

use std::collections::HashSet;

use rusqlite::types::Value as SqliteValue;
use rusqlite::{params, params_from_iter, Connection, Row};
use serde_json::Value;

use crate::db::{default_db_path, open, OpenOptions};
use crate::memory::errors::MemoryError;
use crate::memory::types::{
    js_number, js_string, MemoryListPageInput, MemoryListPageResult, MemoryMetadata, MemoryNode,
    MemoryNodeHistoryRow, MemoryNodeWithScope, MemoryStorageByType, MemoryStorageNodeSize,
    MemoryStorageSnapshot, MemoryStorageSummary, MemoryType,
};
use crate::memory::utils::now_iso;
use crate::memory::validators::{as_memory_type, resolve_user_id};

use super::migrations::run_migrations;

/// `toNode(row)` from `sqliteMemoryRepository.ts:36-49`.
fn to_node(row: &Row<'_>) -> Result<MemoryNode, MemoryError> {
    Ok(MemoryNode {
        id: text_column(row, "id")?,
        node_type: memory_type_column(row, "type")?,
        content: text_column(row, "content")?,
        embedding: embedding_column(row, "embedding_json")?,
        importance: number_column(row, "importance")?,
        confidence: number_column(row, "confidence")?,
        timestamp: text_column(row, "timestamp")?,
        metadata: metadata_column(row, "metadata_json")?,
    })
}

/// `{ node: toNode(row), userId: row.user_id, personaId: row.persona_id }` —
/// `sqliteMemoryRepository.ts:202-209` and `:274-278`.
fn to_scoped_node(row: &Row<'_>) -> Result<MemoryNodeWithScope, MemoryError> {
    Ok(MemoryNodeWithScope {
        node: to_node(row)?,
        user_id: text_column(row, "user_id")?,
        persona_id: text_column(row, "persona_id")?,
    })
}

/// Reads a column as the JSON value the TypeScript reader would see.
///
/// SQLite hands back the *stored* type: an `INTEGER` in a `TEXT` column is a
/// number in better-sqlite3 as well, which is why every reader below runs the
/// same `String()`/`Number()` coercion the JavaScript call sites do (see the
/// module header). A `BLOB` is the only value the port refuses: JavaScript would
/// hand out a `Buffer` and only a later use would fail.
fn column_value(row: &Row<'_>, name: &str) -> Result<Value, MemoryError> {
    let value: SqliteValue = row.get(name)?;
    match value {
        SqliteValue::Null => Ok(Value::Null),
        SqliteValue::Integer(number) => Ok(Value::Number(number.into())),
        // `serde_json::Number` has no `NaN`/`Infinity`; the module header lists
        // the resulting (documented) divergence.
        SqliteValue::Real(number) => Ok(serde_json::Number::from_f64(number)
            .map(Value::Number)
            .unwrap_or(Value::Null)),
        SqliteValue::Text(text) => Ok(Value::String(text)),
        SqliteValue::Blob(bytes) => Err(MemoryError::storage(format!(
            "{name} holds a {}-byte BLOB in a text column",
            bytes.len()
        ))),
    }
}

/// `String(row.<name> || '')` through the shared JavaScript coercion.
fn text_column(row: &Row<'_>, name: &str) -> Result<String, MemoryError> {
    Ok(js_string(Some(&column_value(row, name)?)))
}

/// `Number(row.<name>)` through the shared JavaScript coercion.
fn number_column(row: &Row<'_>, name: &str) -> Result<f64, MemoryError> {
    Ok(js_number(Some(&column_value(row, name)?)))
}

/// `row.type as MemoryNode['type']`, reduced to the closed [`MemoryType`].
fn memory_type_column(row: &Row<'_>, name: &str) -> Result<MemoryType, MemoryError> {
    Ok(as_memory_type(Some(&column_value(row, name)?)))
}

/// `row.embedding_json ? JSON.parse(row.embedding_json) : []`.
fn embedding_column(row: &Row<'_>, name: &str) -> Result<Vec<f64>, MemoryError> {
    let text = text_column(row, name)?;
    if text.is_empty() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_str::<Vec<f64>>(&text)?)
}

/// `row.metadata_json ? JSON.parse(row.metadata_json) : undefined`.
fn metadata_column(row: &Row<'_>, name: &str) -> Result<Option<MemoryMetadata>, MemoryError> {
    let text = text_column(row, name)?;
    if text.is_empty() {
        return Ok(None);
    }
    Ok(Some(parse_metadata_object(&text)?))
}

/// `JSON.parse(text) as Record<string, unknown>` for the object case.
fn parse_metadata_object(text: &str) -> Result<MemoryMetadata, MemoryError> {
    match serde_json::from_str::<Value>(text)? {
        Value::Object(map) => Ok(map),
        other => Err(MemoryError::storage(format!(
            "metadata JSON is not an object: {other}"
        ))),
    }
}

/// `Array.from(new Set(nodeIds.map((id) => id.trim()).filter(Boolean)))`.
///
/// The `Set` keeps the first occurrence's position, which the `Vec` reproduces.
fn normalize_node_ids(node_ids: &[String]) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut normalized = Vec::with_capacity(node_ids.len());
    for raw in node_ids {
        let trimmed = raw.trim();
        if trimmed.is_empty() || !seen.insert(trimmed) {
            continue;
        }
        normalized.push(trimmed.to_string());
    }
    normalized
}

// The provider contract lives in `crate::memory::repository` (open point
// OP-15). It is re-exported here under its original path so existing callers and
// `crate::memory::sqlite::repository` imports keep working unchanged.
pub use crate::memory::repository::{MemoryNodeUpdates, MemoryRepository};

/// `SqliteMemoryRepository` from `sqliteMemoryRepository.ts:51`.
pub struct SqliteMemoryRepository {
    connection: Connection,
    db_path: String,
}

impl SqliteMemoryRepository {
    /// `new SqliteMemoryRepository(dbPath)` — `sqliteMemoryRepository.ts:54-59`.
    ///
    /// Opens through [`crate::db::open`] (the shared pragma set) and runs
    /// [`run_migrations`] immediately, exactly like the constructor.
    pub fn open(db_path: &str) -> Result<Self, MemoryError> {
        let connection = open(OpenOptions::new(db_path))?;
        run_migrations(&connection)?;
        Ok(Self {
            connection,
            db_path: db_path.to_string(),
        })
    }

    /// The constructor's default argument, `sqliteMemoryRepository.ts:55`.
    pub fn open_default() -> Result<Self, MemoryError> {
        Self::open(&default_memory_db_path())
    }

    /// Dropping the connection is what `close()` would do.
    pub fn close(self) {
        drop(self.connection);
    }

    pub fn db_path(&self) -> &str {
        &self.db_path
    }

    /// Read-only access for the migration and parity checks.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    // ─── Readers ───────────────────────────────────────────────────────────

    /// `listNodes(personaId, userId?)` — `sqliteMemoryRepository.ts:132-140`.
    pub fn list_nodes(
        &self,
        persona_id: &str,
        user_id: Option<&str>,
    ) -> Result<Vec<MemoryNode>, MemoryError> {
        let scoped_user_id = resolve_user_id(user_id);
        self.query_nodes(
            "SELECT * FROM memory_nodes WHERE user_id = ? AND persona_id = ? ORDER BY importance DESC, updated_at DESC",
            vec![
                SqliteValue::Text(scoped_user_id),
                SqliteValue::Text(persona_id.to_string()),
            ],
        )
    }

    /// `listNodesPage(personaId, input, userId?)` — `sqliteMemoryRepository.ts:142-185`.
    pub fn list_nodes_page(
        &self,
        persona_id: &str,
        input: &MemoryListPageInput,
        user_id: Option<&str>,
    ) -> Result<MemoryListPageResult, MemoryError> {
        let scoped_user_id = resolve_user_id(user_id);
        let page = input.page.max(1);
        let page_size = input.page_size.clamp(1, 200);
        let offset = (page - 1) * page_size;

        let mut conditions = vec!["user_id = ?".to_string(), "persona_id = ?".to_string()];
        let mut values = vec![
            SqliteValue::Text(scoped_user_id),
            SqliteValue::Text(persona_id.to_string()),
        ];

        if let Some(node_type) = input.node_type {
            conditions.push("type = ?".to_string());
            values.push(SqliteValue::Text(node_type.as_str().to_string()));
        }
        if let Some(query) = input.query.as_deref() {
            let trimmed = query.trim();
            if !trimmed.is_empty() {
                conditions.push("(content LIKE ? OR type LIKE ?)".to_string());
                let needle = SqliteValue::Text(format!("%{trimmed}%"));
                values.push(needle.clone());
                values.push(needle);
            }
        }

        let where_clause = format!("WHERE {}", conditions.join(" AND "));
        let count_sql = format!("SELECT COUNT(*) as total FROM memory_nodes {where_clause}");
        let total: Option<i64> =
            self.connection
                .query_row(&count_sql, params_from_iter(values.clone()), |row| {
                    row.get("total")
                })?;

        let list_sql = format!(
            "
      SELECT *
      FROM memory_nodes
      {where_clause}
      ORDER BY importance DESC, updated_at DESC
      LIMIT ? OFFSET ?
    "
        );
        let mut list_values = values;
        list_values.push(SqliteValue::Integer(page_size));
        list_values.push(SqliteValue::Integer(offset));

        Ok(MemoryListPageResult {
            nodes: self.query_nodes(&list_sql, list_values)?,
            total: total.unwrap_or(0),
        })
    }

    /// `listAllNodes(userId?)` — `sqliteMemoryRepository.ts:187-189`.
    pub fn list_all_nodes(&self, user_id: Option<&str>) -> Result<Vec<MemoryNode>, MemoryError> {
        Ok(self
            .list_all_nodes_with_scope(user_id)?
            .into_iter()
            .map(|entry| entry.node)
            .collect())
    }

    /// `listAllNodesWithScope(userId?)` — `sqliteMemoryRepository.ts:191-210`.
    ///
    /// The branch tests the truthiness of the *raw* argument, not of the resolved
    /// user id: `listAllNodesWithScope('')` reads every row, while `'   '` is
    /// truthy in JavaScript and therefore reads the legacy-local rows.
    pub fn list_all_nodes_with_scope(
        &self,
        user_id: Option<&str>,
    ) -> Result<Vec<MemoryNodeWithScope>, MemoryError> {
        let scoped_user_id = resolve_user_id(user_id);
        let scoped = matches!(user_id, Some(value) if !value.is_empty());
        if scoped {
            self.query_scoped_nodes(
                "SELECT * FROM memory_nodes WHERE user_id = ? ORDER BY importance DESC, updated_at DESC",
                vec![SqliteValue::Text(scoped_user_id)],
            )
        } else {
            self.query_scoped_nodes(
                "SELECT * FROM memory_nodes ORDER BY importance DESC, updated_at DESC",
                Vec::new(),
            )
        }
    }

    // ─── Writers ───────────────────────────────────────────────────────────

    /// `insertNode(personaId, node, userId?)` — `sqliteMemoryRepository.ts:212-238`.
    ///
    /// `created_at` and `updated_at` share one `new Date().toISOString()` stamp,
    /// and the row is followed by an `add` history entry.
    pub fn insert_node(
        &self,
        persona_id: &str,
        node: &MemoryNode,
        user_id: Option<&str>,
    ) -> Result<(), MemoryError> {
        let scoped_user_id = resolve_user_id(user_id);
        let now = now_iso();
        self.connection.execute(
            "
        INSERT INTO memory_nodes (
          id, user_id, persona_id, type, content, embedding_json, importance, confidence, timestamp, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ",
            params![
                node.id,
                scoped_user_id,
                persona_id,
                node.node_type.as_str(),
                node.content,
                embedding_json(node)?,
                node.importance,
                node.confidence,
                node.timestamp,
                metadata_json(node)?,
                now,
                now,
            ],
        )?;
        self.append_history(&node.id, "add", node, &now)
    }

    /// `updateNode(personaId, node, userId?)` — `sqliteMemoryRepository.ts:240-267`.
    ///
    /// The history entry is only appended when the `UPDATE` touched a row; an
    /// unmatched update is a silent no-op, like the source.
    pub fn update_node(
        &self,
        persona_id: &str,
        node: &MemoryNode,
        user_id: Option<&str>,
    ) -> Result<(), MemoryError> {
        let scoped_user_id = resolve_user_id(user_id);
        let now = now_iso();
        let changed = self.connection.execute(
            "
        UPDATE memory_nodes
        SET type = ?, content = ?, embedding_json = ?, importance = ?, confidence = ?, timestamp = ?, metadata_json = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND persona_id = ?
      ",
            params![
                node.node_type.as_str(),
                node.content,
                embedding_json(node)?,
                node.importance,
                node.confidence,
                node.timestamp,
                metadata_json(node)?,
                now,
                node.id,
                scoped_user_id,
                persona_id,
            ],
        )?;
        if changed > 0 {
            self.append_history(&node.id, "update", node, &now)?;
        }
        Ok(())
    }

    /// `appendHistory(nodeId, action, node, timestamp)` —
    /// `sqliteMemoryRepository.ts:303-310`.
    ///
    /// `JSON.stringify(node.metadata || {})`: an absent bag is stored as `{}`.
    fn append_history(
        &self,
        node_id: &str,
        action: &str,
        node: &MemoryNode,
        timestamp: &str,
    ) -> Result<(), MemoryError> {
        let metadata = node.metadata.clone().unwrap_or_default();
        self.connection.execute(
            "INSERT INTO memory_node_history (node_id, action, timestamp, content, metadata_json)
         VALUES (?, ?, ?, ?, ?)",
            params![
                node_id,
                action,
                timestamp,
                node.content,
                serde_json::to_string(&metadata)?
            ],
        )?;
        Ok(())
    }

    /// `getNodeById(nodeId)` — `sqliteMemoryRepository.ts:269-279`.
    pub fn get_node_by_id(
        &self,
        node_id: &str,
    ) -> Result<Option<MemoryNodeWithScope>, MemoryError> {
        let mut statement = self
            .connection
            .prepare("SELECT * FROM memory_nodes WHERE id = ? LIMIT 1")?;
        let mut rows = statement.query(params![node_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(to_scoped_node(row)?)),
            None => Ok(None),
        }
    }

    /// `listNodeHistory(nodeId)` — `sqliteMemoryRepository.ts:281-301`.
    ///
    /// `JSON.parse(row.metadata_json || '{}')`: an empty or `NULL` column reads
    /// back as an empty bag.
    pub fn list_node_history(
        &self,
        node_id: &str,
    ) -> Result<Vec<MemoryNodeHistoryRow>, MemoryError> {
        let mut statement = self.connection.prepare(
            "SELECT action, timestamp, content, metadata_json
         FROM memory_node_history
         WHERE node_id = ?
         ORDER BY id ASC",
        )?;
        let mut rows = statement.query(params![node_id])?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next()? {
            let raw_metadata = text_column(row, "metadata_json")?;
            entries.push(MemoryNodeHistoryRow {
                action: text_column(row, "action")?,
                timestamp: text_column(row, "timestamp")?,
                content: text_column(row, "content")?,
                metadata: if raw_metadata.is_empty() {
                    MemoryMetadata::new()
                } else {
                    parse_metadata_object(&raw_metadata)?
                },
            });
        }
        Ok(entries)
    }

    /// `deleteNode(personaId, nodeId, userId?)` — `sqliteMemoryRepository.ts:312-318`.
    pub fn delete_node(
        &self,
        persona_id: &str,
        node_id: &str,
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError> {
        let scoped_user_id = resolve_user_id(user_id);
        let changed = self.connection.execute(
            "DELETE FROM memory_nodes WHERE user_id = ? AND persona_id = ? AND id = ?",
            params![scoped_user_id, persona_id, node_id],
        )?;
        Ok(changed as i64)
    }

    /// `updateMany(personaId, nodeIds, updates, userId?)` —
    /// `sqliteMemoryRepository.ts:320-359`.
    ///
    /// The set clause is built from the keys that are present, `updated_at` is
    /// always appended last, and the whole batch runs in one transaction whose
    /// affected-row counts are summed.
    pub fn update_many(
        &self,
        persona_id: &str,
        node_ids: &[String],
        updates: &MemoryNodeUpdates,
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError> {
        let scoped_user_id = resolve_user_id(user_id);
        let ids = normalize_node_ids(node_ids);
        if ids.is_empty() {
            return Ok(0);
        }

        let mut set_clauses: Vec<&str> = Vec::new();
        let mut set_values: Vec<SqliteValue> = Vec::new();
        if let Some(node_type) = updates.node_type {
            set_clauses.push("type = ?");
            set_values.push(SqliteValue::Text(node_type.as_str().to_string()));
        }
        if let Some(importance) = updates.importance {
            set_clauses.push("importance = ?");
            set_values.push(SqliteValue::Real(importance));
        }
        if set_clauses.is_empty() {
            return Ok(0);
        }
        set_clauses.push("updated_at = ?");
        set_values.push(SqliteValue::Text(now_iso()));

        let sql = format!(
            "
      UPDATE memory_nodes
      SET {}
      WHERE user_id = ? AND persona_id = ? AND id = ?
    ",
            set_clauses.join(", ")
        );

        let transaction = self.connection.unchecked_transaction()?;
        let mut changes: i64 = 0;
        {
            let mut statement = transaction.prepare(&sql)?;
            for id in &ids {
                let mut values = set_values.clone();
                values.push(SqliteValue::Text(scoped_user_id.clone()));
                values.push(SqliteValue::Text(persona_id.to_string()));
                values.push(SqliteValue::Text(id.clone()));
                changes += statement.execute(params_from_iter(values))? as i64;
            }
        }
        transaction.commit()?;
        Ok(changes)
    }

    /// `deleteMany(personaId, nodeIds, userId?)` — `sqliteMemoryRepository.ts:361-377`.
    pub fn delete_many(
        &self,
        persona_id: &str,
        node_ids: &[String],
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError> {
        let scoped_user_id = resolve_user_id(user_id);
        let ids = normalize_node_ids(node_ids);
        if ids.is_empty() {
            return Ok(0);
        }

        let transaction = self.connection.unchecked_transaction()?;
        let mut changes: i64 = 0;
        {
            let mut statement = transaction.prepare(
                "DELETE FROM memory_nodes WHERE user_id = ? AND persona_id = ? AND id = ?",
            )?;
            for id in &ids {
                changes += statement.execute(params![scoped_user_id, persona_id, id])? as i64;
            }
        }
        transaction.commit()?;
        Ok(changes)
    }

    /// `deleteByPersona(personaId, userId?)` — `sqliteMemoryRepository.ts:379-385`.
    pub fn delete_by_persona(
        &self,
        persona_id: &str,
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError> {
        let scoped_user_id = resolve_user_id(user_id);
        let changed = self.connection.execute(
            "DELETE FROM memory_nodes WHERE user_id = ? AND persona_id = ?",
            params![scoped_user_id, persona_id],
        )?;
        Ok(changed as i64)
    }

    /// `getStorageSnapshot(limit = 5, personaId?)` —
    /// `sqliteMemoryRepository.ts:387-503`.
    ///
    /// `limit` mirrors the default argument: `None` (argument omitted) means `5`,
    /// a non-finite value also falls back to `5`, and a finite value is floored
    /// and clamped to `1..=50`. The three statements measure bytes with
    /// `LENGTH(CAST(x AS BLOB))` and coalesce the `SUM` of an empty selection to
    /// `0`, like the source.
    pub fn get_storage_snapshot(
        &self,
        limit: Option<f64>,
        persona_id: Option<&str>,
    ) -> Result<MemoryStorageSnapshot, MemoryError> {
        let normalized_limit = match limit {
            Some(value) if value.is_finite() => value.floor().clamp(1.0, 50.0) as i64,
            _ => 5,
        };
        let where_clause = if persona_id.is_some() {
            "WHERE persona_id = ?"
        } else {
            ""
        };
        let where_values: Vec<SqliteValue> = match persona_id {
            Some(persona_id) => vec![SqliteValue::Text(persona_id.to_string())],
            None => Vec::new(),
        };

        let summary_sql = format!(
            "
        SELECT
          COUNT(*) AS total_nodes,
          COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS content_bytes,
          COALESCE(SUM(LENGTH(CAST(embedding_json AS BLOB))), 0) AS embedding_bytes,
          COALESCE(SUM(LENGTH(CAST(COALESCE(metadata_json, '') AS BLOB))), 0) AS metadata_bytes
        FROM memory_nodes
        {where_clause}
      "
        );
        let (total_nodes, content_bytes, embedding_bytes, metadata_bytes): (
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
        ) = self.connection.query_row(
            &summary_sql,
            params_from_iter(where_values.clone()),
            |row| {
                Ok((
                    row.get("total_nodes")?,
                    row.get("content_bytes")?,
                    row.get("embedding_bytes")?,
                    row.get("metadata_bytes")?,
                ))
            },
        )?;

        let content_bytes = content_bytes.unwrap_or(0);
        let embedding_bytes = embedding_bytes.unwrap_or(0);
        let metadata_bytes = metadata_bytes.unwrap_or(0);
        let summary = MemoryStorageSummary {
            total_nodes: total_nodes.unwrap_or(0),
            content_bytes,
            embedding_bytes,
            metadata_bytes,
            total_bytes: content_bytes + embedding_bytes + metadata_bytes,
        };

        let by_type_sql = format!(
            "
        SELECT
          type,
          COUNT(*) AS node_count,
          COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS content_bytes,
          COALESCE(SUM(LENGTH(CAST(embedding_json AS BLOB))), 0) AS embedding_bytes,
          COALESCE(SUM(LENGTH(CAST(COALESCE(metadata_json, '') AS BLOB))), 0) AS metadata_bytes
        FROM memory_nodes
        {where_clause}
        GROUP BY type
        ORDER BY
          (content_bytes + embedding_bytes + metadata_bytes) DESC,
          node_count DESC
      "
        );
        let mut by_type = Vec::new();
        {
            let mut statement = self.connection.prepare(&by_type_sql)?;
            let mut rows = statement.query(params_from_iter(where_values.clone()))?;
            while let Some(row) = rows.next()? {
                let node_count: Option<i64> = row.get("node_count")?;
                let content_bytes: i64 = row.get::<_, Option<i64>>("content_bytes")?.unwrap_or(0);
                let embedding_bytes: i64 =
                    row.get::<_, Option<i64>>("embedding_bytes")?.unwrap_or(0);
                let metadata_bytes: i64 = row.get::<_, Option<i64>>("metadata_bytes")?.unwrap_or(0);
                by_type.push(MemoryStorageByType {
                    node_type: text_column(row, "type")?,
                    count: node_count.unwrap_or(0),
                    content_bytes,
                    embedding_bytes,
                    metadata_bytes,
                    total_bytes: content_bytes + embedding_bytes + metadata_bytes,
                });
            }
        }

        let largest_sql = format!(
            "
        SELECT
          id,
          type,
          LENGTH(CAST(content AS BLOB)) AS content_bytes,
          LENGTH(CAST(embedding_json AS BLOB)) AS embedding_bytes,
          LENGTH(CAST(COALESCE(metadata_json, '') AS BLOB)) AS metadata_bytes
        FROM memory_nodes
        {where_clause}
        ORDER BY
          (content_bytes + embedding_bytes + metadata_bytes) DESC,
          updated_at DESC
        LIMIT ?
      "
        );
        let mut largest_values = where_values;
        largest_values.push(SqliteValue::Integer(normalized_limit));
        let mut largest_nodes = Vec::new();
        {
            let mut statement = self.connection.prepare(&largest_sql)?;
            let mut rows = statement.query(params_from_iter(largest_values))?;
            while let Some(row) = rows.next()? {
                let content_bytes: i64 = row.get::<_, Option<i64>>("content_bytes")?.unwrap_or(0);
                let embedding_bytes: i64 =
                    row.get::<_, Option<i64>>("embedding_bytes")?.unwrap_or(0);
                let metadata_bytes: i64 = row.get::<_, Option<i64>>("metadata_bytes")?.unwrap_or(0);
                largest_nodes.push(MemoryStorageNodeSize {
                    id: text_column(row, "id")?,
                    node_type: text_column(row, "type")?,
                    content_bytes,
                    embedding_bytes,
                    metadata_bytes,
                    total_bytes: content_bytes + embedding_bytes + metadata_bytes,
                });
            }
        }

        Ok(MemoryStorageSnapshot {
            summary,
            by_type,
            largest_nodes,
        })
    }

    // ─── Row readers ───────────────────────────────────────────────────────

    /// `this.db.prepare(sql).all(…).map(toNode)`.
    fn query_nodes(
        &self,
        sql: &str,
        values: Vec<SqliteValue>,
    ) -> Result<Vec<MemoryNode>, MemoryError> {
        let mut statement = self.connection.prepare(sql)?;
        let mut rows = statement.query(params_from_iter(values))?;
        let mut nodes = Vec::new();
        while let Some(row) = rows.next()? {
            nodes.push(to_node(row)?);
        }
        Ok(nodes)
    }

    /// `this.db.prepare(sql).all(…).map((row) => ({ node, userId, personaId }))`.
    fn query_scoped_nodes(
        &self,
        sql: &str,
        values: Vec<SqliteValue>,
    ) -> Result<Vec<MemoryNodeWithScope>, MemoryError> {
        let mut statement = self.connection.prepare(sql)?;
        let mut rows = statement.query(params_from_iter(values))?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next()? {
            entries.push(to_scoped_node(row)?);
        }
        Ok(entries)
    }
}

/// `JSON.stringify(node.embedding ?? [])`.
fn embedding_json(node: &MemoryNode) -> Result<String, MemoryError> {
    Ok(serde_json::to_string(&node.embedding)?)
}

/// `node.metadata ? JSON.stringify(node.metadata) : null`.
fn metadata_json(node: &MemoryNode) -> Result<Option<String>, MemoryError> {
    match &node.metadata {
        Some(metadata) => Ok(Some(serde_json::to_string(metadata)?)),
        None => Ok(None),
    }
}

/// `MEMORY_DB_PATH || MESSAGES_DB_PATH || '.local/messages.db'`, the default
/// argument of `sqliteMemoryRepository.ts:55`.
///
/// The relative default is anchored at `WORKSPACE_ROOT` through
/// [`db::default_db_path`](crate::db::default_db_path), exactly like
/// [`default_messages_db_path`](crate::messages_store::default_messages_db_path),
/// so the gateway and the scheduler agree on the file. JavaScript's `||` treats
/// an empty variable as absent; a whitespace-only variable is dropped as well
/// (module header, deviation 10).
pub fn default_memory_db_path() -> String {
    resolve_memory_db_path(|name| std::env::var(name).ok())
}

/// The injectable core of [`default_memory_db_path`].
///
/// The lookup is passed in so the precedence can be tested without touching the
/// process environment, which `std::env::set_var` would do for the whole test
/// binary — the same seam rationale as [`crate::model_hub::env::EnvOverrides`].
fn resolve_memory_db_path(env: impl Fn(&str) -> Option<String>) -> String {
    for name in ["MEMORY_DB_PATH", "MESSAGES_DB_PATH"] {
        if let Some(value) = env(name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    default_db_path("messages.db")
}

impl MemoryRepository for SqliteMemoryRepository {
    fn list_nodes(
        &self,
        persona_id: &str,
        user_id: Option<&str>,
    ) -> Result<Vec<MemoryNode>, MemoryError> {
        SqliteMemoryRepository::list_nodes(self, persona_id, user_id)
    }

    fn list_nodes_page(
        &self,
        persona_id: &str,
        input: &MemoryListPageInput,
        user_id: Option<&str>,
    ) -> Result<MemoryListPageResult, MemoryError> {
        SqliteMemoryRepository::list_nodes_page(self, persona_id, input, user_id)
    }

    fn list_all_nodes(&self, user_id: Option<&str>) -> Result<Vec<MemoryNode>, MemoryError> {
        SqliteMemoryRepository::list_all_nodes(self, user_id)
    }

    fn insert_node(
        &self,
        persona_id: &str,
        node: &MemoryNode,
        user_id: Option<&str>,
    ) -> Result<(), MemoryError> {
        SqliteMemoryRepository::insert_node(self, persona_id, node, user_id)
    }

    fn update_node(
        &self,
        persona_id: &str,
        node: &MemoryNode,
        user_id: Option<&str>,
    ) -> Result<(), MemoryError> {
        SqliteMemoryRepository::update_node(self, persona_id, node, user_id)
    }

    fn delete_node(
        &self,
        persona_id: &str,
        node_id: &str,
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError> {
        SqliteMemoryRepository::delete_node(self, persona_id, node_id, user_id)
    }

    fn update_many(
        &self,
        persona_id: &str,
        node_ids: &[String],
        updates: &MemoryNodeUpdates,
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError> {
        SqliteMemoryRepository::update_many(self, persona_id, node_ids, updates, user_id)
    }

    fn delete_many(
        &self,
        persona_id: &str,
        node_ids: &[String],
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError> {
        SqliteMemoryRepository::delete_many(self, persona_id, node_ids, user_id)
    }

    fn delete_by_persona(
        &self,
        persona_id: &str,
        user_id: Option<&str>,
    ) -> Result<i64, MemoryError> {
        SqliteMemoryRepository::delete_by_persona(self, persona_id, user_id)
    }

    fn list_all_nodes_with_scope(
        &self,
        user_id: Option<&str>,
    ) -> Result<Vec<MemoryNodeWithScope>, MemoryError> {
        SqliteMemoryRepository::list_all_nodes_with_scope(self, user_id)
    }

    fn get_node_by_id(&self, node_id: &str) -> Result<Option<MemoryNodeWithScope>, MemoryError> {
        SqliteMemoryRepository::get_node_by_id(self, node_id)
    }

    fn list_node_history(&self, node_id: &str) -> Result<Vec<MemoryNodeHistoryRow>, MemoryError> {
        SqliteMemoryRepository::list_node_history(self, node_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-s5-sqlite-{label}-{unique}"));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn join(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open(dir: &TempDir) -> SqliteMemoryRepository {
        SqliteMemoryRepository::open(&dir.join("messages.db")).expect("open the repository")
    }

    fn node(id: &str, node_type: MemoryType, content: &str) -> MemoryNode {
        MemoryNode {
            id: id.to_string(),
            node_type,
            content: content.to_string(),
            embedding: vec![0.1, 0.2, 0.3],
            importance: 3.0,
            confidence: 0.3,
            timestamp: "10:00".to_string(),
            metadata: Some(MemoryMetadata::from_iter([(
                "source".to_string(),
                json!("test"),
            )])),
        }
    }

    fn ids(nodes: &[MemoryNode]) -> Vec<String> {
        nodes.iter().map(|entry| entry.id.clone()).collect()
    }

    /// Pins `importance`, the first `ORDER BY` key, so a listing order is a
    /// statement of the query rather than of the insertion timing.
    fn with_importance(mut node: MemoryNode, importance: f64) -> MemoryNode {
        node.importance = importance;
        node
    }

    #[test]
    fn the_database_is_created_and_starts_empty() {
        let dir = TempDir::new("empty");
        let repository = open(&dir);

        assert!(repository
            .list_nodes("persona-a", None)
            .expect("list")
            .is_empty());
        assert!(repository
            .list_all_nodes_with_scope(None)
            .expect("list all")
            .is_empty());

        let snapshot = repository
            .get_storage_snapshot(None, None)
            .expect("snapshot");
        assert_eq!(snapshot.summary, MemoryStorageSummary::default());
        assert!(snapshot.by_type.is_empty());
        assert!(snapshot.largest_nodes.is_empty());
    }

    #[test]
    fn the_json_columns_round_trip_through_the_row_mapper() {
        let dir = TempDir::new("round-trip");
        let repository = open(&dir);
        repository
            .insert_node("persona-a", &node("mem-1", MemoryType::Fact, "alpha"), None)
            .expect("insert");

        let nodes = repository.list_nodes("persona-a", None).expect("list");
        assert_eq!(nodes.len(), 1);
        let stored = &nodes[0];
        assert_eq!(stored.id, "mem-1");
        assert_eq!(stored.node_type, MemoryType::Fact);
        assert_eq!(stored.content, "alpha");
        assert_eq!(stored.embedding, vec![0.1, 0.2, 0.3]);
        assert_eq!(stored.importance, 3.0);
        assert_eq!(stored.confidence, 0.3);
        assert_eq!(stored.timestamp, "10:00");
        let metadata = stored.metadata.as_ref().expect("metadata");
        assert_eq!(metadata["source"], "test");
        assert!(metadata.get("type").is_none(), "the bag is stored verbatim");
    }

    #[test]
    fn every_read_is_scoped_by_user_and_persona() {
        let dir = TempDir::new("scope");
        let repository = open(&dir);
        repository
            .insert_node(
                "persona-a",
                &with_importance(node("user-a-node", MemoryType::Fact, "a"), 5.0),
                Some("user-a"),
            )
            .expect("insert");
        repository
            .insert_node(
                "persona-a",
                &with_importance(node("user-b-node", MemoryType::Fact, "b"), 4.0),
                Some("user-b"),
            )
            .expect("insert");
        repository
            .insert_node(
                "persona-b",
                &with_importance(node("persona-b-node", MemoryType::Fact, "c"), 3.0),
                Some("user-a"),
            )
            .expect("insert");

        // listNodes is persona *and* user scoped.
        assert_eq!(
            ids(&repository
                .list_nodes("persona-a", Some("user-a"))
                .expect("list")),
            vec!["user-a-node".to_string()]
        );
        assert_eq!(
            ids(&repository
                .list_nodes("persona-a", Some("user-b"))
                .expect("list")),
            vec!["user-b-node".to_string()]
        );
        // An absent user resolves to the legacy id, which owns no row here.
        assert!(repository
            .list_nodes("persona-b", None)
            .expect("list")
            .is_empty());

        // listAllNodesWithScope branches on the raw argument's truthiness.
        assert_eq!(
            repository
                .list_all_nodes_with_scope(None)
                .expect("all rows")
                .len(),
            3
        );
        assert_eq!(
            repository
                .list_all_nodes_with_scope(Some(""))
                .expect("the empty string is falsy")
                .len(),
            3
        );
        assert_eq!(
            repository
                .list_all_nodes_with_scope(Some("user-a"))
                .expect("scoped")
                .len(),
            2
        );
        assert!(
            repository
                .list_all_nodes_with_scope(Some("   "))
                .expect("whitespace is truthy")
                .is_empty(),
            "a whitespace id resolves to the legacy user, not to every row"
        );
        assert_eq!(
            ids(&repository.list_all_nodes(Some("user-a")).expect("flat")),
            vec!["user-a-node".to_string(), "persona-b-node".to_string()]
        );

        // deleteByPersona removes one tenant only.
        assert_eq!(
            repository
                .delete_by_persona("persona-a", Some("user-a"))
                .expect("delete"),
            1
        );
        assert!(repository
            .list_nodes("persona-a", Some("user-a"))
            .expect("list")
            .is_empty());
        assert_eq!(
            repository
                .list_nodes("persona-a", Some("user-b"))
                .expect("list")
                .len(),
            1
        );
    }

    #[test]
    fn a_blank_user_id_resolves_to_the_legacy_local_user() {
        let dir = TempDir::new("legacy-user");
        let repository = open(&dir);
        repository
            .insert_node(
                "persona-a",
                &with_importance(node("mem-legacy", MemoryType::Fact, "a"), 5.0),
                Some(""),
            )
            .expect("insert blank");
        repository
            .insert_node(
                "persona-a",
                &with_importance(node("mem-ws", MemoryType::Fact, "b"), 1.0),
                Some("   "),
            )
            .expect("insert whitespace");

        assert_eq!(
            ids(&repository.list_nodes("persona-a", Some("")).expect("list")),
            vec!["mem-legacy".to_string(), "mem-ws".to_string()]
        );
        let scoped = repository
            .get_node_by_id("mem-legacy")
            .expect("get")
            .expect("found");
        assert_eq!(scoped.user_id, crate::memory::types::LEGACY_LOCAL_USER_ID);
        assert_eq!(scoped.persona_id, "persona-a");
        assert!(repository.get_node_by_id("missing").expect("get").is_none());
    }

    #[test]
    fn the_page_listing_filters_by_type_and_query_and_clamps_the_bounds() {
        let dir = TempDir::new("page");
        let repository = open(&dir);
        repository
            .insert_node(
                "persona-a",
                &with_importance(node("page-fact", MemoryType::Fact, "alpha"), 5.0),
                None,
            )
            .expect("insert");
        repository
            .insert_node(
                "persona-a",
                &with_importance(node("page-preference", MemoryType::Preference, "beta"), 3.0),
                None,
            )
            .expect("insert");
        repository
            .insert_node(
                "persona-a",
                &with_importance(node("page-lesson", MemoryType::Lesson, "gamma"), 1.0),
                None,
            )
            .expect("insert");

        // A page of 0 is normalised to 1 and a page size of 500 to 200, which
        // still returns the whole ordered list.
        let clamped = repository
            .list_nodes_page(
                "persona-a",
                &MemoryListPageInput {
                    page: 0,
                    page_size: 500,
                    ..MemoryListPageInput::default()
                },
                None,
            )
            .expect("page");
        assert_eq!(clamped.total, 3);
        assert_eq!(
            ids(&clamped.nodes),
            vec![
                "page-fact".to_string(),
                "page-preference".to_string(),
                "page-lesson".to_string()
            ]
        );

        // LIMIT/OFFSET walk the same ordered list: the second page of two holds
        // the third node, and one page further on is empty.
        let last = repository
            .list_nodes_page(
                "persona-a",
                &MemoryListPageInput {
                    page: 2,
                    page_size: 2,
                    ..MemoryListPageInput::default()
                },
                None,
            )
            .expect("page");
        assert_eq!(last.total, 3);
        assert_eq!(ids(&last.nodes), vec!["page-lesson".to_string()]);

        let beyond = repository
            .list_nodes_page(
                "persona-a",
                &MemoryListPageInput {
                    page: 4,
                    page_size: 2,
                    ..MemoryListPageInput::default()
                },
                None,
            )
            .expect("page");
        assert_eq!(beyond.total, 3);
        assert!(beyond.nodes.is_empty());

        // The query is trimmed before it becomes a LIKE pattern, and the pattern
        // also matches the type column.
        let filtered = repository
            .list_nodes_page(
                "persona-a",
                &MemoryListPageInput {
                    page: 0,
                    page_size: 500,
                    query: Some("  ALPHA  ".to_string()),
                    node_type: Some(MemoryType::Fact),
                },
                None,
            )
            .expect("filtered");
        assert_eq!(filtered.total, 1);
        assert_eq!(ids(&filtered.nodes), vec!["page-fact".to_string()]);

        let by_type_text = repository
            .list_nodes_page(
                "persona-a",
                &MemoryListPageInput {
                    page: 1,
                    page_size: 10,
                    query: Some("preference".to_string()),
                    node_type: None,
                },
                None,
            )
            .expect("by type text");
        assert_eq!(by_type_text.total, 1);

        let whitespace_query = repository
            .list_nodes_page(
                "persona-a",
                &MemoryListPageInput {
                    page: 1,
                    page_size: 10,
                    query: Some("   ".to_string()),
                    node_type: None,
                },
                None,
            )
            .expect("whitespace query");
        assert_eq!(whitespace_query.total, 3, "a blank query is ignored");

        let unmatched = repository
            .list_nodes_page(
                "persona-a",
                &MemoryListPageInput {
                    page: 1,
                    page_size: 10,
                    query: Some("missing".to_string()),
                    node_type: None,
                },
                None,
            )
            .expect("unmatched");
        assert_eq!(unmatched.total, 0);
        assert!(unmatched.nodes.is_empty());

        // The trait object proves the contract is object safe and wired.
        let repository_ref: &dyn MemoryRepository = &repository;
        assert_eq!(
            repository_ref
                .list_nodes_page(
                    "persona-a",
                    &MemoryListPageInput {
                        page: 1,
                        page_size: 10,
                        ..MemoryListPageInput::default()
                    },
                    None,
                )
                .expect("trait call")
                .total,
            3
        );
    }

    /// Pins the two `ORDER BY` keys of every listing: importance descending,
    /// then `updated_at` descending. The stamps are set explicitly because four
    /// inserts inside one millisecond would tie and leave the order to SQLite.
    #[test]
    fn the_listing_order_is_importance_then_updated_at() {
        let dir = TempDir::new("order");
        let repository = open(&dir);
        for id in ["first", "second", "third"] {
            repository
                .insert_node("persona-a", &node(id, MemoryType::Fact, id), None)
                .expect("insert");
        }
        repository
            .connection()
            .execute_batch(
                "UPDATE memory_nodes SET importance = 3;
                 UPDATE memory_nodes SET updated_at = '2026-01-01T00:00:00.000Z';
                 UPDATE memory_nodes SET updated_at = '2026-01-03T00:00:00.000Z' WHERE id = 'third';
                 UPDATE memory_nodes SET updated_at = '2026-01-02T00:00:00.000Z' WHERE id = 'second';",
            )
            .expect("pin the stamps");

        assert_eq!(
            ids(&repository.list_nodes("persona-a", None).expect("list")),
            vec![
                "third".to_string(),
                "second".to_string(),
                "first".to_string()
            ],
            "equal importance orders by updated_at descending"
        );

        repository
            .connection()
            .execute(
                "UPDATE memory_nodes SET importance = 5 WHERE id = 'first'",
                [],
            )
            .expect("bump the importance");
        assert_eq!(
            ids(&repository.list_nodes("persona-a", None).expect("list")),
            vec![
                "first".to_string(),
                "third".to_string(),
                "second".to_string()
            ],
            "importance outranks the stamp"
        );
    }

    #[test]
    fn the_bulk_mutations_deduplicate_ids_and_sum_the_affected_rows() {
        let dir = TempDir::new("bulk");
        let repository = open(&dir);
        for id in ["p1", "p2", "p3"] {
            repository
                .insert_node("persona-a", &node(id, MemoryType::Fact, id), None)
                .expect("insert");
        }

        assert_eq!(
            repository
                .update_many(
                    "persona-a",
                    &[
                        "p1".to_string(),
                        "  p1  ".to_string(),
                        String::new(),
                        "   ".to_string(),
                    ],
                    &MemoryNodeUpdates {
                        node_type: Some(MemoryType::Avoidance),
                        importance: Some(5.0),
                    },
                    None,
                )
                .expect("update"),
            1,
            "the trimmed duplicates collapse into one candidate"
        );

        let after = repository.list_nodes("persona-a", None).expect("list");
        let p1 = after.iter().find(|entry| entry.id == "p1").expect("p1");
        assert_eq!(p1.node_type, MemoryType::Avoidance);
        assert_eq!(p1.importance, 5.0);

        // A type-only update leaves the importance alone.
        assert_eq!(
            repository
                .update_many(
                    "persona-a",
                    &["p2".to_string(), "p3".to_string()],
                    &MemoryNodeUpdates {
                        node_type: Some(MemoryType::Lesson),
                        importance: None,
                    },
                    None,
                )
                .expect("update"),
            2
        );

        // No candidates, no update keys, or no matching rows: zero changes.
        assert_eq!(
            repository
                .update_many(
                    "persona-a",
                    &[],
                    &MemoryNodeUpdates {
                        node_type: Some(MemoryType::Fact),
                        importance: None,
                    },
                    None,
                )
                .expect("empty ids"),
            0
        );
        assert_eq!(
            repository
                .update_many(
                    "persona-a",
                    &["missing".to_string()],
                    &MemoryNodeUpdates::default(),
                    None,
                )
                .expect("no keys"),
            0
        );
        assert_eq!(
            repository
                .update_many(
                    "persona-a",
                    &["missing".to_string()],
                    &MemoryNodeUpdates {
                        node_type: Some(MemoryType::Fact),
                        importance: None,
                    },
                    None,
                )
                .expect("unmatched"),
            0
        );

        // deleteMany mirrors the same normalisation and the same zero cases.
        assert_eq!(
            repository
                .delete_many("persona-a", &["  p1 ".to_string(), "p1".to_string()], None)
                .expect("delete"),
            1
        );
        assert_eq!(
            repository
                .delete_many("persona-a", &["".to_string(), "   ".to_string()], None)
                .expect("blank ids"),
            0
        );
        assert_eq!(
            repository
                .delete_many("persona-a", &["missing".to_string()], None)
                .expect("unmatched"),
            0
        );
        assert_eq!(
            repository
                .delete_node("persona-a", "missing", None)
                .expect("delete node"),
            0
        );
        assert_eq!(
            repository
                .delete_by_persona("persona-a", None)
                .expect("delete persona"),
            2
        );
        assert!(repository
            .list_nodes("persona-a", None)
            .expect("list")
            .is_empty());
    }

    #[test]
    fn the_history_records_add_and_update_for_matching_rows_only() {
        let dir = TempDir::new("history");
        let repository = open(&dir);
        repository
            .insert_node("persona-a", &node("p1", MemoryType::Fact, "first"), None)
            .expect("insert");

        let added = repository.list_node_history("p1").expect("history");
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].action, "add");
        assert_eq!(added[0].content, "first");
        assert_eq!(added[0].metadata["source"], "test");
        assert!(!added[0].timestamp.is_empty());

        let mut updated = node("p1", MemoryType::Preference, "second");
        updated.metadata = None;
        repository
            .update_node("persona-a", &updated, None)
            .expect("update");

        let entries = repository.list_node_history("p1").expect("history");
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.action.as_str())
                .collect::<Vec<_>>(),
            vec!["add", "update"],
            "the entries are ordered by the autoincrement id"
        );
        assert_eq!(entries[1].content, "second");
        assert!(
            entries[1].metadata.is_empty(),
            "an absent bag is stored as an empty object"
        );

        // An update that touches nothing appends nothing.
        repository
            .update_node("persona-a", &node("missing", MemoryType::Fact, "x"), None)
            .expect("unmatched update is a no-op");
        assert!(repository
            .list_node_history("missing")
            .expect("history")
            .is_empty());
    }

    #[test]
    fn the_storage_snapshot_accounts_the_stored_bytes_per_node_and_type() {
        let dir = TempDir::new("storage");
        let repository = open(&dir);

        let mut large = node("fact-large", MemoryType::Fact, &"A".repeat(300));
        large.embedding = (0..128).map(|index| f64::from(index) / 100.0).collect();
        let mut medium = node("pref-medium", MemoryType::Preference, &"B".repeat(150));
        medium.embedding = (0..64).map(|index| f64::from(index) / 100.0).collect();
        repository
            .insert_node("persona-a", &large, None)
            .expect("insert");
        repository
            .insert_node("persona-a", &medium, None)
            .expect("insert");
        repository
            .insert_node(
                "persona-b",
                &node("other-persona", MemoryType::Fact, "c"),
                None,
            )
            .expect("insert");

        // The expected sizes are read back from the columns the snapshot measures,
        // so the test pins the arithmetic instead of a magic number.
        let measure = |id: &str| -> (i64, i64, i64) {
            repository
                .connection()
                .query_row(
                    "SELECT
                       LENGTH(CAST(content AS BLOB)),
                       LENGTH(CAST(embedding_json AS BLOB)),
                       LENGTH(CAST(COALESCE(metadata_json, '') AS BLOB))
                     FROM memory_nodes WHERE id = ?",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("measure")
        };
        let (large_content, large_embedding, large_metadata) = measure("fact-large");
        let (medium_content, medium_embedding, medium_metadata) = measure("pref-medium");
        let (other_content, other_embedding, other_metadata) = measure("other-persona");

        let snapshot = repository
            .get_storage_snapshot(Some(1.0), None)
            .expect("snapshot");
        assert_eq!(snapshot.summary.total_nodes, 3);
        assert_eq!(
            snapshot.summary.content_bytes,
            large_content + medium_content + other_content
        );
        assert_eq!(
            snapshot.summary.embedding_bytes,
            large_embedding + medium_embedding + other_embedding
        );
        assert_eq!(
            snapshot.summary.metadata_bytes,
            large_metadata + medium_metadata + other_metadata
        );
        assert_eq!(
            snapshot.summary.total_bytes,
            snapshot.summary.content_bytes
                + snapshot.summary.embedding_bytes
                + snapshot.summary.metadata_bytes
        );

        assert_eq!(snapshot.by_type.len(), 2, "one row per stored type");
        let fact = snapshot
            .by_type
            .iter()
            .find(|entry| entry.node_type == "fact")
            .expect("fact row");
        assert_eq!(fact.count, 2);
        assert_eq!(fact.content_bytes, large_content + other_content);
        assert_eq!(
            fact.total_bytes,
            fact.content_bytes + fact.embedding_bytes + fact.metadata_bytes
        );
        assert_eq!(
            snapshot.by_type[0].node_type, "fact",
            "the type rows order by total bytes descending"
        );

        assert_eq!(snapshot.largest_nodes.len(), 1, "the limit is applied");
        assert_eq!(snapshot.largest_nodes[0].id, "fact-large");
        assert_eq!(snapshot.largest_nodes[0].content_bytes, large_content);
        assert_eq!(
            snapshot.largest_nodes[0].total_bytes,
            large_content + large_embedding + large_metadata
        );

        // A non-finite limit falls back to 5, so both personas fit again.
        let all = repository
            .get_storage_snapshot(Some(f64::NAN), None)
            .expect("snapshot");
        assert_eq!(all.largest_nodes.len(), 3);
        let one = repository
            .get_storage_snapshot(Some(0.0), None)
            .expect("snapshot");
        assert_eq!(one.largest_nodes.len(), 1, "the limit is clamped to one");

        // The persona filter is applied to all three statements.
        let scoped = repository
            .get_storage_snapshot(None, Some("persona-b"))
            .expect("snapshot");
        assert_eq!(scoped.summary.total_nodes, 1);
        assert_eq!(scoped.summary.content_bytes, other_content);
        assert_eq!(scoped.by_type.len(), 1);
        assert_eq!(scoped.largest_nodes.len(), 1);

        let unknown = repository
            .get_storage_snapshot(None, Some("persona-missing"))
            .expect("snapshot");
        assert_eq!(unknown.summary, MemoryStorageSummary::default());
        assert!(unknown.by_type.is_empty());
        assert!(unknown.largest_nodes.is_empty());
    }

    #[test]
    fn empty_legacy_json_columns_read_back_as_the_javascript_defaults() {
        let dir = TempDir::new("legacy-json");
        let repository = open(&dir);
        let mut empty = node("empty-legacy", MemoryType::Fact, "");
        empty.embedding = Vec::new();
        empty.metadata = None;
        repository
            .insert_node("persona-a", &empty, None)
            .expect("insert");

        // The TypeScript test does the same: it rewrites the JSON columns to the
        // empty string a pre-JSON release left behind.
        repository
            .connection()
            .execute(
                "UPDATE memory_nodes SET embedding_json = ?, metadata_json = ? WHERE id = ?",
                params!["", "", "empty-legacy"],
            )
            .expect("blank the columns");
        repository
            .connection()
            .execute(
                "UPDATE memory_node_history SET metadata_json = ? WHERE node_id = ?",
                params!["", "empty-legacy"],
            )
            .expect("blank the history");

        let stored = repository.list_nodes("persona-a", None).expect("list");
        assert_eq!(stored.len(), 1);
        assert!(stored[0].embedding.is_empty());
        assert!(
            stored[0].metadata.is_none(),
            "an empty metadata column is `undefined`, not `{{}}`"
        );

        let history = repository
            .list_node_history("empty-legacy")
            .expect("history");
        assert_eq!(history.len(), 1);
        assert!(history[0].metadata.is_empty());

        let snapshot = repository
            .get_storage_snapshot(Some(5.0), Some("persona-a"))
            .expect("snapshot");
        assert_eq!(snapshot.summary.total_nodes, 1);
        assert_eq!(snapshot.summary.total_bytes, 0);
        assert_eq!(snapshot.by_type[0].total_bytes, 0);
        assert_eq!(snapshot.largest_nodes[0].id, "empty-legacy");
        assert_eq!(snapshot.largest_nodes[0].total_bytes, 0);
    }

    #[test]
    fn an_unknown_type_spelling_reads_back_as_fact() {
        let dir = TempDir::new("type-coercion");
        let repository = open(&dir);
        repository
            .insert_node("persona-a", &node("typed", MemoryType::Fact, "x"), None)
            .expect("insert");
        repository
            .connection()
            .execute(
                "UPDATE memory_nodes SET type = ? WHERE id = ?",
                params!["nonsense", "typed"],
            )
            .expect("retype");

        assert_eq!(
            repository.list_nodes("persona-a", None).expect("list")[0].node_type,
            MemoryType::Fact,
            "an unknown spelling lands on the closed enum's fallback"
        );
    }

    #[test]
    fn a_broken_json_column_is_reported_instead_of_silently_coerced() {
        let dir = TempDir::new("broken-json");
        let repository = open(&dir);
        repository
            .insert_node("persona-a", &node("broken", MemoryType::Fact, "x"), None)
            .expect("insert");
        repository
            .connection()
            .execute(
                "UPDATE memory_nodes SET embedding_json = ? WHERE id = ?",
                params!["not json", "broken"],
            )
            .expect("break the embedding");

        let error = repository
            .list_nodes("persona-a", None)
            .expect_err("the JSON parse must fail");
        assert!(
            matches!(error, MemoryError::Storage(_)),
            "expected a storage error, got {error:?}"
        );
    }

    #[test]
    fn rows_persist_across_repository_instances() {
        let dir = TempDir::new("persist");
        let path = dir.join("messages.db");
        {
            let first = SqliteMemoryRepository::open(&path).expect("open");
            first
                .insert_node(
                    "persona-a",
                    &node("mem-persist", MemoryType::Fact, "x"),
                    None,
                )
                .expect("insert");
        }

        let second = SqliteMemoryRepository::open(&path).expect("reopen");
        assert_eq!(second.db_path(), path);
        assert_eq!(
            ids(&second.list_nodes("persona-a", None).expect("list")),
            vec!["mem-persist".to_string()]
        );
        // The migration ladder is idempotent on the second open.
        assert_eq!(
            second
                .list_node_history("mem-persist")
                .expect("history")
                .len(),
            1
        );
    }

    #[test]
    fn a_legacy_table_without_the_scope_columns_is_upgraded_on_open() {
        let dir = TempDir::new("legacy-table");
        let path = dir.join("messages.db");
        {
            let connection = crate::db::open(OpenOptions::new(&path)).expect("open raw");
            connection
                .execute_batch(
                    r#"
                    CREATE TABLE memory_nodes (
                      id TEXT PRIMARY KEY,
                      type TEXT NOT NULL,
                      content TEXT NOT NULL,
                      embedding_json TEXT NOT NULL DEFAULT '[]',
                      importance INTEGER NOT NULL,
                      confidence REAL NOT NULL,
                      timestamp TEXT NOT NULL,
                      metadata_json TEXT,
                      created_at TEXT NOT NULL,
                      updated_at TEXT NOT NULL
                    );
                    INSERT INTO memory_nodes (
                      id, type, content, embedding_json, importance, confidence, timestamp,
                      metadata_json, created_at, updated_at
                    ) VALUES ('legacy-memory', 'fact', 'legacy content', '[]', 3, 0.5,
                      '2026-01-01', NULL, '2026-01-01', '2026-01-01');
                    "#,
                )
                .expect("seed the legacy schema");
        }

        let repository = SqliteMemoryRepository::open(&path).expect("migrate on open");
        let records = repository.list_all_nodes_with_scope(None).expect("list");
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].user_id,
            crate::memory::types::LEGACY_LOCAL_USER_ID
        );
        assert_eq!(records[0].persona_id, "persona-default");
        assert_eq!(records[0].node.id, "legacy-memory");
        assert_eq!(records[0].node.content, "legacy content");
    }

    #[test]
    fn the_database_path_follows_the_two_environment_variables() {
        fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| (*value).to_string())
            }
        }

        assert_eq!(
            resolve_memory_db_path(env_of(&[
                ("MEMORY_DB_PATH", "/tmp/memory.db"),
                ("MESSAGES_DB_PATH", "/tmp/messages.db"),
            ])),
            "/tmp/memory.db"
        );
        assert_eq!(
            resolve_memory_db_path(env_of(&[
                ("MEMORY_DB_PATH", ""),
                ("MESSAGES_DB_PATH", "/tmp/messages.db"),
            ])),
            "/tmp/messages.db",
            "an empty variable is falsy in JavaScript"
        );
        assert_eq!(
            resolve_memory_db_path(env_of(&[("MEMORY_DB_PATH", "   ")])),
            default_db_path("messages.db"),
            "a whitespace-only path falls back to the shared default file"
        );
        assert_eq!(
            resolve_memory_db_path(env_of(&[])),
            default_db_path("messages.db")
        );
        assert_eq!(
            resolve_memory_db_path(env_of(&[("MEMORY_DB_PATH", "  /tmp/memory.db  ")])),
            "/tmp/memory.db",
            "the resolved path is trimmed"
        );
        assert!(default_memory_db_path().ends_with("messages.db"));
    }
}
