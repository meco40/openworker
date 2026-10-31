//! Trait ports for the sources that recall reads and that live in other slices.
//!
//! Each method mirrors one TypeScript call made from `recall/**`:
//!
//! | Port | Slice | TypeScript caller |
//! | --- | --- | --- |
//! | [`RecallWorldModel`] | S6 World Model | `retrieveContext` in `recall/index.ts` |
//! | [`RecallKnowledge`] | S7 Knowledge | `ensureKnowledgeIngestedForConversation`, `KnowledgeRetrievalServiceLike.retrieve` in `recall/search/knowledge.ts` |
//! | [`RecallMemory`] | S5 Memory | `getMemoryService()` in `recall/index.ts`, `search/strict.ts`, `learning/feedback.ts` |
//! | [`RecallChatSearch`] | `messages_store` | `searchMessages` injected into `RecallService` |
//!
//! The memory and world-model ports are async because the TypeScript callers
//! await them. A synchronous backend (for example
//! [`crate::memory::service::MemoryService`]) fits behind them by returning its
//! result directly. The chat search is synchronous because the Rust store is.
//! The ports require `Sync`, because the service is shared across tasks. The
//! store is not `Sync` (it wraps a `rusqlite::Connection`), so the chat port is
//! implemented for `Mutex<MessagesStore>`.

use std::future::Future;

use crate::memory::service::{MemoryStoreInput, RecallRequest};
use crate::memory::types::{MemoryFeedbackSignal, MemoryRecallResult};
use crate::messages_store::{MessageRepositoryError, SearchMessagesOptions, StoredMessage};
use crate::world_model::retrieval::index::{RetrievalContextResult, RetrieveContextInput};

/// A failure reported by one of the source ports.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct RecallSourceError(pub String);

/// `{ userId, personaId, conversationId, query, includeSemantic }` of
/// `KnowledgeRetrievalServiceLike.retrieve`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnowledgeRetrieveInput<'a> {
    pub user_id: &'a str,
    pub persona_id: &'a str,
    pub conversation_id: &'a str,
    pub query: &'a str,
    pub include_semantic: bool,
}

/// World-model retrieval (S6).
pub trait RecallWorldModel: Send + Sync {
    /// `retrieveContext(input)`. An `Err` is a failed source in the parallel
    /// fan-out, which the caller treats as an empty source.
    fn retrieve_context(
        &self,
        input: &RetrieveContextInput,
    ) -> impl Future<Output = Result<RetrievalContextResult, RecallSourceError>> + Send;
}

/// Knowledge layer (S7).
pub trait RecallKnowledge: Send + Sync {
    /// `ensureKnowledgeIngestedForConversation`. A failure is logged and the
    /// retrieval still runs.
    fn ensure_ingested(
        &self,
        conversation_id: &str,
        user_id: &str,
        persona_id: &str,
    ) -> impl Future<Output = Result<(), RecallSourceError>> + Send;

    /// `KnowledgeRetrievalServiceLike.retrieve`, returning the raw `context`
    /// string.
    fn retrieve(
        &self,
        input: &KnowledgeRetrieveInput<'_>,
    ) -> impl Future<Output = Result<String, RecallSourceError>> + Send;
}

/// Long-term memory (S5).
pub trait RecallMemory: Send + Sync {
    /// `recallDetailed(personaId, query, limit, userId, options)`.
    fn recall_detailed(
        &self,
        persona_id: &str,
        query: &str,
        limit: i64,
        user_id: &str,
        options: &RecallRequest,
    ) -> impl Future<Output = Result<MemoryRecallResult, RecallSourceError>> + Send;

    /// `registerFeedback(personaId, nodeIds, signal, userId)`.
    fn register_feedback(
        &self,
        persona_id: &str,
        node_ids: &[String],
        signal: MemoryFeedbackSignal,
        user_id: &str,
    ) -> impl Future<Output = Result<(), RecallSourceError>> + Send;

    /// `storeMemory(input)`.
    fn store_memory(
        &self,
        input: &MemoryStoreInput,
    ) -> impl Future<Output = Result<(), RecallSourceError>> + Send;
}

/// Full-text search over chat messages (`messages_store`, FTS5).
pub trait RecallChatSearch: Send + Sync {
    /// `searchMessages(query, options)`.
    fn search_messages(
        &self,
        query: &str,
        options: &SearchMessagesOptions<'_>,
    ) -> Result<Vec<StoredMessage>, MessageRepositoryError>;
}
