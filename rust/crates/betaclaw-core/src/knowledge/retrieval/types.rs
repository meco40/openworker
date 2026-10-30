//! Port of `src/server/knowledge/retrieval/types.ts` (1-89).
//!
//! | TypeScript                                          | Rust |
//! | --------------------------------------------------- | ---- |
//! | `types.ts:1-10` (imports)                            | [`crate::knowledge::entity_graph`], [`crate::knowledge::event_types`], [`crate::knowledge::repository`], [`crate::messages_store::StoredMessage`], [`crate::memory::types::MemoryType`], [`crate::personas::types::MemoryPersonaType`] |
//! | `types.ts:12-20` (`MemoryRecallLike`)                | [`MemoryRecall`] |
//! | `types.ts:22-29` (`MessageLookupRepository`)         | [`MessageLookupRepository`] |
//! | `types.ts:31-45` (`RetrievalKnowledgeRepository`)    | [`RetrievalKnowledgeRepository`] |
//! | `types.ts:47-55` (`KnowledgeRetrievalInput`)         | [`KnowledgeRetrievalInput`] |
//! | `types.ts:57-61` (`KnowledgeRecallProbeInput`)       | [`KnowledgeRecallProbeInput`] |
//! | `types.ts:63-69` (`KnowledgeRetrievalSections`)      | [`KnowledgeRetrievalSections`] |
//! | `types.ts:71-77` (`KnowledgeRetrievalResult`)        | [`KnowledgeRetrievalResult`] |
//! | `types.ts:79-89` (`KnowledgeRetrievalServiceOptions`)| [`KnowledgeRetrievalServiceOptions`] |
//!
//! # Deviations
//!
//! Optional repository features use Result<Option<_>>: Ok(None) means unsupported
//! or no match; Err remains a storage error.
//!
//! 1. **No `await` at the memory seam.** `MemoryRecallLike.recallDetailed` is
//!    `async` and `types.ts:85` resolves a memory runtime through a callback.
//!    The crate's memory port (`memory/service.rs`) is synchronous, so
//!    [`MemoryRecall`] is a plain method and there is no `BoxFuture` in this
//!    package. The provider callback cannot be a closure handing out a trait
//!    object, so it becomes the one-method trait [`MemoryServiceProvider`];
//!    `getPersonaMemoryType` becomes [`PersonaMemoryTypeLookup`].
//! 2. **Optional members are `Option`-returning with a `None` default.** The
//!    TypeScript guards three members for presence (`!repo.resolveEntity`,
//!    `!repo.getEntityWithRelations`, `!repo.getRelatedEntities` at
//!    `queryPlanning.ts:60-62`) and reads three more as optional
//!    (`countUniqueDays?`, `listEvents?`, `listEntities?`, `types.ts:35-40`).
//!    Both call sites treat "member absent" and "member returned nothing" the
//!    same way, so `None` covers both.
//! 3. **The repositories can fail.** The TypeScript implementations throw, and
//!    `retrievalExecution.ts:320-340` catches. The Rust methods return
//!    [`RetrievalResult`] so that path stays reachable; a provider built on
//!    [`crate::knowledge::repository::KnowledgeRepository`] maps its
//!    [`crate::knowledge::repository::KnowledgeError`] into [`RetrievalError`].
//! 4. **The sections are a struct, not a `Record<string, string>`.** Every
//!    construction site writes exactly `answerDraft`, `keyDecisions`,
//!    `openPoints` and `evidence`, so [`KnowledgeRetrievalSections`] names those
//!    four in the key order of `budgetCalculator.ts:53-56`.
//! 5. **`tokenCount` is an integer.** `estimateTokenCount` (`tokenBudget.ts:4`)
//!    returns `Math.max(1, Math.ceil(bytes / 4))`, so the port stores `i64` for
//!    the result and for the audit column.

use crate::knowledge::entity_graph::{EntityGraphFilter, EntityLookupResult, KnowledgeEntity};
use crate::knowledge::event_types::{EventAggregationResult, KnowledgeEvent, KnowledgeEventFilter};
use crate::knowledge::repositories::KnowledgeRepositoryError;
use crate::knowledge::repository::{
    EntityWithRelations, InsertRetrievalAuditInput, KnowledgeEpisode, KnowledgeError,
    ListKnowledgeFilter, MeetingLedgerEntry, RetrievalAuditEntry,
};
use crate::memory::types::MemoryType;
use crate::messages_store::StoredMessage;
use crate::personas::types::MemoryPersonaType;

/// The error of a retrieval repository call — `new Error(message)`, which
/// `retrievalExecution.ts:321` reads back through `error.message`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct RetrievalError {
    pub message: String,
}

