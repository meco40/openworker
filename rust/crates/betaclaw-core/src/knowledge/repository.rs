//! Port of `src/server/knowledge/repository.ts` — the slice's type hub and the
//! `KnowledgeRepository` contract.
//!
//! | TypeScript                                       | Rust |
//! | ------------------------------------------------ | ---- |
//! | `repository.ts:1-13` (imports of `eventTypes`/`entityGraph`) | [`super::event_types`], [`super::entity_graph`] |
//! | `repository.ts:15-18` (`KnowledgeSourceRef`)      | [`KnowledgeSourceRef`] |
//! | `repository.ts:20-26` (`KnowledgeCheckpoint`)     | [`KnowledgeCheckpoint`] |
//! | `repository.ts:28-33` (`UpsertKnowledgeCheckpointInput`) | [`UpsertKnowledgeCheckpointInput`] |
//! | `repository.ts:35-51` (`KnowledgeEpisode`)        | [`KnowledgeEpisode`] |
//! | `repository.ts:53-67` (`UpsertKnowledgeEpisodeInput`) | [`UpsertKnowledgeEpisodeInput`] |
//! | `repository.ts:69-86` (`MeetingLedgerEntry`)      | [`MeetingLedgerEntry`] |
//! | `repository.ts:88-103` (`UpsertMeetingLedgerInput`)| [`UpsertMeetingLedgerInput`] |
//! | `repository.ts:105-116` (`RetrievalAuditEntry`)   | [`RetrievalAuditEntry`] |
//! | `repository.ts:118-127` (`InsertRetrievalAuditInput`) | [`InsertRetrievalAuditInput`] |
//! | `repository.ts:129-135` (`KnowledgeStats`)        | [`KnowledgeStats`] |
//! | `repository.ts:137-145` (`ListKnowledgeFilter`)   | [`ListKnowledgeFilter`] |
//! | `repository.ts:147-161` (`ConversationSummaryEntry`) | [`ConversationSummaryEntry`] |
//! | `repository.ts:163-174` (`UpsertConversationSummaryInput`) | [`UpsertConversationSummaryInput`] |
//! | `repository.ts:176-247` (`KnowledgeRepository`)   | [`KnowledgeRepository`] |
//!
//! The two type imports of the source header come from `eventTypes.ts` and
//! `entityGraph.ts`, which this slice ports as [`super::event_types`] and
//! [`super::entity_graph`]. The port does not re-declare them here.
//!
//! # Deviations
//!
//! 1. **Optional input fields become empty collections or [`Option`].** The
//!    TypeScript marks `memoryIds?: string[]` optional while every implementation
//!    reads `input.memoryIds || []`; the port takes `Vec<String>` whose empty
//!    value is that fallback. `confidence?: number` stays [`Option<f64>`] because
//!    `Number.isFinite(Number(undefined))` is `false` — absent and `NaN` must both
//!    select the `0.5` fallback, which an `f64` default could not express.
//! 2. **Three optional members get default implementations.** Rust traits have no
//!    optional methods, so `listKnowledgeScopes?`, `getAliasCountsByEntityIds?`
//!    and `listRelationsByEntityIds?` are declared with the same "absent" body the
//!    TypeScript callers guard for (empty vector / empty map). A provider that
//!    only supports the base contract can leave them untouched.
//! 3. **`pruneKnowledgeBefore` returns a concrete result type.** The inline
//!    `{ episodes: number; ledger: number; audits: number }` object literal
//!    (`repository.ts:201-206`) is [`PruneKnowledgeResult`]; the inline
//!    `{ userId: string; personaId: string }` of `listKnowledgeScopes?` is
//!    [`KnowledgeScope`].
//! 4. **No async.** Like [`crate::memory::postgres`], the contract is
//!    synchronous: every provider of this slice is either SQLite (in-process) or
//!    a blocking PostgreSQL statement, and `spawn_blocking` belongs to the
//!    caller.
//! 5. **Every method returns `Result<_, KnowledgeError>`.** The TypeScript
//!    repository throws. The port reports the throw as [`KnowledgeError`], so the
//!    ingestion can take the retry path of `messageProcessor.ts:356-386` for a
//!    failed SQLite write, instead of unwinding.

use std::collections::BTreeMap;

