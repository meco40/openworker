//! Port of `src/server/stats/tokenUsageRepository.ts`.
//!
//! Same table and indexes as the TypeScript repository, so `.local/stats.db`
//! stays readable by both sides. The process-wide singleton is not ported.

use std::sync::{Mutex, MutexGuard};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection};
use serde::Serialize;

use super::util::{now_iso, now_ms, short_uuid};
use super::StatsError;
use crate::db::OpenOptions;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS token_usage (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage (created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage (provider_id, model_name);
";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageEntry {
    pub id: String,
    pub provider_id: String,
    pub model_name: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSummary {
    pub provider: String,
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageTotal {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

pub struct TokenUsageRepository {
    connection: Mutex<Connection>,
}

/// `created_at >= ?` and `created_at <= ?` for the non-empty bounds.
fn range_clause(from: Option<&str>, to: Option<&str>) -> (String, Vec<SqlValue>) {
    let mut conditions: Vec<&str> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();
    if let Some(from) = from.filter(|value| !value.is_empty()) {
        conditions.push("created_at >= ?");
        params.push(SqlValue::Text(from.to_string()));
    }
    if let Some(to) = to.filter(|value| !value.is_empty()) {
        conditions.push("created_at <= ?");
        params.push(SqlValue::Text(to.to_string()));
    }
    let clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    (clause, params)
}

impl TokenUsageRepository {
    pub fn open(db_path: &str) -> Result<Self, StatsError> {
        let connection = crate::db::open(OpenOptions::new(db_path))?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn in_memory() -> Result<Self, StatsError> {
        Self::open(":memory:")
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `recordUsage`. The id is `tu-<epoch ms>-<8 hex>`.
    pub fn record_usage(
        &self,
        provider_id: &str,
        model_name: &str,
        prompt_tokens: i64,
        completion_tokens: i64,
        total_tokens: i64,
    ) -> Result<TokenUsageEntry, StatsError> {
        let id = format!("tu-{}-{}", now_ms(), short_uuid());
        let created_at = now_iso();
        let connection = self.lock();
        connection.execute(
            "INSERT INTO token_usage (id, provider_id, model_name, prompt_tokens, completion_tokens, total_tokens, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                provider_id,
                model_name,
                prompt_tokens,
                completion_tokens,
                total_tokens,
                created_at
            ],
        )?;
        Ok(TokenUsageEntry {
            id,
            provider_id: provider_id.to_string(),
            model_name: model_name.to_string(),
            prompt_tokens,
            completion_tokens,
            total_tokens,
            created_at,
        })
    }

    /// `getUsageSummary`: grouped by provider and model, largest total first.
    pub fn get_usage_summary(
        &self,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<Vec<TokenUsageSummary>, StatsError> {
        let (where_clause, params) = range_clause(from, to);
        let sql = format!(
            "SELECT provider_id, model_name,
               SUM(prompt_tokens) AS prompt_tokens,
               SUM(completion_tokens) AS completion_tokens,
               SUM(total_tokens) AS total_tokens
             FROM token_usage {where_clause}
             GROUP BY provider_id, model_name
             ORDER BY total_tokens DESC"
        );
        let connection = self.lock();
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(params), |row| {
            Ok(TokenUsageSummary {
                provider: row.get("provider_id")?,
                model: row.get("model_name")?,
                prompt_tokens: row.get("prompt_tokens")?,
                completion_tokens: row.get("completion_tokens")?,
                total_tokens: row.get("total_tokens")?,
            })
        })?;
        let summaries: Vec<TokenUsageSummary> = rows.collect::<Result<_, _>>()?;
        Ok(summaries)
    }

    /// `getTotalTokens`: zero when nothing matches, never `NULL`.
    pub fn get_total_tokens(
        &self,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<TokenUsageTotal, StatsError> {
        let (where_clause, params) = range_clause(from, to);
        let sql = format!(
            "SELECT
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
               COALESCE(SUM(total_tokens), 0) AS total_tokens
             FROM token_usage {where_clause}"
        );
        let connection = self.lock();
        let total = connection.query_row(&sql, params_from_iter(params), |row| {
            Ok(TokenUsageTotal {
                prompt_tokens: row.get("prompt_tokens")?,
                completion_tokens: row.get("completion_tokens")?,
                total_tokens: row.get("total_tokens")?,
            })
        })?;
        Ok(total)
    }

    /// `listEntries`: newest first, at most `limit` rows.
    pub fn list_entries(
        &self,
        from: Option<&str>,
        to: Option<&str>,
        limit: i64,
    ) -> Result<Vec<TokenUsageEntry>, StatsError> {
        let (where_clause, mut params) = range_clause(from, to);
        params.push(SqlValue::Integer(limit));
        let sql = format!(
            "SELECT id, provider_id, model_name, prompt_tokens, completion_tokens, total_tokens, created_at
             FROM token_usage {where_clause}
             ORDER BY created_at DESC
             LIMIT ?"
        );
        let connection = self.lock();
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(params), |row| {
            Ok(TokenUsageEntry {
                id: row.get("id")?,
                provider_id: row.get("provider_id")?,
                model_name: row.get("model_name")?,
                prompt_tokens: row.get("prompt_tokens")?,
                completion_tokens: row.get("completion_tokens")?,
                total_tokens: row.get("total_tokens")?,
                created_at: row.get("created_at")?,
            })
        })?;
        let entries: Vec<TokenUsageEntry> = rows.collect::<Result<_, _>>()?;
        Ok(entries)
    }

    pub fn get_entry_count(&self) -> Result<i64, StatsError> {
        let connection = self.lock();
        let count =
            connection.query_row("SELECT COUNT(*) FROM token_usage", [], |row| row.get(0))?;
        Ok(count)
    }

    /// `clearEntries`: returns the number of deleted rows.
    pub fn clear_entries(&self) -> Result<usize, StatsError> {
        let connection = self.lock();
        Ok(connection.execute("DELETE FROM token_usage", [])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_aggregates_and_clears() {
        let repository = TokenUsageRepository::in_memory().expect("open");
        let entry = repository
            .record_usage("openai", "gpt-4", 10, 5, 15)
            .expect("record");
        assert!(entry.id.starts_with("tu-"));
        repository
            .record_usage("openai", "gpt-4", 1, 1, 2)
            .expect("record");
        repository
            .record_usage("xai", "grok-3", 3, 3, 6)
            .expect("record");

        let summary = repository.get_usage_summary(None, None).expect("summary");
        assert_eq!(summary.len(), 2);
        assert_eq!(summary[0].provider, "openai");
        assert_eq!(summary[0].total_tokens, 17);
        assert_eq!(summary[0].prompt_tokens, 11);

        let total = repository.get_total_tokens(None, None).expect("total");
        assert_eq!(total.total_tokens, 23);
        assert_eq!(total.completion_tokens, 9);

        assert_eq!(repository.get_entry_count().expect("count"), 3);
        assert_eq!(
            repository.list_entries(None, None, 2).expect("list").len(),
            2
        );
        assert_eq!(repository.clear_entries().expect("clear"), 3);
        assert_eq!(repository.get_entry_count().expect("count"), 0);
    }

    #[test]
    fn empty_totals_are_zero_not_null() {
        let repository = TokenUsageRepository::in_memory().expect("open");
        let total = repository.get_total_tokens(None, None).expect("total");
        assert_eq!(total.total_tokens, 0);
        assert!(repository
            .get_usage_summary(Some("2000-01-01T00:00:00.000Z"), None)
            .expect("summary")
            .is_empty());
    }

    #[test]
    fn a_range_bound_excludes_rows_outside_it() {
        let repository = TokenUsageRepository::in_memory().expect("open");
        repository
            .record_usage("openai", "gpt-4", 1, 1, 2)
            .expect("record");
        let future = "2999-01-01T00:00:00.000Z";
        assert!(repository
            .list_entries(Some(future), None, 10)
            .expect("list")
            .is_empty());
    }
}
