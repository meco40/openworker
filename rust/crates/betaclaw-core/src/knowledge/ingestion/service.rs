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
}
