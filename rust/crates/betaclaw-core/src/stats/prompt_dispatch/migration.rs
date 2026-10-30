//! Port of `src/server/stats/prompt-dispatch-repository/migration.ts`.
//!
//! The base table is created first, then every later column is added with an
//! `ALTER TABLE` guarded by `PRAGMA table_info`, so a table written by an older
//! release gets the new columns. The DDL matches the TypeScript exactly.

use rusqlite::Connection;

const TABLE_DDL: &str = "
    CREATE TABLE IF NOT EXISTS prompt_dispatch_logs (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      account_id TEXT,
      dispatch_kind TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      prompt_tokens_source TEXT NOT NULL,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error_message TEXT,
      risk_level TEXT NOT NULL,
      risk_score INTEGER NOT NULL DEFAULT 0,
      risk_reasons_json TEXT NOT NULL DEFAULT '[]',
      prompt_preview TEXT NOT NULL,
      prompt_payload_json TEXT NOT NULL,
      prompt_cost_usd REAL,
      completion_cost_usd REAL,
      total_cost_usd REAL,
      created_at TEXT NOT NULL
    );
";

/// Columns added after the first release, in the order of the TypeScript.
const ADDED_COLUMNS: &[(&str, &str)] = &[
    ("prompt_cost_usd", "REAL"),
    ("completion_cost_usd", "REAL"),
    ("total_cost_usd", "REAL"),
    ("conversation_id", "TEXT"),
    ("turn_seq", "INTEGER"),
    ("latency_ms", "INTEGER"),
    ("tool_calls_json", "TEXT NOT NULL DEFAULT '[]'"),
    ("memory_context_json", "TEXT"),
];

const INDEX_DDL: &str = "
    CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_conversation
      ON prompt_dispatch_logs (conversation_id)
      WHERE conversation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_created
      ON prompt_dispatch_logs (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_provider
      ON prompt_dispatch_logs (provider_id);
    CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_model
      ON prompt_dispatch_logs (model_name);
    CREATE INDEX IF NOT EXISTS idx_prompt_dispatch_logs_risk
      ON prompt_dispatch_logs (risk_level);
";

/// `ensureColumnExists`.
fn ensure_column(connection: &Connection, column: &str, column_type: &str) -> rusqlite::Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(prompt_dispatch_logs)")?;
    let mut rows = statement.query([])?;
    let mut present = false;
    while let Some(row) = rows.next()? {
        let name: String = row.get("name")?;
        if name == column {
            present = true;
            break;
        }
    }
    if !present {
        connection.execute_batch(&format!(
            "ALTER TABLE prompt_dispatch_logs ADD COLUMN {column} {column_type};"
        ))?;
    }
    Ok(())
}

/// `migratePromptDispatchRepository`.
pub fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(TABLE_DDL)?;
    for (column, column_type) in ADDED_COLUMNS {
        ensure_column(connection, column, column_type)?;
    }
    connection.execute_batch(INDEX_DDL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_the_later_columns_to_a_legacy_table() {
        let connection = Connection::open_in_memory().expect("open");
        connection
            .execute_batch(
                "CREATE TABLE prompt_dispatch_logs (
                   id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_name TEXT NOT NULL,
                   account_id TEXT, dispatch_kind TEXT NOT NULL,
                   prompt_tokens INTEGER NOT NULL DEFAULT 0, prompt_tokens_source TEXT NOT NULL,
                   completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
                   status TEXT NOT NULL, error_message TEXT, risk_level TEXT NOT NULL,
                   risk_score INTEGER NOT NULL DEFAULT 0, risk_reasons_json TEXT NOT NULL DEFAULT '[]',
                   prompt_preview TEXT NOT NULL, prompt_payload_json TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );",
            )
            .expect("legacy table");

        migrate(&connection).expect("migrate");
        migrate(&connection).expect("second run is a no-op");

        let mut statement = connection
            .prepare("PRAGMA table_info(prompt_dispatch_logs)")
            .expect("pragma");
        let names: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query")
            .map(|name| name.expect("row"))
            .collect();
        assert!(names.contains(&"conversation_id".to_string()));
        assert!(names.contains(&"tool_calls_json".to_string()));
        assert!(names.contains(&"memory_context_json".to_string()));
    }
}