impl RetrievalError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Rust-only bridge: a provider built on the SQLite sub-repositories fails with
/// [`KnowledgeRepositoryError`]; `Error#message` is that error's `Display`.
impl From<KnowledgeRepositoryError> for RetrievalError {
    fn from(error: KnowledgeRepositoryError) -> Self {
        Self::new(error.to_string())
    }
}

impl From<KnowledgeError> for RetrievalError {
    fn from(error: KnowledgeError) -> Self {
        Self::new(error.to_string())
    }
}

pub type RetrievalResult<T> = Result<T, RetrievalError>;

/// `{ mode?: 'semantic' | 'lexical' }` of `recallDetailed` (`types.ts:18`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecallMode {
    Semantic,
    Lexical,
}

/// `{ mode?, memoryTypes? }` of `recallDetailed` (`types.ts:18`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemoryRecallOptions {
    pub mode: Option<RecallMode>,
    pub memory_types: Option<Vec<MemoryType>>,
}

/// `{ node: { id, content? } }` — one match of `recallDetailed`
/// (`types.ts:19`).
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryRecallMatch {
    pub node: MemoryRecallNode,
}

/// `{ id: string; content?: string }` (`types.ts:19`).
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryRecallNode {
    pub id: String,
    pub content: Option<String>,
}

/// The resolved recall of `recallDetailed` (`types.ts:19`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemoryRecallResult {
    pub context: String,
    pub matches: Vec<MemoryRecallMatch>,
}

impl MemoryRecallResult {
    /// `{ context: '', matches: [] }` (`retrievalExecution.ts:184`).
    pub fn empty() -> Self {
        Self::default()
    }
}

/// `MemoryRecallLike` from `types.ts:12-20`.
pub trait MemoryRecall {
    fn recall_detailed(
        &self,
        persona_id: &str,
        query: &str,
        limit: Option<i64>,
        user_id: Option<&str>,
        options: Option<&MemoryRecallOptions>,
    ) -> RetrievalResult<MemoryRecallResult>;
}

/// `options.memoryServiceProvider` (`types.ts:85`) — "Resolves the current
/// memory runtime after a degraded-startup recovery".
pub trait MemoryServiceProvider {
    fn current(&self) -> Option<&dyn MemoryRecall>;
}

/// `options.getPersonaMemoryType` (`types.ts:88`).
pub trait PersonaMemoryTypeLookup {
    fn get_persona_memory_type(
        &self,
        persona_id: &str,
    ) -> RetrievalResult<Option<MemoryPersonaType>>;
}

/// `MessageLookupRepository` from `types.ts:22-29`; a thrown SQLite read is preserved for the
/// retrieval service's existing error/audit boundary.
pub trait MessageLookupRepository {
    fn list_messages(
        &self,
        conversation_id: &str,
        limit: Option<i64>,
        before: Option<&str>,
        user_id: Option<&str>,
    ) -> RetrievalResult<Vec<StoredMessage>>;
}

/// `RetrievalKnowledgeRepository` from `types.ts:31-45`.
///
/// `countUniqueDays`, `listEvents`, `listEntities`, `resolveEntity`,
/// `getEntityWithRelations` and `getRelatedEntities` are the optional members;
/// their `None` default is the "member does not exist" the callers guard for
/// (see the module header, deviation 2).
pub trait RetrievalKnowledgeRepository {
    fn list_meeting_ledger(
        &self,
        filter: &ListKnowledgeFilter,
    ) -> RetrievalResult<Vec<MeetingLedgerEntry>>;

    fn list_episodes(&self, filter: &ListKnowledgeFilter)
        -> RetrievalResult<Vec<KnowledgeEpisode>>;

    fn insert_retrieval_audit(
        &self,
        input: &InsertRetrievalAuditInput,
    ) -> RetrievalResult<RetrievalAuditEntry>;

