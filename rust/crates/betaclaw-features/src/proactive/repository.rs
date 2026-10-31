//! Port of `src/server/proactive/repository.ts`.
//!
//! The TypeScript interface is synchronous, like `better-sqlite3`, and so is the
//! trait. Failures are returned rather than thrown, so the service can propagate
//! them and the subscribers can log them.

use super::types::{
    ProactiveDecision, ProactiveDecisionInput, ProactiveSignalInput, ProactiveSummaryRow,
};

/// Storage failures of the proactive store.
#[derive(Debug, thiserror::Error)]
pub enum ProactiveError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
}

/// `ProactiveRepository` from `repository.ts:7-14`.
pub trait ProactiveRepository {
    /// Stores the signals in one transaction and returns how many were written.
    fn insert_signals(&self, signals: &[ProactiveSignalInput]) -> Result<usize, ProactiveError>;

    /// Sums the signals of one user and persona created at or after `since_iso`,
    /// grouped by signal key.
    fn summarize_signals(
        &self,
        user_id: &str,
        persona_id: &str,
        since_iso: &str,
    ) -> Result<Vec<ProactiveSummaryRow>, ProactiveError>;

    /// Newest decisions first. The limit is clamped to `1..=200` by the store.
    fn list_recent_decisions(
        &self,
        user_id: &str,
        persona_id: &str,
        limit: i64,
    ) -> Result<Vec<ProactiveDecision>, ProactiveError>;

    fn insert_decision(
        &self,
        input: &ProactiveDecisionInput,
    ) -> Result<ProactiveDecision, ProactiveError>;
}
