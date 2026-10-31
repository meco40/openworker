//! Port of `src/server/skills/handlers/dbQuery.ts`.
//!
//! Runs one read-only statement against the SQLite file named by the `sql-bridge`
//! runtime config, or by `SQLITE_DB_PATH`. The file must resolve inside the workspace
//! root, through symbolic links as well. At most 200 rows are returned.
//!
//! Deviations:
//! - `WORKSPACE_ROOT` is an argument, as in `file_read`. The root is not resolved through
//!   symbolic links, as in TypeScript.
//! - The runtime config store and the environment are arguments. TypeScript reads a
//!   singleton and `process.env`.
//! - The function is synchronous. The caller decides whether to run it on a blocking
//!   thread.
//! - More than one statement is refused, as better-sqlite3 refuses it. rusqlite would
//!   silently run only the first one.
//! - A blob is returned as the JSON of a Node `Buffer`: `{"type":"Buffer","data":[...]}`.

use std::collections::HashMap;
use std::io;
use std::path::Path;

use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::types::ValueRef;
use rusqlite::{Batch, Connection, Row};
use serde_json::{json, Map, Value};

use super::execution_cwd::real_path;
use super::runtime_config::{get_runtime_config_value, SkillRuntimeConfigStore};
use super::store::sql_error;
use super::types::{arg_string, js_trim, SkillError};
use crate::db::{self, OpenOptions};
use crate::safe_error_message;
use crate::security::path_boundary::assert_path_within_root;

const MAX_RESULT_ROWS: usize = 200;
const DB_PATH_CONFIG_ID: &str = "sql-bridge.sqlite_db_path";
const MISSING_PATH_MESSAGE: &str = "SQLite DB path missing. Configure \"SQLite Database Path\" in Skill Registry > Tool Configuration or set SQLITE_DB_PATH.";

/// `dbQueryHandler`. Returns `{ rowCount, rows, truncated }`.
pub fn db_query(
    args: &Map<String, Value>,
    workspace_root: &Path,
    config: &SkillRuntimeConfigStore,
    env: &HashMap<String, String>,
) -> Result<Value, SkillError> {
    let query = js_trim(&arg_string(args, "query")).to_string();
    if query.is_empty() {
        return Err(SkillError("db_query requires query.".to_string()));
    }
    if !starts_with_read_keyword(&query) {
        return Err(SkillError(
            "Only read-only SQL statements are allowed.".to_string(),
        ));
    }

    let db_path = get_runtime_config_value(config, env, DB_PATH_CONFIG_ID)?
        .ok_or_else(|| SkillError(MISSING_PATH_MESSAGE.to_string()))?;
    let resolved = assert_path_within_root(&workspace_root.join(&db_path), workspace_root)
        .map_err(|error| SkillError(error.to_string()))?;
    let real = real_path(&resolved).map_err(io_error)?;
    let safe = assert_path_within_root(&real, workspace_root)
        .map_err(|error| SkillError(error.to_string()))?;

    let connection = db::open(OpenOptions {
        readonly: true,
        enable_wal: false,
        ..OpenOptions::new(safe.to_string_lossy().into_owned())
    })
    .map_err(sql_error)?;
    run_query(&connection, &query)
}

/// `/^(select|with|pragma|explain)\b/i`. ASCII only, as JavaScript matches without the
/// `u` flag. The keyword must end at a non-word character.
fn starts_with_read_keyword(query: &str) -> bool {
    const KEYWORDS: [&str; 4] = ["select", "with", "pragma", "explain"];
    let bytes = query.as_bytes();
    KEYWORDS.iter().any(|keyword| {
        let end = keyword.len();
        bytes.len() >= end
            && bytes[..end].eq_ignore_ascii_case(keyword.as_bytes())
            && bytes.get(end).is_none_or(|next| !is_word_byte(*next))
    })
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn run_query(connection: &Connection, query: &str) -> Result<Value, SkillError> {
    let mut batch = Batch::new(connection, query);
    let mut statement = batch
        .next()
        .map_err(sql_error)?
        .ok_or_else(|| SkillError("SQL statement is empty.".to_string()))?;
    // better-sqlite3 refuses any text after the first statement, even one that is broken.
    if !matches!(batch.next(), Ok(None)) {
        return Err(SkillError(
            "The supplied SQL string contains more than one statement.".to_string(),
        ));
    }
    if statement.column_count() == 0 {
        return Err(SkillError(
            "This statement does not return data. Use run() instead.".to_string(),
        ));
    }

    let columns: Vec<String> = statement.column_names().map(str::to_string).collect();
    let mut rows = statement.query([]).map_err(sql_error)?;
    let mut kept = Vec::new();
    let mut row_count = 0usize;
    while let Some(row) = rows.next().map_err(sql_error)? {
        row_count += 1;
        if kept.len() < MAX_RESULT_ROWS {
            kept.push(row_object(row, &columns).map_err(sql_error)?);
        }
    }
    Ok(json!({
        "rowCount": row_count,
        "rows": kept,
        "truncated": row_count > MAX_RESULT_ROWS,
    }))
}

fn row_object(row: &Row<'_>, columns: &[String]) -> rusqlite::Result<Map<String, Value>> {
    let mut object = Map::new();
    for (index, name) in columns.iter().enumerate() {
        object.insert(name.clone(), value_json(row.get_ref(index)?));
    }
    Ok(object)
}

fn value_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => json!(number),
        // NaN and infinities have no JSON form; JSON.stringify writes them as null.
        ValueRef::Real(number) => {
            serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
        }
        ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => json!({ "type": "Buffer", "data": bytes }),
    }
}

