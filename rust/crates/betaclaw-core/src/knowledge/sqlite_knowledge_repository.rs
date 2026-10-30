//! Port of `src/server/knowledge/sqliteKnowledgeRepository.ts` (1-352).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `SqliteKnowledgeRepository` (`:14-352`) | [`SqliteKnowledgeRepository`] |
//! | constructor: `openSqliteDatabase` + `runKnowledgeMigrations` (`:36-46`) | [`SqliteKnowledgeRepository::open`] |
//! | `KNOWLEDGE_DB_PATH \|\| MESSAGES_DB_PATH \|\| '.local/messages.db'` (`:37`) | [`default_knowledge_db_path`] |
//! | `getKnowledgeStats` (`:179-218`) | [`KnowledgeRepository::get_knowledge_stats`] |
//! | `deleteKnowledgeByScope` (`:220-263`) | [`KnowledgeRepository::delete_knowledge_by_scope`] |
//! | `listKnowledgeScopes` (`:265-282`) | [`KnowledgeRepository::list_knowledge_scopes`] |
//! | `pruneKnowledgeBefore` (`:284-318`) | [`KnowledgeRepository::prune_knowledge_before`] |
//! | the delegating methods (`:55-177`, `:320-351`) | the rest of the [`KnowledgeRepository`] impl |
//!
//! # Deviations
//!
//! * Every method returns a [`KnowledgeError`] (see `repository.rs`). A storage
//!   fault reaches the caller with the driver message, where the TypeScript
//!   throws. The ingestion turns it into the retry record of
//!   `messageProcessor.ts:356-386`. Nothing panics here.
//! * The connection is a `Mutex<Connection>`. Every call takes the lock and makes
//!   the sub-repository views on the guard, like the TypeScript object owning one
//!   `Database`. The mutex makes the repository `Sync`, which the ingestion
//!   futures need. A poisoned lock is reported as [`KnowledgeError::LockPoisoned`].
//! * `close()` is `Drop`.

use std::collections::BTreeMap;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::db::{self, OpenOptions};
use crate::knowledge::entity_graph::{
    EntityGraphFilter, EntityLookupResult, EntityOwner, EntityRelation, KnowledgeEntity, Properties,
};
use crate::knowledge::event_types::{
    EventAggregationResult, KnowledgeEvent, KnowledgeEventFilter, UpsertKnowledgeEventInput,
};
use crate::knowledge::repositories::parse_iso;
use crate::knowledge::repositories::{
    run_knowledge_migrations, AuditRepository, CheckpointRepository, EntityRepository,
    EpisodeRepository, EventRepository, KnowledgeRepositoryError, LedgerRepository,
    SummaryRepository,
};
use crate::knowledge::repository::{
    AddEntityAliasInput, AddEntityRelationInput, ConversationSummaryEntry, EntityWithRelations,
    InsertRetrievalAuditInput, KnowledgeCheckpoint, KnowledgeEpisode, KnowledgeError,
    KnowledgeRepository, KnowledgeScope, KnowledgeStats, ListConversationSummariesFilter,
    ListKnowledgeFilter, ListRetrievalAuditFilter, MeetingLedgerEntry, PruneKnowledgeBeforeInput,
    PruneKnowledgeResult, RetrievalAuditEntry, UpsertConversationSummaryInput,
    UpsertKnowledgeCheckpointInput, UpsertKnowledgeEntityInput, UpsertKnowledgeEpisodeInput,
    UpsertMeetingLedgerInput,
};
use crate::knowledge::retrieval::types::{RetrievalKnowledgeRepository, RetrievalResult};

/// `KNOWLEDGE_DB_PATH || MESSAGES_DB_PATH || '.local/messages.db'`
/// (`sqliteKnowledgeRepository.ts:36-38`), from the process environment.
pub fn default_knowledge_db_path() -> String {
    std::env::var("KNOWLEDGE_DB_PATH")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("MESSAGES_DB_PATH")
                .ok()
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| ".local/messages.db".to_string())
}

/// `SqliteKnowledgeRepository` (`sqliteKnowledgeRepository.ts:14`).
pub struct SqliteKnowledgeRepository {
    conn: Mutex<Connection>,
}

