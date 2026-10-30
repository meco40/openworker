//! Port of `src/server/knowledge/runtime.ts` (1-293): the functions of the
//! runtime that do work.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `ensureKnowledgeIngestedForConversation` (`:148-187`) | [`ensure_knowledge_ingested_for_conversation`] |
//! | the `runCleanup` task of `getKnowledgeRuntimeLoop` (`:215-241`) | [`run_cleanup_pass`] |
//! | the `runReconciliation` task (`:242-272`) | [`run_reconciliation_pass`] |
//! | `maintenanceEveryNthTick: 10` (`:273`) | [`MAINTENANCE_EVERY_NTH_TICK`] |
//! | `MemoryService.snapshot` (used at `:255`) | [`MemorySnapshot`] |
//!
//! # Not ported here
//!
//! The `globalThis` singletons of `runtime.ts` (`getKnowledgeRepository`,
//! `getKnowledgeIngestionService`, `getKnowledgeRetrievalService`, the loop
//! factory) and the factories that wire the model hub (`runExtractionModelViaHub`),
//! the memory runtime (`tryGetMemoryService`) and the personas
//! (`getPersonaRepository`). Those join the process-wide composition, which
//! belongs to the gateway and to the S5, S6 and S8 slices. The gateway builds the
//! objects with the types of this module and passes them in.
//!
//! # Deviations
//!
//! * `ensureKnowledgeIngestedForConversation` builds a one-shot service with
//!   `minMessagesPerBatch: 1`. The caller passes that service instead, and it must
//!   be built with the same repository as the service it shares state with.
//! * The cleanup and reconciliation passes return their values in a `Result`; the
//!   TypeScript logs them. The logging is kept, and the reconciliation error is
//!   returned to the caller, which logs `reconciliation skipped`.

use tracing::info;

use crate::knowledge::cleanup_detector::{
    detect_low_relevance, detect_placeholder, detect_stale_relative_time,
};
use crate::knowledge::ingestion::service::{IngestionServiceError, KnowledgeIngestionService};
use crate::knowledge::ingestion::types::{
    IngestConversationWindowInput, IngestionCursorLike, KnowledgeExtractorLike, MemoryFactError,
    MemoryFactService, MessageMemoryMarker,
};
use crate::knowledge::ingestion::world_model_port::WorldModelPort;
use crate::knowledge::reconciliation::{detect_orphans, StoreEntry};
use crate::knowledge::repository::{KnowledgeError, KnowledgeRepository, ListKnowledgeFilter};
use crate::messages_store::{MessageRepositoryError, MessagesStore};
use std::future::Future;

/// `maintenanceEveryNthTick` of the knowledge loop (`runtime.ts:273`).
pub const MAINTENANCE_EVERY_NTH_TICK: u64 = 10;

/// The scopes of the list and page limits the passes use (`limit: 10_000`).
const SCOPE_PAGE_LIMIT: i64 = 10_000;

/// `messageRepo.listMessages(conversationId, 1000, undefined, userId)`.
const CONVERSATION_MESSAGE_LIMIT: i64 = 1000;

/// The input of [`ensure_knowledge_ingested_for_conversation`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnsureIngestedInput {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
}

/// The result of [`ensure_knowledge_ingested_for_conversation`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnsureIngestedResult {
    pub triggered: bool,
    pub pending_messages: usize,
}

/// An error of [`ensure_knowledge_ingested_for_conversation`].
#[derive(Debug)]
pub enum EnsureIngestedError {
    Messages(MessageRepositoryError),
    Ingestion(IngestionServiceError),
    Knowledge(KnowledgeError),
}

impl std::fmt::Display for EnsureIngestedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnsureIngestedError::Messages(error) => write!(f, "{error}"),
            EnsureIngestedError::Ingestion(error) => write!(f, "{error}"),
            EnsureIngestedError::Knowledge(error) => write!(f, "{error}"),
        }
    }
}