fn io_error(error: io::Error) -> SkillError {
    SkillError(safe_error_message(&error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::types::test_support::TempDir;

    fn args(query: &str) -> Map<String, Value> {
        json!({ "query": query })
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    fn config_pointing_at(path: &str) -> SkillRuntimeConfigStore {
        let config = SkillRuntimeConfigStore::in_memory().expect("open config store");
        config.set_value(DB_PATH_CONFIG_ID, path).expect("set path");
        config
    }

    /// A workspace holding `data.db` with table `t` and `rows` rows.
    fn workspace_with_rows(rows: usize) -> TempDir {
        let dir = TempDir::new();
        let connection = Connection::open(dir.0.join("data.db")).expect("create db");
        connection
            .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT);")
            .expect("schema");
        for _ in 0..rows {
            connection
                .execute("INSERT INTO t (label) VALUES ('row')", [])
                .expect("insert");
        }
        dir
    }

    fn run(query: &str, dir: &TempDir) -> Result<Value, SkillError> {
        db_query(
            &args(query),
            &dir.0,
            &config_pointing_at("data.db"),
            &HashMap::new(),
        )
    }

    #[test]
    fn query_is_required_and_must_be_read_only() {
        let dir = workspace_with_rows(1);
        assert_eq!(run("   ", &dir).unwrap_err().0, "db_query requires query.");
        assert_eq!(
            run("DELETE FROM t", &dir).unwrap_err().0,
            "Only read-only SQL statements are allowed."
        );
        assert_eq!(
            run("select_all from t", &dir).unwrap_err().0,
            "Only read-only SQL statements are allowed.",
            "the keyword must end at a word boundary"
        );
    }

    #[test]
    fn missing_database_path_is_reported_without_a_value() {
        let dir = workspace_with_rows(1);
        let error = db_query(
            &args("select 1"),
            &dir.0,
            &SkillRuntimeConfigStore::in_memory().expect("config"),
            &HashMap::new(),
        )
        .unwrap_err();
        assert_eq!(error.0, MISSING_PATH_MESSAGE);
    }

    #[test]
    fn path_outside_the_workspace_is_refused() {
        let dir = workspace_with_rows(1);
        let error = db_query(
            &args("select 1"),
            &dir.0,
            &config_pointing_at("../outside.db"),
            &HashMap::new(),
        )
        .unwrap_err();
        assert_eq!(error.0, "Path escapes the allowed root.");
    }

    #[test]
    fn rows_are_capped_and_flagged_as_truncated() {
        let dir = workspace_with_rows(250);
        let result = run("select id, label from t order by id", &dir).expect("query");
        assert_eq!(result["rowCount"], 250);
        assert_eq!(result["rows"].as_array().map(Vec::len), Some(200));
        assert_eq!(result["truncated"], true);
        assert_eq!(result["rows"][0], json!({ "id": 1, "label": "row" }));
    }

    #[test]
    fn null_real_and_blob_values_render_as_json() {
        let dir = workspace_with_rows(0);
        let result = run("select NULL as a, 1.5 as b, x'0102' as c", &dir).expect("query");
        assert_eq!(result["rowCount"], 1);
        assert_eq!(result["truncated"], false);
        assert_eq!(
            result["rows"][0],
            json!({ "a": null, "b": 1.5, "c": { "type": "Buffer", "data": [1, 2] } })
        );
    }

    #[test]
    fn pragma_table_info_is_allowed() {
        let dir = workspace_with_rows(0);
        let result = run("PRAGMA table_info(t)", &dir).expect("pragma");
        assert_eq!(result["rowCount"], 2);
    }

    #[test]
    fn more_than_one_statement_is_refused() {
        let dir = workspace_with_rows(1);
        assert_eq!(
            run("select 1; select 2", &dir).unwrap_err().0,
            "The supplied SQL string contains more than one statement."
        );
    }

    #[test]
    fn statement_without_result_columns_is_refused() {
        let dir = workspace_with_rows(1);
        assert_eq!(
            run("PRAGMA foreign_keys = ON", &dir).unwrap_err().0,
            "This statement does not return data. Use run() instead."
        );
    }
}