use super::entity_graph::{
    EntityAlias, EntityGraphFilter, EntityLookupResult, EntityRelation, KnowledgeEntity,
};
use super::event_types::{
    EventAggregationResult, KnowledgeEvent, KnowledgeEventFilter, UpsertKnowledgeEventInput,
};
use super::repositories::KnowledgeRepositoryError;

/// `KnowledgeSourceRef` from `repository.ts:15-18`.
///
/// `Serialize`/`Deserialize` are needed because the episodes and ledger stores
/// keep the refs in a `source_refs_json` column: `JSON.stringify(toSourceRefs(...))`
/// on write and `parseJsonArray<{ seq; quote }>(...)` on read.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KnowledgeSourceRef {
    pub seq: i64,
    pub quote: String,
}

/// `KnowledgeCheckpoint` from `repository.ts:20-26`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnowledgeCheckpoint {
    pub conversation_id: String,
    pub user_id: Option<String>,
    pub persona_id: String,
    pub last_seq: i64,
    pub updated_at: String,
}

/// `UpsertKnowledgeCheckpointInput` from `repository.ts:28-33`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpsertKnowledgeCheckpointInput {
    pub conversation_id: String,
    pub user_id: Option<String>,
    pub persona_id: String,
    pub last_seq: i64,
}

/// `KnowledgeEpisode` from `repository.ts:35-51`.
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeEpisode {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub topic_key: String,
    pub counterpart: Option<String>,
    pub teaser: String,
    pub episode: String,
    pub facts: Vec<String>,
    pub source_seq_start: i64,
    pub source_seq_end: i64,
    pub source_refs: Vec<KnowledgeSourceRef>,
    pub memory_ids: Vec<String>,
    pub event_at: Option<String>,
    pub updated_at: String,
}

/// `UpsertKnowledgeEpisodeInput` from `repository.ts:53-67`.
#[derive(Debug, Clone, PartialEq)]
pub struct UpsertKnowledgeEpisodeInput {
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub topic_key: String,
    pub counterpart: Option<String>,
    pub teaser: String,
    pub episode: String,
    pub facts: Vec<String>,
    pub source_seq_start: i64,
    pub source_seq_end: i64,
    pub source_refs: Vec<KnowledgeSourceRef>,
    pub memory_ids: Vec<String>,
    pub event_at: Option<String>,
}

/// `MeetingLedgerEntry` from `repository.ts:69-86`.
#[derive(Debug, Clone, PartialEq)]
pub struct MeetingLedgerEntry {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub topic_key: String,
    pub counterpart: Option<String>,
    pub event_at: Option<String>,
    pub participants: Vec<String>,
    pub decisions: Vec<String>,
    pub negotiated_terms: Vec<String>,
    pub open_points: Vec<String>,
    pub action_items: Vec<String>,
    pub source_refs: Vec<KnowledgeSourceRef>,
    pub confidence: f64,
    pub memory_ids: Vec<String>,
    pub updated_at: String,
}

/// `UpsertMeetingLedgerInput` from `repository.ts:88-103`.
#[derive(Debug, Clone, PartialEq)]
pub struct UpsertMeetingLedgerInput {
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub topic_key: String,
    pub counterpart: Option<String>,
    pub event_at: Option<String>,
    pub participants: Vec<String>,
    pub decisions: Vec<String>,
    pub negotiated_terms: Vec<String>,
    pub open_points: Vec<String>,
    pub action_items: Vec<String>,
    pub source_refs: Vec<KnowledgeSourceRef>,
    pub memory_ids: Vec<String>,
    pub confidence: Option<f64>,
}

/// `RetrievalAuditEntry` from `repository.ts:105-116`.
#[derive(Debug, Clone, PartialEq)]
pub struct RetrievalAuditEntry {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub query: String,
    pub stage_stats: BTreeMap<String, f64>,
    pub token_count: i64,
    pub had_error: bool,
    pub error_message: Option<String>,
    pub created_at: String,
}

/// `InsertRetrievalAuditInput` from `repository.ts:118-127`.
#[derive(Debug, Clone, PartialEq)]
pub struct InsertRetrievalAuditInput {
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub query: String,
    pub stage_stats: BTreeMap<String, f64>,
    pub token_count: i64,
    pub had_error: bool,
    pub error_message: Option<String>,
}

