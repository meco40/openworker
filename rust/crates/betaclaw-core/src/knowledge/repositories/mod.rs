//! Port of `src/server/knowledge/repositories/index.ts` — the sub-repository
//! aggregator of the Knowledge slice.
//!
//! | TypeScript                                 | Rust |
//! | ------------------------------------------ | ---- |
//! | `repositories/index.ts:2-10` (re-exports)   | the `pub mod`/`pub use` list below |
//! | (`new Error(...)` sprinkled through the repositories) | [`KnowledgeRepositoryError`] |
//! | `new Date().toISOString()` in every repository | [`now_iso`] |
//! | `String(x \|\| '').trim() \|\| fallback` | [`trimmed_or`] |
//! | `Date.now()`                             | [`js_now_millis`] |
//! | `crypto.randomBytes(n).toString('hex')`  | [`random_hex`] |
//!
//! The eight sub-repositories all open the same `Connection` the future
//! `sqliteKnowledgeRepository.ts` port owns; each is a borrowed view, exactly
//! like the seven query modules of [`crate::messages_store`]. None of them
//! resolves the database path — that belongs to the facade module (a later S7
//! package), together with `KNOWLEDGE_DB_PATH || MESSAGES_DB_PATH ||
//! '.local/messages.db'` (`sqliteKnowledgeRepository.ts:36`).
//!
//! # Deviation
//!
//! The TypeScript throws bare `Error`s; the port returns a typed
//! [`KnowledgeRepositoryError`]. The one explicit message is kept verbatim
//! (`Entity <id> not found`); the storage failures carry the underlying driver
//! message the way the other SQLite stores of this crate do.

pub mod audit_repository;
pub mod checkpoint_repository;
pub mod entity_repository;
pub mod episode_repository;
pub mod event_repository;
pub mod ledger_repository;
pub mod migrations;
pub mod summary_repository;
pub mod utils;

pub use audit_repository::AuditRepository;
pub use checkpoint_repository::CheckpointRepository;
pub use entity_repository::{strip_possessive_prefix, EntityRepository};
pub use episode_repository::EpisodeRepository;
pub use event_repository::EventRepository;
pub use ledger_repository::LedgerRepository;
pub use migrations::{has_column, run_knowledge_migrations};
pub use summary_repository::SummaryRepository;
pub use utils::{
    as_limit, parse_iso, parse_json_array, parse_json_object, to_source_refs, to_string_array,
};

/// The error every sub-repository returns.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KnowledgeRepositoryError {
    /// A failed statement of the underlying SQLite driver.
    #[error("{0}")]
    Storage(String),

    /// A write that promised to read its row back found nothing. The TypeScript
    /// would throw a `TypeError` on the `undefined`; the port names the table.
    #[error("missing row in {context}")]
    MissingRow { context: String },

    /// `throw new Error(\`Entity ${entityId} not found\`)`
    /// (`entityRepository.ts:269`).
    #[error("Entity {entity_id} not found")]
    EntityNotFound { entity_id: String },
}

impl From<rusqlite::Error> for KnowledgeRepositoryError {
    fn from(error: rusqlite::Error) -> Self {
        KnowledgeRepositoryError::Storage(format!("database error: {error}"))
    }
}

impl From<serde_json::Error> for KnowledgeRepositoryError {
    fn from(error: serde_json::Error) -> Self {
        KnowledgeRepositoryError::Storage(format!("JSON error: {error}"))
    }
}

/// `new Date().toISOString()` — millisecond precision, always UTC.
pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `String(value || '').trim() || fallback`.
pub(crate) fn trimmed_or(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// `Date.now()`: milliseconds since the Unix epoch.
pub(crate) fn js_now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `crypto.randomBytes(len).toString('hex')`.
pub(crate) fn random_hex(len: usize) -> String {
    let mut buffer = vec![0u8; len];
    if getrandom::fill(&mut buffer).is_err() {
        // A failure here only degrades the id suffix; the caller already has a
        // unique timestamp prefix.
        return "0".repeat(len * 2);
    }
    let mut out = String::with_capacity(len * 2);
    for byte in buffer {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trimmed_or_falls_back_for_blank_input() {
        assert_eq!(trimmed_or("  work  ", "general"), "work");
        assert_eq!(trimmed_or("", "general"), "general");
        assert_eq!(trimmed_or("   ", "general"), "general");
    }

    #[test]
    fn random_hex_has_two_chars_per_byte() {
        let value = random_hex(4);
        assert_eq!(value.len(), 8);
        assert!(value.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_ne!(random_hex(8), random_hex(8), "random, not constant");
    }

    #[test]
    fn the_error_message_for_a_missing_entity_is_verbatim() {
        let error = KnowledgeRepositoryError::EntityNotFound {
            entity_id: "ent-1".to_string(),
        };
        assert_eq!(error.to_string(), "Entity ent-1 not found");
    }
}
