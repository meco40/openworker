//! Port of `src/server/proactive/sqliteProactiveRepository.ts`.
//!
//! Opens the database and creates the three proactive tables with their indexes.
//! Those tables live in the shared `.local/messages.db` unless
//! `PROACTIVE_DB_PATH` or `MESSAGES_DB_PATH` names another file, see
//! [`default_proactive_db_path`]. The migration only adds, so the TypeScript backend
//! can keep reading and writing the same rows.

use rusqlite::{params, Connection, Row};

use crate::db::{self, default_db_path, OpenOptions};
use crate::messages_store::now_iso;

use super::repository::{ProactiveError, ProactiveRepository};
use super::types::{
    ProactiveDecision, ProactiveDecisionInput, ProactiveSignalInput, ProactiveSummaryRow,
};

const MIGRATIONS: &str = "
    CREATE TABLE IF NOT EXISTS proactive_signals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      signal_key TEXT NOT NULL,
      weight REAL NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proactive_decisions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      candidate_key TEXT NOT NULL,
      decision TEXT NOT NULL,
      score REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proactive_signals_persona_time
      ON proactive_signals (user_id, persona_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_signals_key
      ON proactive_signals (user_id, persona_id, signal_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proactive_decisions_persona_time
      ON proactive_decisions (user_id, persona_id, created_at DESC);
";

/// SQLite-backed proactive store (`SqliteProactiveRepository`).
pub struct SqliteProactiveRepository {
    connection: Connection,
}

impl SqliteProactiveRepository {
    /// `new SqliteProactiveRepository(dbPath)`: opens the file and runs the migration.
    pub fn open(db_path: &str) -> Result<Self, ProactiveError> {
        let connection = db::open(OpenOptions::new(db_path))?;
        connection.execute_batch(MIGRATIONS)?;
        Ok(Self { connection })
    }

    /// The constructor without an argument, which uses [`default_proactive_db_path`].
    pub fn open_default() -> Result<Self, ProactiveError> {
        Self::open(&default_proactive_db_path())
    }
}

impl ProactiveRepository for SqliteProactiveRepository {
    fn insert_signals(&self, signals: &[ProactiveSignalInput]) -> Result<usize, ProactiveError> {
        if signals.is_empty() {
            return Ok(0);
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO proactive_signals (
                   id, user_id, persona_id, signal_key, weight, source, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for signal in signals {
                statement.execute(params![
                    new_id("ps"),
                    signal.user_id,
                    signal.persona_id,
                    signal.signal_key,
                    signal.weight,
                    signal.source,
                    signal.created_at,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(signals.len())
    }

    fn summarize_signals(
        &self,
        user_id: &str,
        persona_id: &str,
        since_iso: &str,
    ) -> Result<Vec<ProactiveSummaryRow>, ProactiveError> {
        let mut statement = self.connection.prepare(
            "SELECT signal_key, SUM(weight), COUNT(*), MAX(created_at)
             FROM proactive_signals
             WHERE user_id = ?1 AND persona_id = ?2 AND created_at >= ?3
             GROUP BY signal_key",
        )?;
        let rows = statement.query_map(params![user_id, persona_id, since_iso], |row| {
            Ok(ProactiveSummaryRow {
                signal_key: row.get(0)?,
                total_weight: row.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                occurrences: row.get(2)?,
                last_seen_at: row.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(ProactiveError::from)
    }

    fn list_recent_decisions(
        &self,
        user_id: &str,
        persona_id: &str,
        limit: i64,
    ) -> Result<Vec<ProactiveDecision>, ProactiveError> {
        let safe_limit = limit.clamp(1, 200);
        let mut statement = self.connection.prepare(
            "SELECT id, user_id, persona_id, candidate_key, decision, score, reason, created_at
             FROM proactive_decisions
             WHERE user_id = ?1 AND persona_id = ?2
             ORDER BY created_at DESC
             LIMIT ?3",
        )?;
        let rows =
            statement.query_map(params![user_id, persona_id, safe_limit], decision_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(ProactiveError::from)
    }

    fn insert_decision(
        &self,
        input: &ProactiveDecisionInput,
    ) -> Result<ProactiveDecision, ProactiveError> {
        let decision = ProactiveDecision {
            id: new_id("pd"),
            user_id: input.user_id.clone(),
            persona_id: input.persona_id.clone(),
            candidate_key: input.candidate_key.clone(),
            decision: input.decision.as_str().to_string(),
            score: input.score,
            reason: input.reason.clone(),
            created_at: input
                .created_at
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(now_iso),
        };
        self.connection.execute(
            "INSERT INTO proactive_decisions (
               id, user_id, persona_id, candidate_key, decision, score, reason, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                decision.id,
                decision.user_id,
                decision.persona_id,
                decision.candidate_key,
                decision.decision,
                decision.score,
                decision.reason,
                decision.created_at,
            ],
        )?;
        Ok(decision)
    }
}

fn decision_from_row(row: &Row<'_>) -> rusqlite::Result<ProactiveDecision> {
    Ok(ProactiveDecision {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        persona_id: row.get("persona_id")?,
        candidate_key: row.get("candidate_key")?,
        decision: row.get("decision")?,
        score: row.get("score")?,
        reason: row.get("reason")?,
        created_at: row.get("created_at")?,
    })
}

/// `ps-<Date.now()>-<8 hex>` and `pd-…`, the id shape of the TypeScript store.
fn new_id(prefix: &str) -> String {
    let uuid = uuid::Uuid::new_v4().to_string();
    format!(
        "{prefix}-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        &uuid[..8]
    )
}

/// `PROACTIVE_DB_PATH || MESSAGES_DB_PATH || '.local/messages.db'`
/// (`sqliteProactiveRepository.ts:39`). The relative fallback is anchored at
/// `WORKSPACE_ROOT` like `messages_store::default_messages_db_path`.
pub fn default_proactive_db_path() -> String {
    ["PROACTIVE_DB_PATH", "MESSAGES_DB_PATH"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| default_db_path("messages.db"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(signal_key: &str, weight: f64, created_at: &str) -> ProactiveSignalInput {
        ProactiveSignalInput {
            user_id: "u-1".to_string(),
            persona_id: "p-1".to_string(),
            signal_key: signal_key.to_string(),
            weight,
            source: "chat".to_string(),
            created_at: created_at.to_string(),
        }
    }

    #[test]
    fn summaries_aggregate_per_key_inside_the_window() {
        let repository = SqliteProactiveRepository::open(":memory:").expect("open");
        let stored = repository
            .insert_signals(&[
                signal("bitcoin.news", 0.6, "2026-01-02T00:00:00.000Z"),
                signal("bitcoin.news", 0.6, "2026-01-03T00:00:00.000Z"),
                signal("bitcoin.news", 0.6, "2025-06-01T00:00:00.000Z"),
            ])
            .expect("insert");
        assert_eq!(stored, 3);

        let rows = repository
            .summarize_signals("u-1", "p-1", "2026-01-01T00:00:00.000Z")
            .expect("summarize");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].occurrences, 2);
        assert!((rows[0].total_weight - 1.2).abs() < 1e-9);
        assert_eq!(rows[0].last_seen_at, "2026-01-03T00:00:00.000Z");
    }
}