/// `KnowledgeStats` from `repository.ts:129-135`.
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeStats {
    pub episode_count: i64,
    pub ledger_count: i64,
    pub retrieval_error_count: i64,
    pub latest_ingestion_at: Option<String>,
    /// `ingestionLagMs` can be `NaN` when there has been no ingestion at all;
    /// the TypeScript arithmetic produces `NaN`, so the port keeps `f64`.
    pub ingestion_lag_ms: f64,
}

/// `ListKnowledgeFilter` from `repository.ts:137-145`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ListKnowledgeFilter {
    pub user_id: String,
    pub persona_id: String,
    pub counterpart: Option<String>,
    pub topic_key: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<i64>,
}

/// `ConversationSummaryEntry` from `repository.ts:147-161`.
#[derive(Debug, Clone, PartialEq)]
pub struct ConversationSummaryEntry {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub summary_text: String,
    pub key_topics: Vec<String>,
    pub entities_mentioned: Vec<String>,
    pub emotional_tone: Option<String>,
    pub message_count: i64,
    pub time_range_start: String,
    pub time_range_end: String,
    pub created_at: String,
    pub updated_at: String,
}

/// `UpsertConversationSummaryInput` from `repository.ts:163-174`.
#[derive(Debug, Clone, PartialEq)]
pub struct UpsertConversationSummaryInput {
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub summary_text: String,
    pub key_topics: Vec<String>,
    pub entities_mentioned: Vec<String>,
    pub emotional_tone: Option<String>,
    pub message_count: i64,
    pub time_range_start: String,
    pub time_range_end: String,
}

/// The inline return object of `pruneKnowledgeBefore` (`repository.ts:201-206`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PruneKnowledgeResult {
    pub episodes: i64,
    pub ledger: i64,
    pub audits: i64,
}

/// The inline element type of `listKnowledgeScopes?` (`repository.ts:200`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnowledgeScope {
    pub user_id: String,
    pub persona_id: String,
}

/// The inline argument object of `pruneKnowledgeBefore` (`repository.ts:201-206`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PruneKnowledgeBeforeInput {
    pub user_id: String,
    pub persona_id: String,
    pub before_iso: String,
    pub dry_run: Option<bool>,
}

/// The inline `{ userId, personaId, limit? }` of `listRetrievalAudit`
/// (`repository.ts:191-195`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ListRetrievalAuditFilter {
    pub user_id: String,
    pub persona_id: String,
    pub limit: Option<i64>,
}

/// The inline `{ userId, personaId, conversationId?, limit? }` of
/// `listConversationSummaries` (`repository.ts:241-246`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ListConversationSummariesFilter {
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: Option<String>,
    pub limit: Option<i64>,
}

/// The inline return object of `getEntityWithRelations` (`repository.ts:229-233`).
#[derive(Debug, Clone, PartialEq)]
pub struct EntityWithRelations {
    pub entity: KnowledgeEntity,
    pub relations: Vec<EntityRelation>,
    pub aliases: Vec<EntityAlias>,
}

/// `Omit<KnowledgeEntity, 'createdAt' | 'updatedAt'>` (`repository.ts:216`).
#[derive(Debug, Clone, PartialEq)]
pub struct UpsertKnowledgeEntityInput {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub canonical_name: String,
    pub category: super::entity_graph::EntityCategory,
    pub owner: super::entity_graph::EntityOwner,
    pub properties: super::entity_graph::Properties,
}

/// `Omit<EntityAlias, 'id' | 'createdAt'>` (`repository.ts:217`).
#[derive(Debug, Clone, PartialEq)]
pub struct AddEntityAliasInput {
    pub entity_id: String,
    pub alias: String,
    pub alias_type: super::entity_graph::AliasType,
    pub owner: super::entity_graph::EntityOwner,
    pub confidence: f64,
}

/// `Omit<EntityRelation, 'id' | 'createdAt' | 'updatedAt'>` (`repository.ts:218`).
#[derive(Debug, Clone, PartialEq)]
pub struct AddEntityRelationInput {
    pub source_entity_id: String,
    pub target_entity_id: String,
    pub relation_type: String,
    pub properties: super::entity_graph::Properties,
    pub confidence: f64,
}