impl From<MessageRepositoryError> for EnsureIngestedError {
    fn from(error: MessageRepositoryError) -> Self {
        EnsureIngestedError::Messages(error)
    }
}

impl From<IngestionServiceError> for EnsureIngestedError {
    fn from(error: IngestionServiceError) -> Self {
        EnsureIngestedError::Ingestion(error)
    }
}

impl From<KnowledgeError> for EnsureIngestedError {
    fn from(error: KnowledgeError) -> Self {
        EnsureIngestedError::Knowledge(error)
    }
}

/// `ensureKnowledgeIngestedForConversation(input)` (`runtime.ts:148-187`): when the
/// conversation has messages after its checkpoint, ingests them now.
pub async fn ensure_knowledge_ingested_for_conversation<C, X, K, W, M, P>(
    messages: &MessagesStore,
    one_shot_service: &KnowledgeIngestionService<C, X, K, W, M, P>,
    input: &EnsureIngestedInput,
) -> Result<EnsureIngestedResult, EnsureIngestedError>
where
    C: IngestionCursorLike + Sync,
    X: KnowledgeExtractorLike + Sync,
    K: KnowledgeRepository + Sync,
    W: WorldModelPort + Sync,
    M: MemoryFactService + Sync,
    P: MessageMemoryMarker + Sync,
{
    let not_triggered = EnsureIngestedResult {
        triggered: false,
        pending_messages: 0,
    };
    let conversation_id = input.conversation_id.trim();
    let user_id = input.user_id.trim();
    let persona_id = input.persona_id.trim();
    if conversation_id.is_empty() || user_id.is_empty() || persona_id.is_empty() {
        return Ok(not_triggered);
    }

    let conversation_messages = messages.list_messages(
        conversation_id,
        CONVERSATION_MESSAGE_LIMIT,
        None,
        Some(user_id),
    )?;
    if conversation_messages.is_empty() {
        return Ok(not_triggered);
    }

    let checkpoint = one_shot_service
        .repository()
        .get_ingestion_checkpoint(conversation_id, user_id, Some(persona_id))?
        .map(|value| value.last_seq)
        .unwrap_or(0);
    let pending_messages = conversation_messages
        .iter()
        .filter(|message| message.seq.unwrap_or(0) > checkpoint)
        .count();
    if pending_messages == 0 {
        return Ok(not_triggered);
    }

    one_shot_service
        .ingest_conversation_window(IngestConversationWindowInput {
            conversation_id: conversation_id.to_string(),
            user_id: user_id.to_string(),
            persona_id: persona_id.to_string(),
            workspace_id: None,
            messages: conversation_messages,
            summary_text: None,
            persona_context: None,
        })
        .await?;

    Ok(EnsureIngestedResult {
        triggered: true,
        pending_messages,
    })
}

/// The episode filter of one scope with the page limit of the maintenance passes.
fn scope_filter(user_id: &str, persona_id: &str) -> ListKnowledgeFilter {
    ListKnowledgeFilter {
        user_id: user_id.to_string(),
        persona_id: persona_id.to_string(),
        counterpart: None,
        topic_key: None,
        from: None,
        to: None,
        limit: Some(SCOPE_PAGE_LIMIT),
    }
}

/// The cleanup task (`runtime.ts:215-241`): counts the facts that look like
/// placeholders, low-relevance text or stale relative times. It reports and does
/// not delete. Returns the count.
pub fn run_cleanup_pass<K: KnowledgeRepository + ?Sized>(
    repo: &K,
    now_millis: i64,
) -> Result<usize, KnowledgeError> {
    let mut cleaned = 0_usize;
    for scope in repo.list_knowledge_scopes()? {
        for episode in repo.list_episodes(&scope_filter(&scope.user_id, &scope.persona_id))? {
            for fact in &episode.facts {
                if detect_placeholder(fact) || detect_low_relevance(fact) {
                    cleaned += 1;
                }
                if !episode.updated_at.is_empty()
                    && detect_stale_relative_time(fact, &episode.updated_at, now_millis)
                {
                    cleaned += 1;
                }
            }
        }
    }
    if cleaned > 0 {
        info!(
            cleaned,
            "[knowledge] cleanup detected stale/placeholder facts"
        );
    }
    Ok(cleaned)
}