impl SqliteKnowledgeRepository {
    /// Opens the database and runs the knowledge migrations
    /// (`sqliteKnowledgeRepository.ts:36-46`).
    pub fn open(db_path: &str) -> Result<Self, KnowledgeRepositoryError> {
        let conn = db::open(OpenOptions::new(db_path)).map_err(|error| {
            KnowledgeRepositoryError::Storage(format!("database error: {error}"))
        })?;
        run_knowledge_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Runs `action` with the connection locked. The error of `action` becomes a
    /// [`KnowledgeError`]; a poisoned lock is reported, not raised.
    fn with_conn<T, E>(
        &self,
        action: impl FnOnce(&Connection) -> Result<T, E>,
    ) -> Result<T, KnowledgeError>
    where
        KnowledgeError: From<E>,
    {
        let guard = self.conn.lock().map_err(|_| KnowledgeError::LockPoisoned)?;
        action(&guard).map_err(KnowledgeError::from)
    }

    /// `COUNT(*)` for one scope of a table.
    fn count_scope(
        conn: &Connection,
        sql: &str,
        user_id: &str,
        persona_id: &str,
    ) -> Result<i64, KnowledgeRepositoryError> {
        let count: i64 = conn.query_row(sql, params![user_id, persona_id], |row| row.get(0))?;
        Ok(count)
    }
}

/// Raw SQL on the connection, so a test can inject a storage fault.
#[cfg(test)]
impl SqliteKnowledgeRepository {
    pub(crate) fn execute_batch_for_test(&self, sql: &str) {
        self.conn
            .lock()
            .expect("knowledge connection lock")
            .execute_batch(sql)
            .expect("test SQL");
    }
}

impl KnowledgeRepository for SqliteKnowledgeRepository {
    fn get_ingestion_checkpoint(
        &self,
        conversation_id: &str,
        user_id_or_persona_id: &str,
        persona_id: Option<&str>,
    ) -> Result<Option<KnowledgeCheckpoint>, KnowledgeError> {
        self.with_conn(|conn| {
            CheckpointRepository::new(conn).get_ingestion_checkpoint(
                conversation_id,
                user_id_or_persona_id,
                persona_id,
            )
        })
    }

    fn upsert_ingestion_checkpoint(
        &self,
        input: &UpsertKnowledgeCheckpointInput,
    ) -> Result<KnowledgeCheckpoint, KnowledgeError> {
        self.with_conn(|conn| CheckpointRepository::new(conn).upsert_ingestion_checkpoint(input))
    }

    fn upsert_episode(
        &self,
        input: &UpsertKnowledgeEpisodeInput,
    ) -> Result<KnowledgeEpisode, KnowledgeError> {
        self.with_conn(|conn| EpisodeRepository::new(conn).upsert_episode(input))
    }

    fn list_episodes(
        &self,
        filter: &ListKnowledgeFilter,
    ) -> Result<Vec<KnowledgeEpisode>, KnowledgeError> {
        self.with_conn(|conn| EpisodeRepository::new(conn).list_episodes(filter))
    }

    fn upsert_meeting_ledger(
        &self,
        input: &UpsertMeetingLedgerInput,
    ) -> Result<MeetingLedgerEntry, KnowledgeError> {
        self.with_conn(|conn| LedgerRepository::new(conn).upsert_meeting_ledger(input))
    }

    fn list_meeting_ledger(
        &self,
        filter: &ListKnowledgeFilter,
    ) -> Result<Vec<MeetingLedgerEntry>, KnowledgeError> {
        self.with_conn(|conn| LedgerRepository::new(conn).list_meeting_ledger(filter))
    }

    fn insert_retrieval_audit(
        &self,
        input: &InsertRetrievalAuditInput,
    ) -> Result<RetrievalAuditEntry, KnowledgeError> {
        self.with_conn(|conn| AuditRepository::new(conn).insert_retrieval_audit(input))
    }

    fn list_retrieval_audit(
        &self,
        filter: &ListRetrievalAuditFilter,
    ) -> Result<Vec<RetrievalAuditEntry>, KnowledgeError> {
        self.with_conn(|conn| AuditRepository::new(conn).list_retrieval_audit(filter))
    }

