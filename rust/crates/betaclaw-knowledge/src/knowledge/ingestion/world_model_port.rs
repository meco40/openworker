//! Port of the World Model (S6) surface that four `ingestion/` files use:
//! `ingestion/messageProcessor.ts`, `service.ts`, `factExtractor.ts` and
//! `taskCompletion.ts`. Those files are assigned to the S6 lane, so this module
//! defines what they need as traits and leaves the implementation to S6.
//!
//! | TypeScript import | Port member |
//! | --- | --- |
//! | `world-model/config` `getWorldModelConfig` (`messageProcessor.ts:19`, `service.ts:13`) | [`WorldModelPort::config`] |
//! | `world-model/mode` `isWorldModelRequired` (`messageProcessor.ts:20`) | [`WorldModelConfigView::required`] |
//! | `world-model/mem0Policy` `isMem0FactualWriteBlocked` (`factExtractor.ts:24`, `taskCompletion.ts:6`) | [`WorldModelPort::is_mem0_factual_write_blocked`] |
//! | `world-model/projector/normalizeExtraction` (`messageProcessor.ts:17`) | [`WorldModelPort::normalize_extraction`] |
//! | `world-model/projector/projectWindow` (`messageProcessor.ts:18`) | [`WorldModelPort::project_window`] |
//! | `world-model/repositories/projectionPendingRepository` `enqueueProjectionPending` (`messageProcessor.ts:22`) | [`WorldModelPort::enqueue_projection_pending`] |
//! | `world-model/services/standingIntentCompiler` `processIncomingStandingIntents` (`messageProcessor.ts:26`) | [`WorldModelPort::process_incoming_standing_intents`] |
//! | `world-model/repositories/observationRepository` `getObservationById` (`messageProcessor.ts:24`) | [`WorldModelPort::get_observation_by_id`] |
//! | `world-model/services/prospectiveEngine` `matchStandingIntents` (`messageProcessor.ts:25`) | [`WorldModelPort::match_standing_intents`] |
//! | `world-model/repositories/ingestionCheckpointRepository` `upsertWorldModelIngestionCheckpoint` (`service.ts:14`) | [`WorldModelPort::upsert_ingestion_checkpoint`] |
//!
//! The shapes below carry only the fields the knowledge code reads or writes.
//! The S6 port may keep the full projection behind [`WorldModelProjection::payload`].
//! Every async method returns `impl Future + Send`, so an implementation may call
//! the PostgreSQL driver.

use std::future::Future;

use serde_json::Value;

use crate::knowledge::extractor::KnowledgeExtractionResult;

/// An error from a World Model operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldModelPortError(pub String);

impl std::fmt::Display for WorldModelPortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The fields of `getWorldModelConfig()` that the ingestion files read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorldModelConfigView {
    /// `config.enabled`.
    pub enabled: bool,
    /// `config.e2eEnabled`.
    pub e2e_enabled: bool,
    /// `isWorldModelRequired(config.mode)`: a failed projection aborts the window.
    pub required: bool,
}

/// `{ userId, personaId, workspaceId }` of the projection scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldModelScope {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
}

/// A task found by the projector (only the title is used by the knowledge code).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedTask {
    pub title: String,
}

/// `WorldModelProjection` as the knowledge code sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldModelProjection {
    pub tasks: Vec<ProjectedTask>,
    /// The rest of the projection, opaque to the knowledge code.
    pub payload: Value,
}

/// One `completedTaskEvidence` entry of `projectWindow`.
#[derive(Debug, Clone, PartialEq)]
pub struct CompletedTaskEvidence {
    pub title: String,
    pub message_seq: i64,
    pub evidence_text: String,
    pub confidence: f64,
}

/// The `observation` argument of `projectWindow`.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservationDraft {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    /// Always `"automation"` in the ingestion path.
    pub source_type: String,
    pub source_id: String,
    pub occurred_at: String,
    /// The window payload (conversation, sequence range, texts, raw extraction).
    pub payload: Value,
    /// Always `"persona"` in the ingestion path.
    pub source_authority: String,
}

/// The argument of [`WorldModelPort::project_window`].
#[derive(Debug, Clone)]
pub struct ProjectWindowRequest<'a> {
    pub scope: WorldModelScope,
    pub projection: WorldModelProjection,
    pub observation: ObservationDraft,
    pub extraction: &'a KnowledgeExtractionResult,
    pub completed_task_evidence: Vec<CompletedTaskEvidence>,
}

/// The result of [`WorldModelPort::project_window`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectWindowResult {
    pub observation_id: String,
}

/// The full observation returned by `getObservationById`; standing-intent
/// matching reads its tenant scope and payload as well as its id.
pub type ObservationRecord = crate::world_model::types::Observation;

/// The argument of [`WorldModelPort::enqueue_projection_pending`].
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionPendingInput {
    pub scope: WorldModelScope,
    /// `world_model_window`, `mem0_fact` or `sqlite_knowledge`.
    pub projection_type: String,
    pub source_window_id: String,
    pub source_observation_id: Option<String>,
    pub payload: Value,
    pub error_message: String,
}

/// The argument of [`WorldModelPort::upsert_ingestion_checkpoint`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldModelCheckpointInput {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub last_seq: i64,
    pub source_window_id: String,
    pub committed_observation_id: Option<String>,
}

/// The World Model operations of the ingestion pipeline.
pub trait WorldModelPort {
    /// `getWorldModelConfig()`.
    fn config(&self) -> WorldModelConfigView;

    /// `isMem0FactualWriteBlocked()`: in canonical mode factual facts are not
    /// written to Mem0.
    fn is_mem0_factual_write_blocked(&self) -> bool;

    /// `normalizeExtraction({ result, workspaceId, userId, personaId })`.
    fn normalize_extraction(
        &self,
        result: &KnowledgeExtractionResult,
        scope: &WorldModelScope,
    ) -> Result<WorldModelProjection, WorldModelPortError>;

    /// `projectWindow({ scope, projection, observation, extraction, completedTaskEvidence })`.
    fn project_window(
        &self,
        request: ProjectWindowRequest<'_>,
    ) -> impl Future<Output = Result<ProjectWindowResult, WorldModelPortError>> + Send;

    /// `enqueueProjectionPending(input)`: a retry record for a failed projection.
    fn enqueue_projection_pending(
        &self,
        input: ProjectionPendingInput,
    ) -> impl Future<Output = Result<(), WorldModelPortError>> + Send;

    /// `processIncomingStandingIntents({ userId, personaId, workspaceId, text })`.
    fn process_incoming_standing_intents(
        &self,
        scope: &WorldModelScope,
        text: &str,
    ) -> impl Future<Output = Result<(), WorldModelPortError>> + Send;

    /// `getObservationById(id, scope)`.
    fn get_observation_by_id(
        &self,
        observation_id: &str,
        scope: &WorldModelScope,
    ) -> impl Future<Output = Result<Option<ObservationRecord>, WorldModelPortError>> + Send;

    /// `matchStandingIntents(observation)`.
    fn match_standing_intents(
        &self,
        observation: &ObservationRecord,
    ) -> impl Future<Output = Result<(), WorldModelPortError>> + Send;

    /// `upsertWorldModelIngestionCheckpoint({ ... })`.
    fn upsert_ingestion_checkpoint(
        &self,
        input: WorldModelCheckpointInput,
    ) -> impl Future<Output = Result<(), WorldModelPortError>> + Send;
}
