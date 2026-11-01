//! Port of `src/server/knowledge/ingestion/service.ts` (1-169).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `KnowledgeIngestionService` constructor (`:14-23`) | [`KnowledgeIngestionService::new`], [`clamp_min_messages`] |
//! | `KnowledgeIngestionServiceDependencies` (`types.ts:52-63`) | [`KnowledgeIngestionDeps`] |
//! | `getCheckpoint` (`:25-32`) | the scoped read of [`KnowledgeIngestionService::ingest_conversation_window`] |
//! | `ingestConversationWindow` (`:34-92`) | [`KnowledgeIngestionService::ingest_conversation_window`] |
//! | `runOnce` (`:94-146`) | [`KnowledgeIngestionService::run_once`] |
//! | `processWindow` (`:148-165`) | [`KnowledgeIngestionService::process_window`] |
//!
//! # Deviations
//!
//! * `memoryServiceProvider` (resolve the current memory runtime per window) is
//!   replaced by a memory service passed at construction, held in an `Arc`. The
//!   runtime module rebuilds the service when the runtime changes.
//! * `resolvePersonaName` is held as a boxed closure.
//! * `runOnce` returns `Err` only when the cursor itself fails, which is the
//!   only case where the TypeScript promise rejects. A window that throws becomes
//!   an entry in `errors`, as in the TypeScript.
//! * The backoff `setTimeout` becomes [`tokio::time::sleep`].

use std::sync::Arc;
use std::time::Duration;

use tracing::warn;

use crate::knowledge::ingestion::constants::{
    MEM0_FAILURE_BACKOFF_BASE_MS, MEM0_MAX_GLOBAL_FAILURES_PER_CYCLE,
};
use crate::knowledge::ingestion::message_processor::{
    process_window, window_id_of, ProcessWindowContext, ProcessWindowError, ProcessWindowResult,
};
use crate::knowledge::ingestion::types::{
    IngestConversationWindowInput, IngestionCursorLike, KnowledgeExtractorLike,
    KnowledgeIngestionError, KnowledgeIngestionRunResult, KnowledgeIngestionServiceOptions,
    MemoryFactService, MessageMemoryMarker,
};
use crate::knowledge::ingestion::world_model_port::{WorldModelCheckpointInput, WorldModelPort};
use crate::knowledge::ingestion_cursor::{IngestionCursorError, IngestionWindow};
use crate::knowledge::repository::{
    KnowledgeError, KnowledgeRepository, UpsertKnowledgeCheckpointInput,
};
use crate::messages_store::StoredMessage;

/// The optional closure that resolves a persona id to a display name.
pub type PersonaNameResolver = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// The `KnowledgeIngestionServiceDependencies` of the TypeScript
/// (`types.ts:52-63`), with the memory provider replaced as described above.
pub struct KnowledgeIngestionDeps<C, X, K, W, M, P> {
    pub cursor: C,
    pub extractor: X,
    pub knowledge_repository: K,
    pub world_model: W,
    /// `null`/`undefined` in the TypeScript: Mem0 storage is skipped.
    pub memory_service: Option<Arc<M>>,
    pub message_marker: Option<P>,
    pub resolve_persona_name: Option<PersonaNameResolver>,
}

/// An error of [`KnowledgeIngestionService::ingest_conversation_window`].
#[derive(Debug)]
pub enum IngestionServiceError {
    /// The window could not be processed.
    Process(ProcessWindowError),
    /// A checkpoint read or write of the knowledge repository failed.
    Knowledge(KnowledgeError),
    /// `throw new Error('Mem0 persistence incomplete: …')` (`service.ts:57-61`).
    MemoryPending(String),
}

impl std::fmt::Display for IngestionServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IngestionServiceError::Process(error) => write!(f, "{error}"),
            IngestionServiceError::Knowledge(error) => write!(f, "{error}"),
            IngestionServiceError::MemoryPending(reason) => f.write_str(reason),
        }
    }
}

impl From<ProcessWindowError> for IngestionServiceError {
    fn from(error: ProcessWindowError) -> Self {
        IngestionServiceError::Process(error)
    }
}

impl From<KnowledgeError> for IngestionServiceError {
    fn from(error: KnowledgeError) -> Self {
        IngestionServiceError::Knowledge(error)
    }
}