/// A failure of a [`KnowledgeRepository`] call: the error the TypeScript repository
/// throws. The ingestion decides from it between the retry path and an error for
/// the caller (`messageProcessor.ts:356-386`).
#[derive(Debug, thiserror::Error)]
pub enum KnowledgeError {
    /// A sub-repository failed: a statement, a JSON column, a missing row or an
    /// unknown entity.
    #[error(transparent)]
    Repository(#[from] KnowledgeRepositoryError),

    /// A statement that runs on the connection itself, such as a transaction.
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// The connection lock was poisoned by a panic in an earlier call.
    #[error("knowledge connection lock poisoned")]
    LockPoisoned,
}

/// `KnowledgeRepository` from `repository.ts:176-247`.
///
/// Every statement stays in the provider; this trait only fixes the shape the
/// ingestion, retrieval and maintenance callers code against. The three optional
/// members carry a default that makes an unsupported provider behave like the
/// object literal that never defined them.
pub trait KnowledgeRepository {
    // ── Checkpoint ───────────────────────────────────────────────────────────
    fn get_ingestion_checkpoint(
        &self,
        conversation_id: &str,
        user_id_or_persona_id: &str,
        persona_id: Option<&str>,
    ) -> Result<Option<KnowledgeCheckpoint>, KnowledgeError>;
    fn upsert_ingestion_checkpoint(
        &self,
        input: &UpsertKnowledgeCheckpointInput,
    ) -> Result<KnowledgeCheckpoint, KnowledgeError>;

    // ── Episode ──────────────────────────────────────────────────────────────
    fn upsert_episode(
        &self,
        input: &UpsertKnowledgeEpisodeInput,
    ) -> Result<KnowledgeEpisode, KnowledgeError>;
    fn list_episodes(
        &self,
        filter: &ListKnowledgeFilter,
    ) -> Result<Vec<KnowledgeEpisode>, KnowledgeError>;

    // ── Meeting ledger ───────────────────────────────────────────────────────
    fn upsert_meeting_ledger(
        &self,
        input: &UpsertMeetingLedgerInput,
    ) -> Result<MeetingLedgerEntry, KnowledgeError>;
    fn list_meeting_ledger(
        &self,
        filter: &ListKnowledgeFilter,
    ) -> Result<Vec<MeetingLedgerEntry>, KnowledgeError>;

    // ── Retrieval audit ──────────────────────────────────────────────────────
    fn insert_retrieval_audit(
        &self,
        input: &InsertRetrievalAuditInput,
    ) -> Result<RetrievalAuditEntry, KnowledgeError>;
    fn list_retrieval_audit(
        &self,
        filter: &ListRetrievalAuditFilter,
    ) -> Result<Vec<RetrievalAuditEntry>, KnowledgeError>;

    // ── Stats & maintenance ──────────────────────────────────────────────────
    fn get_knowledge_stats(
        &self,
        user_id: &str,
        persona_id: &str,
    ) -> Result<KnowledgeStats, KnowledgeError>;
    fn delete_knowledge_by_scope(
        &self,
        user_id: &str,
        persona_id: &str,
    ) -> Result<i64, KnowledgeError>;
    /// `listKnowledgeScopes?` (`repository.ts:200`) — absent yields no scopes.
    fn list_knowledge_scopes(&self) -> Result<Vec<KnowledgeScope>, KnowledgeError> {
        Ok(Vec::new())
    }
    fn prune_knowledge_before(
        &self,
        input: &PruneKnowledgeBeforeInput,
    ) -> Result<PruneKnowledgeResult, KnowledgeError>;