    /// `getKnowledgeStats` (`sqliteKnowledgeRepository.ts:179-218`).
    fn get_knowledge_stats(
        &self,
        user_id: &str,
        persona_id: &str,
    ) -> Result<KnowledgeStats, KnowledgeError> {
        self.with_conn(|conn| -> Result<KnowledgeStats, KnowledgeError> {
            let episode_count = Self::count_scope(
                conn,
                "SELECT COUNT(*) FROM knowledge_episodes WHERE user_id = ?1 AND persona_id = ?2",
                user_id,
                persona_id,
            )?;
            let ledger_count = Self::count_scope(
                conn,
                "SELECT COUNT(*) FROM knowledge_meeting_ledger WHERE user_id = ?1 AND persona_id = ?2",
                user_id,
                persona_id,
            )?;
            let retrieval_error_count = Self::count_scope(
                conn,
                "SELECT COUNT(*) FROM knowledge_retrieval_audit WHERE user_id = ?1 AND persona_id = ?2 AND had_error = 1",
                user_id,
                persona_id,
            )?;
            let latest_raw: Option<String> = conn.query_row(
                "SELECT MAX(updated_at) FROM knowledge_ingestion_checkpoints WHERE user_id = ?1 AND persona_id = ?2",
                params![user_id, persona_id],
                |row| row.get(0),
            )?;
            let latest_ingestion_at = parse_iso(latest_raw.as_deref());
            let ingestion_lag_ms = latest_ingestion_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|instant| {
                    let now = chrono::Utc::now().timestamp_millis();
                    (now - instant.timestamp_millis()).max(0) as f64
                })
                .unwrap_or(0.0);
            Ok(KnowledgeStats {
                episode_count,
                ledger_count,
                retrieval_error_count,
                latest_ingestion_at,
                ingestion_lag_ms,
            })
        })
    }

    /// `deleteKnowledgeByScope` (`sqliteKnowledgeRepository.ts:220-263`): one
    /// transaction over the seven scoped tables. Returns the number of deleted rows.
    fn delete_knowledge_by_scope(
        &self,
        user_id: &str,
        persona_id: &str,
    ) -> Result<i64, KnowledgeError> {
        const TABLES: [&str; 7] = [
            "knowledge_ingestion_checkpoints",
            "knowledge_episodes",
            "knowledge_meeting_ledger",
            "knowledge_retrieval_audit",
            "knowledge_conversation_summaries",
            "knowledge_events",
            "knowledge_entities",
        ];
        let mut guard = self.conn.lock().map_err(|_| KnowledgeError::LockPoisoned)?;
        // The rollback on an error is the `db.transaction(...)` of the TypeScript:
        // dropping `transaction` without a commit undoes the deletes so far.
        let transaction = guard.transaction()?;
        let mut deleted = 0_i64;
        for table in TABLES {
            let changes = transaction.execute(
                &format!("DELETE FROM {table} WHERE user_id = ?1 AND persona_id = ?2"),
                params![user_id, persona_id],
            )?;
            deleted += changes as i64;
        }
        transaction.commit()?;
        Ok(deleted)
    }