/// `minMessagesPerBatch` of the service (`service.ts:18-20`): `Math.floor(Number(x || 1))`,
/// at least 1, and 1 for a non-finite value.
pub fn clamp_min_messages(value: Option<f64>) -> usize {
    let raw = value
        .filter(|number| *number != 0.0 && !number.is_nan())
        .unwrap_or(1.0)
        .floor();
    if raw.is_finite() {
        raw.max(1.0) as usize
    } else {
        1
    }
}

/// The outcome of one window in [`KnowledgeIngestionService::run_once`].
enum WindowRun {
    Processed,
    /// The Mem0 facts stayed pending in legacy mode. The window is retried later.
    Incomplete(String),
}

/// `KnowledgeIngestionService` (`service.ts:14-169`).
pub struct KnowledgeIngestionService<C, X, K, W, M, P> {
    deps: KnowledgeIngestionDeps<C, X, K, W, M, P>,
    min_messages_per_batch: usize,
}

impl<C, X, K, W, M, P> KnowledgeIngestionService<C, X, K, W, M, P>
where
    C: IngestionCursorLike + Sync,
    X: KnowledgeExtractorLike + Sync,
    K: KnowledgeRepository + Sync,
    W: WorldModelPort + Sync,
    M: MemoryFactService + Sync,
    P: MessageMemoryMarker + Sync,
{
    pub fn new(
        deps: KnowledgeIngestionDeps<C, X, K, W, M, P>,
        options: KnowledgeIngestionServiceOptions,
    ) -> Self {
        Self {
            deps,
            min_messages_per_batch: clamp_min_messages(options.min_messages_per_batch),
        }
    }

    /// The knowledge repository the service writes to.
    pub fn repository(&self) -> &K {
        &self.deps.knowledge_repository
    }

    /// `ingestConversationWindow(input)` (`service.ts:34-92`): ingests the messages
    /// after the checkpoint of one conversation, as one window.
    pub async fn ingest_conversation_window(
        &self,
        input: IngestConversationWindowInput,
    ) -> Result<(), IngestionServiceError> {
        let persona_id = input.persona_id.trim().to_string();
        if persona_id.is_empty() {
            return Ok(());
        }

        let mut sorted: Vec<StoredMessage> = input.messages.clone();
        sorted.sort_by_key(|message| message.seq.unwrap_or(0));
        if sorted.is_empty() {
            return Ok(());
        }

        let checkpoint = self.deps.knowledge_repository.get_ingestion_checkpoint(
            &input.conversation_id,
            &input.user_id,
            Some(&persona_id),
        )?;
        let from_seq_exclusive = checkpoint.map(|value| value.last_seq).unwrap_or(0).max(0);
        let delta: Vec<StoredMessage> = sorted
            .into_iter()
            .filter(|message| message.seq.unwrap_or(0) > from_seq_exclusive)
            .collect();
        if delta.is_empty() || delta.len() < self.min_messages_per_batch {
            return Ok(());
        }

        let last_seq = delta
            .last()
            .and_then(|message| message.seq)
            .filter(|seq| *seq != 0)
            .unwrap_or(from_seq_exclusive);
        let to_seq_inclusive = last_seq.max(from_seq_exclusive);

        let window = IngestionWindow {
            conversation_id: input.conversation_id.clone(),
            user_id: input.user_id.clone(),
            persona_id: persona_id.clone(),
            workspace_id: input.workspace_id.clone(),
            from_seq_exclusive,
            to_seq_inclusive,
            messages: delta,
        };

        let result = self.process_window(&window).await?;
        let config = self.deps.world_model.config();
        if result.mem0_pending_count > 0 && !config.enabled && !config.e2e_enabled {
            return Err(IngestionServiceError::MemoryPending(format!(
                "Mem0 persistence incomplete: {} fact(s) remain pending; ingestion checkpoint was not advanced.",
                result.mem0_pending_count
            )));
        }
        if result.world_model_projected {
            self.commit_world_model_checkpoint(&window, &result).await?;
        }
        self.deps.knowledge_repository.upsert_ingestion_checkpoint(
            &UpsertKnowledgeCheckpointInput {
                conversation_id: window.conversation_id.clone(),
                user_id: Some(window.user_id.clone()),
                persona_id: window.persona_id.clone(),
                last_seq: window.to_seq_inclusive,
            },
        )?;
        Ok(())
    }

    /// `runOnce()` (`service.ts:94-146`): processes every pending window, with
    /// the global Mem0 circuit breaker.
    pub async fn run_once(&self) -> Result<KnowledgeIngestionRunResult, IngestionCursorError> {
        let windows = self.deps.cursor.get_pending_windows(200)?;
        let mut result = KnowledgeIngestionRunResult::default();
        let mut global_mem0_failures = 0usize;

        for window in windows {
            if window.messages.len() < self.min_messages_per_batch {
                continue;
            }
            // Global circuit breaker: stop when Mem0 is unhealthy.
            if global_mem0_failures >= MEM0_MAX_GLOBAL_FAILURES_PER_CYCLE {
                warn!(
                    failures = global_mem0_failures,
                    "[KnowledgeIngestion] Global circuit breaker open, skipping remaining windows."
                );
                break;
            }

            match self.run_window(&window, &mut global_mem0_failures).await {
                Ok(WindowRun::Processed) => {
                    result.processed_conversations += 1;
                    result.processed_messages += window.messages.len();
                }
                Ok(WindowRun::Incomplete(reason)) => result.errors.push(KnowledgeIngestionError {
                    conversation_id: window.conversation_id.clone(),
                    persona_id: window.persona_id.clone(),
                    reason,
                }),
                Err(error) => result.errors.push(KnowledgeIngestionError {
                    conversation_id: window.conversation_id.clone(),
                    persona_id: window.persona_id.clone(),
                    reason: error.to_string(),
                }),
            }
        }

        Ok(result)
    }

    /// The body of one window in `runOnce` (`service.ts:107-137`).
    async fn run_window(
        &self,
        window: &IngestionWindow,
        global_mem0_failures: &mut usize,
    ) -> Result<WindowRun, IngestionServiceError> {
        let result = self.process_window(window).await?;
        *global_mem0_failures += result.mem0_fail_count;

        // Back off between windows when Mem0 shows stress.
        if result.mem0_fail_count > 0 {
            tokio::time::sleep(Duration::from_millis(
                MEM0_FAILURE_BACKOFF_BASE_MS * result.mem0_fail_count as u64,
            ))
            .await;
        }

        let config = self.deps.world_model.config();
        if result.mem0_pending_count > 0 && !config.enabled && !config.e2e_enabled {
            return Ok(WindowRun::Incomplete(format!(
                "Mem0 persistence incomplete: {} fact(s) remain pending; window will be retried.",
                result.mem0_pending_count
            )));
        }

        if result.world_model_projected {
            self.commit_world_model_checkpoint(window, &result).await?;
        }
        // `markWindowProcessed` runs inside the window's `try` (`service.ts:143`),
        // so its failure is reported for this window.
        self.deps.cursor.mark_window_processed(window)?;
        Ok(WindowRun::Processed)
    }

    /// `upsertWorldModelIngestionCheckpoint` for a projected window.
    async fn commit_world_model_checkpoint(
        &self,
        window: &IngestionWindow,
        result: &ProcessWindowResult,
    ) -> Result<(), IngestionServiceError> {
        self.deps
            .world_model
            .upsert_ingestion_checkpoint(WorldModelCheckpointInput {
                conversation_id: window.conversation_id.clone(),
                user_id: window.user_id.clone(),
                persona_id: window.persona_id.clone(),
                workspace_id: window.workspace_id.clone().unwrap_or_default(),
                last_seq: window.to_seq_inclusive,
                source_window_id: window_id_of(window),
                committed_observation_id: result.world_model_observation_id.clone(),
            })
            .await
            .map_err(|error| IngestionServiceError::Process(ProcessWindowError::WorldModel(error)))
    }

    /// `processWindow(window)` (`service.ts:148-165`).
    async fn process_window(
        &self,
        window: &IngestionWindow,
    ) -> Result<ProcessWindowResult, ProcessWindowError> {
        process_window(ProcessWindowContext {
            window,
            extractor: &self.deps.extractor,
            repo: &self.deps.knowledge_repository,
            memory: self.deps.memory_service.as_deref(),
            world_model: &self.deps.world_model,
            // Dropping `Send` from the trait object is an unsizing coercion.
            resolve_persona_name: self
                .deps
                .resolve_persona_name
                .as_deref()
                .map(|resolver| resolver as &(dyn Fn(&str) -> Option<String> + Sync)),
            marker: self.deps.message_marker.as_ref(),
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_minimum_batch_is_floored_and_at_least_one() {
        assert_eq!(clamp_min_messages(None), 1);
        assert_eq!(clamp_min_messages(Some(0.0)), 1);
        assert_eq!(clamp_min_messages(Some(f64::NAN)), 1);
        assert_eq!(clamp_min_messages(Some(3.8)), 3);
        assert_eq!(clamp_min_messages(Some(-4.0)), 1);
    }

    use crate::knowledge::extractor::KnowledgeExtractionResult;
    use crate::knowledge::extractor::KnowledgeMeetingLedger;
    use crate::knowledge::ingestion::test_support::FakeWorldModel;
    use crate::knowledge::ingestion::types::{
        ExistingFactNode, FactStoreInput, KnowledgeExtractionInput, MemoryFactError,
        MessageMemoryMarker,
    };
    use crate::knowledge::repository::{KnowledgeRepository, ListKnowledgeFilter};
    use crate::knowledge::sqlite_knowledge_repository::SqliteKnowledgeRepository;
    use crate::messages_store::{MessageRepositoryError, StoredMessage};
    use serde_json::{Map, Value};
    use std::sync::Mutex;

    /// The cursor hands out a fixed list and records every processed window.
    struct FakeCursor {
        windows: Vec<IngestionWindow>,
        processed: Mutex<Vec<String>>,
    }

    impl IngestionCursorLike for FakeCursor {
        fn get_pending_windows(
            &self,
            _limit_conversations: i64,
        ) -> Result<Vec<IngestionWindow>, IngestionCursorError> {
            Ok(self.windows.clone())
        }

        fn mark_window_processed(&self, window: &IngestionWindow) -> Result<(), KnowledgeError> {
            self.processed
                .lock()
                .expect("lock")
                .push(window.conversation_id.clone());
            Ok(())
        }
    }

    /// Every extraction yields the same single fact.
    struct FixedExtractor;

    impl KnowledgeExtractorLike for FixedExtractor {
        async fn extract(&self, _input: &KnowledgeExtractionInput) -> KnowledgeExtractionResult {
            KnowledgeExtractionResult {
                facts: vec!["Ich wohne in Berlin".to_string()],
                teaser: "Wohnort".to_string(),
                episode: "Der Nutzer erzaehlt vom Wohnort.".to_string(),
                meeting_ledger: KnowledgeMeetingLedger {
                    topic_key: "wohnort".to_string(),
                    counterpart: None,
                    participants: vec![],
                    decisions: vec![],
                    negotiated_terms: vec![],
                    open_points: vec![],
                    action_items: vec![],
                    source_refs: vec![],
                    confidence: 0.6,
                },
                events: vec![],
                entities: vec![],
            }
        }
    }

    /// Stores every fact. A user whose id is in `failing_users` gets an error for
    /// each fact, which leaves the window's facts pending.
    #[derive(Default)]
    struct SelectiveMemory {
        failing_users: Vec<&'static str>,
        stored: Mutex<Vec<String>>,
    }

    impl MemoryFactService for SelectiveMemory {
        async fn store_fact(
            &self,
            input: FactStoreInput,
        ) -> Result<Option<String>, MemoryFactError> {
            if self.failing_users.contains(&input.user_id.as_str()) {
                return Err(MemoryFactError("mem0 unavailable".into()));
            }
            let mut stored = self.stored.lock().expect("lock");
            stored.push(input.content);
            Ok(Some(format!("mem-{}", stored.len())))
        }

        async fn list_fact_nodes(
            &self,
            _persona_id: &str,
            _user_id: &str,
            _page_size: usize,
        ) -> Result<Vec<ExistingFactNode>, MemoryFactError> {
            Ok(Vec::new())
        }

        async fn update_memory_metadata(
            &self,
            _persona_id: &str,
            _memory_id: &str,
            _user_id: &str,
            _metadata: Map<String, Value>,
        ) -> Result<(), MemoryFactError> {
            Ok(())
        }
    }

    /// The service needs a marker type; this one never marks anything.
    struct NoMarker;

    impl MessageMemoryMarker for NoMarker {
        fn mark_messages_memory_pending(
            &self,
            _message_ids: &[&str],
            _pending: bool,
            _error_message: Option<&str>,
        ) -> Result<(), MessageRepositoryError> {
            Ok(())
        }
    }

    type TestService = KnowledgeIngestionService<
        FakeCursor,
        FixedExtractor,
        SqliteKnowledgeRepository,
        FakeWorldModel,
        SelectiveMemory,
        NoMarker,
    >;

    fn service(
        windows: Vec<IngestionWindow>,
        memory: Arc<SelectiveMemory>,
        min_messages_per_batch: Option<f64>,
    ) -> TestService {
        KnowledgeIngestionService::new(
            KnowledgeIngestionDeps {
                cursor: FakeCursor {
                    windows,
                    processed: Mutex::new(Vec::new()),
                },
                extractor: FixedExtractor,
                knowledge_repository: SqliteKnowledgeRepository::open(":memory:")
                    .expect("in-memory store"),
                world_model: FakeWorldModel::default(),
                memory_service: Some(memory),
                message_marker: None::<NoMarker>,
                resolve_persona_name: None,
            },
            KnowledgeIngestionServiceOptions {
                min_messages_per_batch,
            },
        )
    }

    fn message(seq: Option<i64>, content: &str) -> StoredMessage {
        StoredMessage {
            id: format!("m-{seq:?}-{content}"),
            conversation_id: "c-1".into(),
            seq,
            role: if seq.unwrap_or(0) % 2 == 0 {
                "agent".into()
            } else {
                "user".into()
            },
            content: content.into(),
            platform: "web".into(),
            external_msg_id: None,
            sender_name: None,
            metadata: None,
            created_at: String::new(),
        }
    }

    /// A window of `first..=last` for one user, conversation `c-<user>`.
    fn window(user: &str, first: i64, last: i64) -> IngestionWindow {
        IngestionWindow {
            conversation_id: format!("c-{user}"),
            user_id: user.into(),
            persona_id: "p-1".into(),
            workspace_id: None,
            from_seq_exclusive: first - 1,
            to_seq_inclusive: last,
            messages: (first..=last)
                .map(|seq| message(Some(seq), "Ich wohne in Berlin"))
                .collect(),
        }
    }

    fn direct_input(
        user: &str,
        persona: &str,
        messages: Vec<StoredMessage>,
    ) -> IngestConversationWindowInput {
        IngestConversationWindowInput {
            conversation_id: "c-1".into(),
            user_id: user.into(),
            persona_id: persona.into(),
            workspace_id: None,
            messages,
            summary_text: None,
            persona_context: None,
        }
    }

    fn checkpoint_of(service: &TestService, user: &str) -> Option<i64> {
        service
            .repository()
            .get_ingestion_checkpoint("c-1", user, Some("p-1"))
            .expect("checkpoint read")
            .map(|checkpoint| checkpoint.last_seq)
    }

    fn ten_messages(seqs: std::ops::RangeInclusive<i64>) -> Vec<StoredMessage> {
        seqs.map(|seq| message(Some(seq), "Ich wohne in Berlin"))
            .collect()
    }

    /// A pending window is processed once: its fact is stored and the checkpoint
    /// moves to the last sequence number.
    #[tokio::test]
    async fn a_window_is_processed_once_and_its_checkpoint_advances() {
        let memory = Arc::new(SelectiveMemory::default());
        let service = service(vec![window("u-ok", 1, 3)], memory.clone(), None);

        let result = service.run_once().await.expect("cursor");

        assert_eq!(result.processed_conversations, 1);
        assert_eq!(result.processed_messages, 3);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(memory.stored.lock().expect("lock").len(), 1);
        // The cursor writes the checkpoint when it marks the window processed.
        assert_eq!(
            *service.deps.cursor.processed.lock().expect("lock"),
            vec!["c-u-ok".to_string()]
        );
    }

    /// A window whose Mem0 facts stay pending is reported, keeps its checkpoint
    /// and is not marked processed. The window after it still runs.
    #[tokio::test]
    async fn a_failed_window_is_reported_and_the_windows_after_it_still_run() {
        let memory = Arc::new(SelectiveMemory {
            failing_users: vec!["u-bad"],
            ..Default::default()
        });
        let service = service(
            vec![window("u-bad", 1, 2), window("u-ok", 1, 3)],
            memory.clone(),
            None,
        );

        let result = service.run_once().await.expect("cursor");

        assert_eq!(result.processed_conversations, 1);
        assert_eq!(result.errors.len(), 1, "{:?}", result.errors);
        assert_eq!(result.errors[0].conversation_id, "c-u-bad");
        assert!(result.errors[0].reason.contains("persistence incomplete"));
        assert_eq!(checkpoint_of(&service, "u-bad"), None);
        assert_eq!(
            *service.deps.cursor.processed.lock().expect("lock"),
            vec!["c-u-ok".to_string()],
            "only the completed window is marked"
        );
    }

    /// Ingesting the same window twice stores its fact once: the second call sees
    /// the checkpoint and has no delta.
    #[tokio::test]
    async fn ingesting_the_same_window_twice_stores_its_facts_once() {
        let memory = Arc::new(SelectiveMemory::default());
        let service = service(Vec::new(), memory.clone(), None);
        let input = || direct_input("u-ok", "p-1", ten_messages(1..=3));

        service
            .ingest_conversation_window(input())
            .await
            .expect("first");
        service
            .ingest_conversation_window(input())
            .await
            .expect("second");

        assert_eq!(memory.stored.lock().expect("lock").len(), 1);
        assert_eq!(checkpoint_of(&service, "u-ok"), Some(3));
    }

    /// No persona id, or messages without a sequence number, are skipped without
    /// touching the checkpoint or memory.
    #[tokio::test]
    async fn a_direct_window_without_persona_or_sequence_numbers_is_skipped() {
        let memory = Arc::new(SelectiveMemory::default());
        let service = service(Vec::new(), memory.clone(), None);

        service
            .ingest_conversation_window(direct_input("u-ok", "   ", ten_messages(1..=3)))
            .await
            .expect("blank persona is skipped");
        let without_seq = vec![message(None, "a"), message(None, "b")];
        service
            .ingest_conversation_window(direct_input("u-ok", "p-1", without_seq))
            .await
            .expect("messages without seq are skipped");

        assert_eq!(checkpoint_of(&service, "u-ok"), None);
        assert!(memory.stored.lock().expect("lock").is_empty());
    }

    /// Only the messages after the checkpoint form the window: the episode starts
    /// at the first new sequence number, and the checkpoint moves to the last.
    #[tokio::test]
    async fn a_direct_window_processes_only_the_messages_after_the_checkpoint() {
        let memory = Arc::new(SelectiveMemory::default());
        let service = service(Vec::new(), memory.clone(), None);
        service
            .repository()
            .upsert_ingestion_checkpoint(&UpsertKnowledgeCheckpointInput {
                conversation_id: "c-1".into(),
                user_id: Some("u-ok".into()),
                persona_id: "p-1".into(),
                last_seq: 2,
            })
            .expect("seed checkpoint");

        service
            .ingest_conversation_window(direct_input("u-ok", "p-1", ten_messages(1..=4)))
            .await
            .expect("window");

        assert_eq!(checkpoint_of(&service, "u-ok"), Some(4));
        let episodes = service
            .repository()
            .list_episodes(&ListKnowledgeFilter {
                user_id: "u-ok".into(),
                persona_id: "p-1".into(),
                ..Default::default()
            })
            .expect("episodes");
        assert_eq!(episodes.len(), 1);
        assert_eq!(episodes[0].source_seq_start, 3);
        assert_eq!(episodes[0].source_seq_end, 4);
    }

    /// A direct window with fewer new messages than the minimum waits for a later
    /// batch: no checkpoint and no memory write.
    #[tokio::test]
    async fn a_direct_window_below_the_minimum_batch_waits_for_more_messages() {
        let memory = Arc::new(SelectiveMemory::default());
        let service = service(Vec::new(), memory.clone(), Some(3.0));

        service
            .ingest_conversation_window(direct_input("u-ok", "p-1", ten_messages(1..=2)))
            .await
            .expect("window");

        assert_eq!(checkpoint_of(&service, "u-ok"), None);
        assert!(memory.stored.lock().expect("lock").is_empty());
    }
}