/// The memory read of the reconciliation pass: the entries of one scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotEntry {
    pub id: String,
    pub content: String,
}

/// `MemoryService.snapshot(personaId, userId)`, the part the reconciliation uses.
pub trait MemorySnapshot {
    fn snapshot(
        &self,
        persona_id: &str,
        user_id: &str,
    ) -> impl Future<Output = Result<Vec<SnapshotEntry>, MemoryFactError>> + Send;
}

/// An error of [`run_reconciliation_pass`]: the memory read or the knowledge read.
#[derive(Debug, thiserror::Error)]
pub enum ReconciliationError {
    #[error("{0}")]
    Memory(MemoryFactError),
    #[error(transparent)]
    Knowledge(#[from] KnowledgeError),
}

impl From<MemoryFactError> for ReconciliationError {
    fn from(error: MemoryFactError) -> Self {
        ReconciliationError::Memory(error)
    }
}

/// The reconciliation task (`runtime.ts:242-272`): compares the memory entries
/// with the knowledge rows that reference them, and counts the orphans on both
/// sides. Returns `(mem0 orphans, knowledge orphans)`.
pub async fn run_reconciliation_pass<K, M>(
    repo: &K,
    memory: Option<&M>,
) -> Result<(usize, usize), ReconciliationError>
where
    K: KnowledgeRepository + Sync + ?Sized,
    M: MemorySnapshot + Sync + ?Sized,
{
    let mut mem0_orphans_found = 0_usize;
    let mut knowledge_orphans_found = 0_usize;
    for scope in repo.list_knowledge_scopes()? {
        let filter = scope_filter(&scope.user_id, &scope.persona_id);
        let episodes = repo.list_episodes(&filter)?;
        let ledger = repo.list_meeting_ledger(&filter)?;

        let mut knowledge_entries: Vec<StoreEntry> = Vec::new();
        for entry in &episodes {
            for external_ref in &entry.memory_ids {
                knowledge_entries.push(StoreEntry {
                    id: format!("{}:{external_ref}", entry.id),
                    content: entry.teaser.clone(),
                    external_ref: Some(external_ref.clone()),
                });
            }
        }
        for entry in &ledger {
            for external_ref in &entry.memory_ids {
                knowledge_entries.push(StoreEntry {
                    id: format!("{}:{external_ref}", entry.id),
                    content: entry.topic_key.clone(),
                    external_ref: Some(external_ref.clone()),
                });
            }
        }

        let mem0_entries: Vec<StoreEntry> = match memory {
            Some(memory) => memory
                .snapshot(&scope.persona_id, &scope.user_id)
                .await?
                .into_iter()
                .map(|entry| StoreEntry {
                    id: entry.id,
                    content: entry.content,
                    external_ref: None,
                })
                .collect(),
            None => Vec::new(),
        };

        let report = detect_orphans(&mem0_entries, &knowledge_entries);
        mem0_orphans_found += report.mem0_orphans_found;
        knowledge_orphans_found += report.knowledge_orphans_found;
    }
    if knowledge_orphans_found > 0 || mem0_orphans_found > 0 {
        info!(
            mem0_orphans_found,
            knowledge_orphans_found, "[knowledge] reconciliation found orphans"
        );
    }
    Ok((mem0_orphans_found, knowledge_orphans_found))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_maintenance_interval_matches_the_typescript_default() {
        assert_eq!(MAINTENANCE_EVERY_NTH_TICK, 10);
    }

    #[test]
    fn the_scope_filter_uses_the_page_limit() {
        let filter = scope_filter("u-1", "p-1");
        assert_eq!(filter.limit, Some(10_000));
        assert_eq!(filter.user_id, "u-1");
    }
}