    fn count_unique_days(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> RetrievalResult<Option<EventAggregationResult>> {
        let _ = filter;
        Ok(None)
    }

    fn list_events(
        &self,
        filter: &KnowledgeEventFilter,
        limit: Option<i64>,
    ) -> RetrievalResult<Option<Vec<KnowledgeEvent>>> {
        let _ = (filter, limit);
        Ok(None)
    }

    fn list_entities(
        &self,
        filter: &EntityGraphFilter,
        limit: Option<i64>,
    ) -> RetrievalResult<Option<Vec<KnowledgeEntity>>> {
        let _ = (filter, limit);
        Ok(None)
    }

    fn resolve_entity(
        &self,
        text: &str,
        filter: &EntityGraphFilter,
    ) -> RetrievalResult<Option<EntityLookupResult>> {
        let _ = (text, filter);
        Ok(None)
    }

    fn get_entity_with_relations(
        &self,
        entity_id: &str,
    ) -> RetrievalResult<Option<EntityWithRelations>> {
        let _ = entity_id;
        Ok(None)
    }

    fn get_related_entities(
        &self,
        entity_id: &str,
    ) -> RetrievalResult<Option<Vec<KnowledgeEntity>>> {
        let _ = entity_id;
        Ok(None)
    }
}

/// `KnowledgeRetrievalInput` from `types.ts:47-55`.
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeRetrievalInput {
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: Option<String>,
    pub query: String,
    /// `includeSemantic?: boolean` — `retrievalExecution.ts:178` only treats an
    /// explicit `false` as "off".
    pub include_semantic: Option<bool>,
    pub memory_types: Option<Vec<MemoryType>>,
}

/// `KnowledgeRecallProbeInput` from `types.ts:57-61`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnowledgeRecallProbeInput {
    pub user_id: String,
    pub persona_id: String,
    pub query: String,
}

/// The four section keys in the order `budgetCalculator.ts:53-56` writes them.
pub const SECTION_KEYS: [&str; 4] = ["answerDraft", "keyDecisions", "openPoints", "evidence"];

/// `KnowledgeRetrievalSections` from `types.ts:63-69`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KnowledgeRetrievalSections {
    pub answer_draft: String,
    pub key_decisions: String,
    pub open_points: String,
    pub evidence: String,
}

impl KnowledgeRetrievalSections {
    /// `sections[key]` for one of [`SECTION_KEYS`].
    pub fn get(&self, key: &str) -> &str {
        match key {
            "answerDraft" => &self.answer_draft,
            "keyDecisions" => &self.key_decisions,
            "openPoints" => &self.open_points,
            _ => &self.evidence,
        }
    }

    /// `sections[key] = value` for one of [`SECTION_KEYS`].
    pub fn set(&mut self, key: &str, value: String) {
        match key {
            "answerDraft" => self.answer_draft = value,
            "keyDecisions" => self.key_decisions = value,
            "openPoints" => self.open_points = value,
            _ => self.evidence = value,
        }
    }
}

/// `KnowledgeRetrievalResult` from `types.ts:71-77`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct KnowledgeRetrievalResult {
    pub context: String,
    pub sections: KnowledgeRetrievalSections,
    pub references: Vec<String>,
    pub token_count: i64,
    /// `computedAnswer?: string | null` — the two early returns of
    /// `retrievalExecution.ts:207-225` and the catch block omit the key, which
    /// is [`None`] here.
    pub computed_answer: Option<String>,
}

/// `KnowledgeRetrievalServiceOptions` from `types.ts:79-89`.
pub struct KnowledgeRetrievalServiceOptions<'a> {
    pub max_context_tokens: i64,
    pub knowledge_repository: &'a dyn RetrievalKnowledgeRepository,
    /// Optional — when `None`, semantic recall is skipped
    /// (`retrievalExecution.ts:178-184`).
    pub memory_service: Option<&'a dyn MemoryRecall>,
    pub memory_service_provider: Option<&'a dyn MemoryServiceProvider>,
    pub message_repository: &'a dyn MessageLookupRepository,
    pub get_persona_memory_type: Option<&'a dyn PersonaMemoryTypeLookup>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The section keys are the JSON names of the sections object, so a typo
    /// here changes what a caller reads back.
    #[test]
    fn the_section_keys_are_the_json_names_in_the_budget_order() {
        assert_eq!(
            SECTION_KEYS,
            ["answerDraft", "keyDecisions", "openPoints", "evidence"]
        );
        let mut sections = KnowledgeRetrievalSections::default();
        for key in SECTION_KEYS {
            assert_eq!(sections.get(key), "");
            sections.set(key, key.to_string());
            assert_eq!(sections.get(key), key);
        }
        assert_eq!(sections.evidence, "evidence");
        assert_eq!(sections.answer_draft, "answerDraft");
    }

    #[test]
    fn an_empty_recall_has_no_context_and_no_matches() {
        assert_eq!(MemoryRecallResult::empty(), MemoryRecallResult::default());
        assert!(MemoryRecallResult::empty().matches.is_empty());
    }

    #[test]
    fn a_repository_error_keeps_the_source_message() {
        let error = RetrievalError::from(KnowledgeRepositoryError::MissingRow {
            context: "knowledge_retrieval_audit".to_string(),
        });
        assert_eq!(error.message, "missing row in knowledge_retrieval_audit");
        assert_eq!(
            error.to_string(),
            "missing row in knowledge_retrieval_audit",
            "Error#message is what the audit stores"
        );
    }
}