    // ── Events (Phase 1) ─────────────────────────────────────────────────────
    fn upsert_event(&self, input: &UpsertKnowledgeEventInput) -> Result<(), KnowledgeError>;
    fn append_event_sources(
        &self,
        event_id: &str,
        new_seqs: &[i64],
        new_summary: Option<&str>,
    ) -> Result<(), KnowledgeError>;
    fn list_events(
        &self,
        filter: &KnowledgeEventFilter,
        limit: Option<i64>,
    ) -> Result<Vec<KnowledgeEvent>, KnowledgeError>;
    fn find_overlapping_events(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> Result<Vec<KnowledgeEvent>, KnowledgeError>;
    fn count_unique_days(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> Result<EventAggregationResult, KnowledgeError>;

    // ── Entity graph (Phase 2) ───────────────────────────────────────────────
    fn upsert_entity(
        &self,
        input: &UpsertKnowledgeEntityInput,
    ) -> Result<KnowledgeEntity, KnowledgeError>;
    fn add_alias(&self, alias: &AddEntityAliasInput) -> Result<(), KnowledgeError>;
    fn add_relation(&self, relation: &AddEntityRelationInput) -> Result<(), KnowledgeError>;
    fn update_entity_properties(
        &self,
        entity_id: &str,
        properties: &super::entity_graph::Properties,
    ) -> Result<(), KnowledgeError>;
    fn resolve_entity(
        &self,
        text: &str,
        filter: &EntityGraphFilter,
    ) -> Result<Option<EntityLookupResult>, KnowledgeError>;
    fn resolve_entity_by_relation(
        &self,
        relation: &str,
        owner: super::entity_graph::EntityOwner,
        filter: &EntityGraphFilter,
    ) -> Result<Option<EntityLookupResult>, KnowledgeError>;
    fn list_entities(
        &self,
        filter: &EntityGraphFilter,
        limit: Option<i64>,
    ) -> Result<Vec<KnowledgeEntity>, KnowledgeError>;
    /// `getAliasCountsByEntityIds?` (`repository.ts:227`) — absent yields an
    /// empty map.
    fn get_alias_counts_by_entity_ids(
        &self,
        entity_ids: &[String],
    ) -> Result<BTreeMap<String, i64>, KnowledgeError> {
        let _ = entity_ids;
        Ok(BTreeMap::new())
    }
    /// `listRelationsByEntityIds?` (`repository.ts:228`) — absent yields an empty
    /// vector.
    fn list_relations_by_entity_ids(
        &self,
        entity_ids: &[String],
    ) -> Result<Vec<EntityRelation>, KnowledgeError> {
        let _ = entity_ids;
        Ok(Vec::new())
    }
    fn get_entity_with_relations(
        &self,
        entity_id: &str,
    ) -> Result<EntityWithRelations, KnowledgeError>;
    fn get_related_entities(
        &self,
        entity_id: &str,
        relation_type: Option<&str>,
    ) -> Result<Vec<KnowledgeEntity>, KnowledgeError>;
    fn find_path(
        &self,
        from_entity_id: &str,
        to_entity_id: &str,
        max_depth: Option<i64>,
    ) -> Result<Vec<EntityRelation>, KnowledgeError>;
    fn delete_entity(&self, entity_id: &str) -> Result<(), KnowledgeError>;
    fn delete_entities_by_name(
        &self,
        name: &str,
        filter: &EntityGraphFilter,
    ) -> Result<i64, KnowledgeError>;

    // ── Conversation summary (Phase 3) ───────────────────────────────────────
    fn upsert_conversation_summary(
        &self,
        input: &UpsertConversationSummaryInput,
    ) -> Result<ConversationSummaryEntry, KnowledgeError>;
    fn list_conversation_summaries(
        &self,
        filter: &ListConversationSummariesFilter,
    ) -> Result<Vec<ConversationSummaryEntry>, KnowledgeError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The inline filter objects resolve to the documented empty defaults, which
    /// is what the SQLite providers then floor into a concrete page size.
    #[test]
    fn the_filter_defaults_are_empty() {
        assert_eq!(
            PruneKnowledgeResult::default(),
            PruneKnowledgeResult {
                episodes: 0,
                ledger: 0,
                audits: 0
            }
        );
        let filter = ListKnowledgeFilter::default();
        assert!(filter.counterpart.is_none());
        assert!(filter.topic_key.is_none());
        assert!(filter.limit.is_none());
        let audit = ListRetrievalAuditFilter::default();
        assert!(audit.limit.is_none());
        let summaries = ListConversationSummariesFilter::default();
        assert!(summaries.conversation_id.is_none());
        assert!(summaries.limit.is_none());
    }

    /// `stageStats` is a numeric bag; `BTreeMap` keeps a deterministic order so a
    /// reviewer can compare two runs.
    #[test]
    fn the_stage_stats_bag_is_ordered_and_numeric() {
        let mut stats = BTreeMap::new();
        stats.insert("candidate".to_string(), 4.0);
        stats.insert("expanded".to_string(), 2.0);
        let keys: Vec<&String> = stats.keys().collect();
        assert_eq!(keys, vec!["candidate", "expanded"]);
    }
}