    /// `listKnowledgeScopes` (`sqliteKnowledgeRepository.ts:265-282`).
    fn list_knowledge_scopes(&self) -> Result<Vec<KnowledgeScope>, KnowledgeError> {
        self.with_conn(|conn| -> Result<Vec<KnowledgeScope>, KnowledgeError> {
            let sql = "SELECT user_id, persona_id FROM knowledge_episodes \
                UNION SELECT user_id, persona_id FROM knowledge_meeting_ledger \
                UNION SELECT user_id, persona_id FROM knowledge_retrieval_audit \
                UNION SELECT user_id, persona_id FROM knowledge_ingestion_checkpoints \
                UNION SELECT user_id, persona_id FROM knowledge_events \
                UNION SELECT user_id, persona_id FROM knowledge_entities \
                UNION SELECT user_id, persona_id FROM knowledge_conversation_summaries \
                ORDER BY user_id, persona_id";
            let mut statement = conn.prepare(sql)?;
            let rows = statement
                .query_map([], |row| {
                    Ok(KnowledgeScope {
                        user_id: row.get(0)?,
                        persona_id: row.get(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// `pruneKnowledgeBefore` (`sqliteKnowledgeRepository.ts:284-318`).
    fn prune_knowledge_before(
        &self,
        input: &PruneKnowledgeBeforeInput,
    ) -> Result<PruneKnowledgeResult, KnowledgeError> {
        let Some(cutoff) = parse_iso(Some(&input.before_iso)) else {
            return Ok(PruneKnowledgeResult {
                episodes: 0,
                ledger: 0,
                audits: 0,
            });
        };
        self.with_conn(|conn| -> Result<PruneKnowledgeResult, KnowledgeError> {
            let count = |sql: &str| -> Result<i64, KnowledgeError> {
                Ok(conn.query_row(
                    sql,
                    params![input.user_id, input.persona_id, cutoff],
                    |row| row.get(0),
                )?)
            };
            let episodes = count(
                "SELECT COUNT(*) FROM knowledge_episodes WHERE user_id = ?1 AND persona_id = ?2 AND COALESCE(event_at, updated_at) < ?3",
            )?;
            let ledger = count(
                "SELECT COUNT(*) FROM knowledge_meeting_ledger WHERE user_id = ?1 AND persona_id = ?2 AND COALESCE(event_at, updated_at) < ?3",
            )?;
            let audits = count(
                "SELECT COUNT(*) FROM knowledge_retrieval_audit WHERE user_id = ?1 AND persona_id = ?2 AND created_at < ?3",
            )?;
            if input.dry_run.unwrap_or(false) {
                return Ok(PruneKnowledgeResult { episodes, ledger, audits });
            }
            let delete = |sql: &str| -> Result<(), KnowledgeError> {
                conn.execute(sql, params![input.user_id, input.persona_id, cutoff])?;
                Ok(())
            };
            delete("DELETE FROM knowledge_episodes WHERE user_id = ?1 AND persona_id = ?2 AND COALESCE(event_at, updated_at) < ?3")?;
            delete("DELETE FROM knowledge_meeting_ledger WHERE user_id = ?1 AND persona_id = ?2 AND COALESCE(event_at, updated_at) < ?3")?;
            delete("DELETE FROM knowledge_retrieval_audit WHERE user_id = ?1 AND persona_id = ?2 AND created_at < ?3")?;
            Ok(PruneKnowledgeResult { episodes, ledger, audits })
        })
    }

    fn upsert_event(&self, input: &UpsertKnowledgeEventInput) -> Result<(), KnowledgeError> {
        self.with_conn(|conn| EventRepository::new(conn).upsert_event(input))
    }

    fn append_event_sources(
        &self,
        event_id: &str,
        new_seqs: &[i64],
        new_summary: Option<&str>,
    ) -> Result<(), KnowledgeError> {
        self.with_conn(|conn| {
            EventRepository::new(conn).append_event_sources(event_id, new_seqs, new_summary)
        })
    }

    fn list_events(
        &self,
        filter: &KnowledgeEventFilter,
        limit: Option<i64>,
    ) -> Result<Vec<KnowledgeEvent>, KnowledgeError> {
        self.with_conn(|conn| EventRepository::new(conn).list_events(filter, limit))
    }

    fn find_overlapping_events(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> Result<Vec<KnowledgeEvent>, KnowledgeError> {
        self.with_conn(|conn| EventRepository::new(conn).find_overlapping_events(filter))
    }

    fn count_unique_days(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> Result<EventAggregationResult, KnowledgeError> {
        self.with_conn(|conn| EventRepository::new(conn).count_unique_days(filter))
    }

    fn upsert_entity(
        &self,
        input: &UpsertKnowledgeEntityInput,
    ) -> Result<KnowledgeEntity, KnowledgeError> {
        self.with_conn(|conn| EntityRepository::new(conn).upsert_entity(input))
    }

    fn add_alias(&self, alias: &AddEntityAliasInput) -> Result<(), KnowledgeError> {
        self.with_conn(|conn| EntityRepository::new(conn).add_alias(alias))
    }

    fn add_relation(&self, relation: &AddEntityRelationInput) -> Result<(), KnowledgeError> {
        self.with_conn(|conn| EntityRepository::new(conn).add_relation(relation))
    }

    fn update_entity_properties(
        &self,
        entity_id: &str,
        properties: &Properties,
    ) -> Result<(), KnowledgeError> {
        self.with_conn(|conn| {
            EntityRepository::new(conn).update_entity_properties(entity_id, properties)
        })
    }

    fn resolve_entity(
        &self,
        text: &str,
        filter: &EntityGraphFilter,
    ) -> Result<Option<EntityLookupResult>, KnowledgeError> {
        self.with_conn(|conn| EntityRepository::new(conn).resolve_entity(text, filter))
    }

    fn resolve_entity_by_relation(
        &self,
        relation: &str,
        owner: EntityOwner,
        filter: &EntityGraphFilter,
    ) -> Result<Option<EntityLookupResult>, KnowledgeError> {
        self.with_conn(|conn| {
            EntityRepository::new(conn).resolve_entity_by_relation(relation, owner, filter)
        })
    }

    fn list_entities(
        &self,
        filter: &EntityGraphFilter,
        limit: Option<i64>,
    ) -> Result<Vec<KnowledgeEntity>, KnowledgeError> {
        self.with_conn(|conn| EntityRepository::new(conn).list_entities(filter, limit))
    }

    fn get_alias_counts_by_entity_ids(
        &self,
        entity_ids: &[String],
    ) -> Result<BTreeMap<String, i64>, KnowledgeError> {
        self.with_conn(|conn| {
            EntityRepository::new(conn).get_alias_counts_by_entity_ids(entity_ids)
        })
    }

    fn list_relations_by_entity_ids(
        &self,
        entity_ids: &[String],
    ) -> Result<Vec<EntityRelation>, KnowledgeError> {
        self.with_conn(|conn| EntityRepository::new(conn).list_relations_by_entity_ids(entity_ids))
    }

    fn get_entity_with_relations(
        &self,
        entity_id: &str,
    ) -> Result<EntityWithRelations, KnowledgeError> {
        self.with_conn(|conn| EntityRepository::new(conn).get_entity_with_relations(entity_id))
    }

    fn get_related_entities(
        &self,
        entity_id: &str,
        relation_type: Option<&str>,
    ) -> Result<Vec<KnowledgeEntity>, KnowledgeError> {
        self.with_conn(|conn| {
            EntityRepository::new(conn).get_related_entities(entity_id, relation_type)
        })
    }

    fn find_path(
        &self,
        from_entity_id: &str,
        to_entity_id: &str,
        max_depth: Option<i64>,
    ) -> Result<Vec<EntityRelation>, KnowledgeError> {
        self.with_conn(|conn| {
            EntityRepository::new(conn).find_path(from_entity_id, to_entity_id, max_depth)
        })
    }

    fn delete_entity(&self, entity_id: &str) -> Result<(), KnowledgeError> {
        self.with_conn(|conn| EntityRepository::new(conn).delete_entity(entity_id))
    }

    fn delete_entities_by_name(
        &self,
        name: &str,
        filter: &EntityGraphFilter,
    ) -> Result<i64, KnowledgeError> {
        self.with_conn(|conn| EntityRepository::new(conn).delete_entities_by_name(name, filter))
    }

    fn upsert_conversation_summary(
        &self,
        input: &UpsertConversationSummaryInput,
    ) -> Result<ConversationSummaryEntry, KnowledgeError> {
        self.with_conn(|conn| SummaryRepository::new(conn).upsert_conversation_summary(input))
    }

    fn list_conversation_summaries(
        &self,
        filter: &ListConversationSummariesFilter,
    ) -> Result<Vec<ConversationSummaryEntry>, KnowledgeError> {
        self.with_conn(|conn| SummaryRepository::new(conn).list_conversation_summaries(filter))
    }
}

impl RetrievalKnowledgeRepository for SqliteKnowledgeRepository {
    fn list_meeting_ledger(
        &self,
        filter: &ListKnowledgeFilter,
    ) -> RetrievalResult<Vec<MeetingLedgerEntry>> {
        KnowledgeRepository::list_meeting_ledger(self, filter).map_err(Into::into)
    }

    fn list_episodes(
        &self,
        filter: &ListKnowledgeFilter,
    ) -> RetrievalResult<Vec<KnowledgeEpisode>> {
        KnowledgeRepository::list_episodes(self, filter).map_err(Into::into)
    }

    fn insert_retrieval_audit(
        &self,
        input: &InsertRetrievalAuditInput,
    ) -> RetrievalResult<RetrievalAuditEntry> {
        KnowledgeRepository::insert_retrieval_audit(self, input).map_err(Into::into)
    }

    fn count_unique_days(
        &self,
        filter: &KnowledgeEventFilter,
    ) -> RetrievalResult<Option<EventAggregationResult>> {
        KnowledgeRepository::count_unique_days(self, filter)
            .map(Some)
            .map_err(Into::into)
    }

    fn list_events(
        &self,
        filter: &KnowledgeEventFilter,
        limit: Option<i64>,
    ) -> RetrievalResult<Option<Vec<KnowledgeEvent>>> {
        KnowledgeRepository::list_events(self, filter, limit)
            .map(Some)
            .map_err(Into::into)
    }

    fn list_entities(
        &self,
        filter: &EntityGraphFilter,
        limit: Option<i64>,
    ) -> RetrievalResult<Option<Vec<KnowledgeEntity>>> {
        KnowledgeRepository::list_entities(self, filter, limit)
            .map(Some)
            .map_err(Into::into)
    }

    fn resolve_entity(
        &self,
        text: &str,
        filter: &EntityGraphFilter,
    ) -> RetrievalResult<Option<EntityLookupResult>> {
        KnowledgeRepository::resolve_entity(self, text, filter).map_err(Into::into)
    }

    fn get_entity_with_relations(
        &self,
        entity_id: &str,
    ) -> RetrievalResult<Option<EntityWithRelations>> {
        KnowledgeRepository::get_entity_with_relations(self, entity_id)
            .map(Some)
            .map_err(Into::into)
    }

    fn get_related_entities(
        &self,
        entity_id: &str,
    ) -> RetrievalResult<Option<Vec<KnowledgeEntity>>> {
        KnowledgeRepository::get_related_entities(self, entity_id, None)
            .map(Some)
            .map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint() -> UpsertKnowledgeCheckpointInput {
        UpsertKnowledgeCheckpointInput {
            conversation_id: "c-1".into(),
            user_id: Some("u-1".into()),
            persona_id: "p-1".into(),
            last_seq: 7,
        }
    }

    #[test]
    fn a_checkpoint_round_trips_and_its_scope_can_be_deleted() {
        let repo = SqliteKnowledgeRepository::open(":memory:").expect("open in-memory store");
        let stats = repo.get_knowledge_stats("u-1", "p-1").expect("stats");
        assert_eq!(stats.episode_count, 0);
        assert_eq!(stats.latest_ingestion_at, None);

        repo.upsert_ingestion_checkpoint(&checkpoint())
            .expect("upsert");
        let found = repo
            .get_ingestion_checkpoint("c-1", "u-1", Some("p-1"))
            .expect("read")
            .expect("checkpoint");
        assert_eq!(found.last_seq, 7);

        let scopes = repo.list_knowledge_scopes().expect("scopes");
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].persona_id, "p-1");

        assert_eq!(
            repo.delete_knowledge_by_scope("u-1", "p-1")
                .expect("delete"),
            1
        );
        assert!(repo
            .get_ingestion_checkpoint("c-1", "u-1", Some("p-1"))
            .expect("read")
            .is_none());
    }

    /// A storage fault comes back as an error; the facade does not panic.
    #[test]
    fn a_failed_read_is_an_error_not_a_panic() {
        let repo = SqliteKnowledgeRepository::open(":memory:").expect("open in-memory store");
        repo.execute_batch_for_test("DROP TABLE knowledge_episodes;");
        let filter = ListKnowledgeFilter {
            user_id: "u-1".into(),
            persona_id: "p-1".into(),
            limit: Some(10),
            ..Default::default()
        };
        let error =
            KnowledgeRepository::list_episodes(&repo, &filter).expect_err("the table is gone");
        assert!(error.to_string().contains("no such table"), "{error}");
    }

    #[test]
    fn retrieval_optional_methods_preserve_storage_errors() {
        let repo = SqliteKnowledgeRepository::open(":memory:").expect("open in-memory store");
        repo.execute_batch_for_test("DROP TABLE knowledge_events;");
        let filter = KnowledgeEventFilter {
            user_id: "u-1".into(),
            persona_id: "p-1".into(),
            ..Default::default()
        };

        let error = RetrievalKnowledgeRepository::list_events(&repo, &filter, Some(10))
            .expect_err("the dropped table must surface");

        assert!(error.to_string().contains("no such table"), "{error}");
    }

    /// A failed delete rolls the transaction back and reports a rusqlite error.
    #[test]
    fn a_failed_delete_is_rolled_back_and_reported() {
        let repo = SqliteKnowledgeRepository::open(":memory:").expect("open in-memory store");
        repo.upsert_ingestion_checkpoint(&checkpoint())
            .expect("upsert");
        repo.execute_batch_for_test("DROP TABLE knowledge_events;");

        let error = repo
            .delete_knowledge_by_scope("u-1", "p-1")
            .expect_err("the table is gone");
        assert!(matches!(error, KnowledgeError::Sqlite(_)), "{error}");
        assert!(repo
            .get_ingestion_checkpoint("c-1", "u-1", Some("p-1"))
            .expect("read")
            .is_some());
    }
}
