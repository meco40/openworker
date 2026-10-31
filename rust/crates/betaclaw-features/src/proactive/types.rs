//! Port of `src/server/proactive/types.ts`.
//!
//! `ProactiveCandidateKey` is a plain `String` here. `ProactiveDecision::decision`
//! keeps the raw database text, like `Conversation::channel_type` in
//! `messages_store`: the table has no `CHECK`, so the port neither rewrites nor
//! rejects a stored value. [`ProactiveDecisionType`] is the typed value the service
//! writes.

use serde::{Deserialize, Serialize};

use crate::messages_store::MessageRole;

/// `ProactiveDecisionType` from `types.ts:3`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProactiveDecisionType {
    Suggest,
    Defer,
}

impl ProactiveDecisionType {
    pub fn as_str(self) -> &'static str {
        match self {
            ProactiveDecisionType::Suggest => "suggest",
            ProactiveDecisionType::Defer => "defer",
        }
    }
}

/// `ProactiveMessageInput` from `types.ts:5-9`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProactiveMessageInput {
    pub role: MessageRole,
    pub content: String,
    pub created_at: Option<String>,
}

/// `ProactiveSignalInput` from `types.ts:11-18`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProactiveSignalInput {
    pub user_id: String,
    pub persona_id: String,
    pub signal_key: String,
    pub weight: f64,
    pub source: String,
    pub created_at: String,
}

/// `ProactiveSummaryRow` from `types.ts:20-25`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProactiveSummaryRow {
    pub signal_key: String,
    pub total_weight: f64,
    pub occurrences: i64,
    pub last_seen_at: String,
}

/// `ProactiveDecision` from `types.ts:27-36`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProactiveDecision {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub candidate_key: String,
    /// Unvalidated. The values the service writes are [`ProactiveDecisionType::as_str`].
    pub decision: String,
    pub score: f64,
    pub reason: String,
    pub created_at: String,
}

/// Argument of `insertDecision` (`repository.ts:11-13`). The id is generated; a
/// missing or empty `created_at` becomes the current time.
#[derive(Debug, Clone, PartialEq)]
pub struct ProactiveDecisionInput {
    pub user_id: String,
    pub persona_id: String,
    pub candidate_key: String,
    pub decision: ProactiveDecisionType,
    pub score: f64,
    pub reason: String,
    pub created_at: Option<String>,
}
