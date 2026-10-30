//! Port of `src/server/knowledge/ingestion/types.ts` (1-91).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `IngestionCursorLike` (`:11-14`) | [`IngestionCursorLike`] |
//! | `KnowledgeExtractorLike` (`:16-18`) | [`KnowledgeExtractorLike`] |
//! | `KnowledgeRepositoryLike` (`:20-37`) | [`KnowledgeRepository`] (the full trait; the TS subset is covered by the narrow ports of each file) |
//! | `MemoryServiceLike` (`:39-50`) | [`MemoryFactService`] |
//! | `KnowledgeIngestionServiceDependencies` (`:52-63`) | the constructor arguments of [`super::service::KnowledgeIngestionService`] |
//! | `KnowledgeIngestionServiceOptions` (`:65-67`) | [`KnowledgeIngestionServiceOptions`] |
//! | `KnowledgeIngestionError` (`:69-73`) | [`KnowledgeIngestionError`] |
//! | `KnowledgeIngestionRunResult` (`:75-79`) | [`KnowledgeIngestionRunResult`] |
//! | `IngestConversationWindowInput` (`:81-89`) | [`IngestConversationWindowInput`] |
//! | `MessageRepository['markMessagesMemoryPending']` (`:62`) | [`MessageMemoryMarker`] |
//!
//! # Deviations
//!
//! * `MemoryServiceLike` has `store` and an optional `storeMemory`. The port has
//!   one [`MemoryFactService::store_fact`], because both TypeScript calls take the
//!   same arguments.
//! * `KnowledgeExtractorLike.extract` is `Promise`-based. The port uses an
//!   `impl Future + Send` return type.

use std::future::Future;

use serde_json::{Map, Value};

use crate::knowledge::extractor::{ExtractionModel, KnowledgeExtractor};
use crate::knowledge::ingestion_cursor::{
    IngestionCheckpointStore, IngestionCursorError, IngestionMessageSource,
    KnowledgeIngestionCursor,
};
use crate::knowledge::prompts::ExtractionPersonaContext;
use crate::knowledge::repository::KnowledgeError;
use crate::messages_store::{MessageRepositoryError, MessagesStore, StoredMessage};

// Re-exports that `types.ts:90-91` provides for backward compatibility. They
// also bring the names into scope for this file.
pub use crate::knowledge::extractor::{KnowledgeExtractionInput, KnowledgeExtractionResult};
pub use crate::knowledge::ingestion_cursor::IngestionWindow;

/// `IngestionCursorLike` (`types.ts:11-14`).
pub trait IngestionCursorLike {
    /// `getPendingWindows(limitConversations)`.
    fn get_pending_windows(
        &self,
        limit_conversations: i64,
    ) -> Result<Vec<IngestionWindow>, IngestionCursorError>;

    /// `markWindowProcessed(window)`.
    fn mark_window_processed(&self, window: &IngestionWindow) -> Result<(), KnowledgeError>;
}

impl<M, K> IngestionCursorLike for KnowledgeIngestionCursor<'_, M, K>
where
    M: IngestionMessageSource + ?Sized,
    K: IngestionCheckpointStore + ?Sized,
{
    fn get_pending_windows(
        &self,
        limit_conversations: i64,
    ) -> Result<Vec<IngestionWindow>, IngestionCursorError> {
        KnowledgeIngestionCursor::get_pending_windows(self, limit_conversations)
    }

    fn mark_window_processed(&self, window: &IngestionWindow) -> Result<(), KnowledgeError> {
        KnowledgeIngestionCursor::mark_window_processed(self, window)
    }
}

/// `KnowledgeExtractorLike` (`types.ts:16-18`).
pub trait KnowledgeExtractorLike {
    /// `extract(input)`. Never fails: the extractor falls back to a result.
    fn extract(
        &self,
        input: &KnowledgeExtractionInput,
    ) -> impl Future<Output = KnowledgeExtractionResult> + Send;
}

impl<M: ExtractionModel + Sync> KnowledgeExtractorLike for KnowledgeExtractor<M> {
    async fn extract(&self, input: &KnowledgeExtractionInput) -> KnowledgeExtractionResult {
        KnowledgeExtractor::extract(self, input).await
    }
}

/// An error from the memory service while storing or updating a fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryFactError(pub String);

impl std::fmt::Display for MemoryFactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The arguments of `storeMemory({ personaId, type: 'fact', content, importance, userId, metadata })`.
#[derive(Debug, Clone, PartialEq)]
pub struct FactStoreInput {
    pub persona_id: String,
    pub content: String,
    pub importance: i64,
    pub user_id: String,
    pub metadata: Map<String, Value>,
}

/// One node of `listPage({ page: 1, pageSize: 200, type: 'fact' })`.
#[derive(Debug, Clone, PartialEq)]
pub struct ExistingFactNode {
    pub id: String,
    pub content: String,
    pub metadata: Option<Map<String, Value>>,
}

/// `MemoryServiceLike` (`types.ts:39-50`): the fact operations of the memory slice.
pub trait MemoryFactService {
    /// Stores a fact. `Ok(Some(id))` when the store returns a non-empty id,
    /// `Ok(None)` when it does not.
    fn store_fact(
        &self,
        input: FactStoreInput,
    ) -> impl Future<Output = Result<Option<String>, MemoryFactError>> + Send;

    /// `listPage(personaId, { page: 1, pageSize, type: 'fact' }, userId).nodes`.
    fn list_fact_nodes(
        &self,
        persona_id: &str,
        user_id: &str,
        page_size: usize,
    ) -> impl Future<Output = Result<Vec<ExistingFactNode>, MemoryFactError>> + Send;

    /// `update(personaId, memoryId, { metadata }, userId)`: merges the metadata.
    fn update_memory_metadata(
        &self,
        persona_id: &str,
        memory_id: &str,
        user_id: &str,
        metadata: Map<String, Value>,
    ) -> impl Future<Output = Result<(), MemoryFactError>> + Send;
}

/// `messageRepository.markMessagesMemoryPending` (`types.ts:62`).
pub trait MessageMemoryMarker {
    fn mark_messages_memory_pending(
        &self,
        message_ids: &[&str],
        pending: bool,
        error_message: Option<&str>,
    ) -> Result<(), MessageRepositoryError>;
}

impl MessageMemoryMarker for MessagesStore {
    fn mark_messages_memory_pending(
        &self,
        message_ids: &[&str],
        pending: bool,
        error_message: Option<&str>,
    ) -> Result<(), MessageRepositoryError> {
        MessagesStore::mark_messages_memory_pending(self, message_ids, pending, error_message)
    }
}

/// `KnowledgeIngestionServiceOptions` (`types.ts:65-67`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct KnowledgeIngestionServiceOptions {
    pub min_messages_per_batch: Option<f64>,
}

/// `KnowledgeIngestionError` (`types.ts:69-73`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnowledgeIngestionError {
    pub conversation_id: String,
    pub persona_id: String,
    pub reason: String,
}

/// `KnowledgeIngestionRunResult` (`types.ts:75-79`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KnowledgeIngestionRunResult {
    pub processed_conversations: usize,
    pub processed_messages: usize,
    pub errors: Vec<KnowledgeIngestionError>,
}

/// `IngestConversationWindowInput` (`types.ts:81-89`).
#[derive(Debug, Clone)]
pub struct IngestConversationWindowInput {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub messages: Vec<StoredMessage>,
    pub summary_text: Option<String>,
    pub persona_context: Option<ExtractionPersonaContext>,
}
