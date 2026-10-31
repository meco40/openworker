//! Test doubles for the ingestion ports. Compiled only for tests.

use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::knowledge::extractor::KnowledgeExtractionResult;
use crate::knowledge::ingestion::types::{
    ExistingFactNode, FactStoreInput, MemoryFactError, MemoryFactService,
};
use crate::knowledge::ingestion::world_model_port::{
    ObservationRecord, ProjectWindowRequest, ProjectWindowResult, ProjectionPendingInput,
    WorldModelCheckpointInput, WorldModelConfigView, WorldModelPort, WorldModelPortError,
    WorldModelProjection, WorldModelScope,
};

/// A memory service that stores every fact and reports no existing facts. The
/// returned id is `mem-<length of the content>`.
#[derive(Debug, Default)]
pub struct FakeMemory;

impl MemoryFactService for FakeMemory {
    async fn store_fact(&self, input: FactStoreInput) -> Result<Option<String>, MemoryFactError> {
        Ok(Some(format!("mem-{}", input.content.len())))
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

/// A World Model that is disabled by default. With `canonical` set it is enabled and
/// the canonical projection succeeds with the observation `obs-1`. Every other
/// operation succeeds without doing anything.
#[derive(Debug, Default)]
pub struct FakeWorldModel {
    pub blocked: bool,
    pub canonical: bool,
    /// Every `enqueue_projection_pending` call, in order.
    pub enqueued: Mutex<Vec<ProjectionPendingInput>>,
}

impl WorldModelPort for FakeWorldModel {
    fn config(&self) -> WorldModelConfigView {
        WorldModelConfigView {
            enabled: self.canonical,
            e2e_enabled: false,
            required: false,
        }
    }

    fn is_mem0_factual_write_blocked(&self) -> bool {
        self.blocked
    }

    fn normalize_extraction(
        &self,
        _result: &KnowledgeExtractionResult,
        _scope: &WorldModelScope,
    ) -> Result<WorldModelProjection, WorldModelPortError> {
        if !self.canonical {
            return Err(WorldModelPortError("the fake does not project".into()));
        }
        Ok(WorldModelProjection {
            tasks: Vec::new(),
            payload: Value::Null,
        })
    }

    async fn project_window(
        &self,
        _request: ProjectWindowRequest<'_>,
    ) -> Result<ProjectWindowResult, WorldModelPortError> {
        if !self.canonical {
            return Err(WorldModelPortError("the fake does not project".into()));
        }
        Ok(ProjectWindowResult {
            observation_id: "obs-1".to_string(),
        })
    }

    async fn enqueue_projection_pending(
        &self,
        input: ProjectionPendingInput,
    ) -> Result<(), WorldModelPortError> {
        self.enqueued.lock().expect("lock").push(input);
        Ok(())
    }

    async fn process_incoming_standing_intents(
        &self,
        _scope: &WorldModelScope,
        _text: &str,
    ) -> Result<(), WorldModelPortError> {
        Ok(())
    }

    async fn get_observation_by_id(
        &self,
        _observation_id: &str,
        _scope: &WorldModelScope,
    ) -> Result<Option<ObservationRecord>, WorldModelPortError> {
        Ok(None)
    }

    async fn match_standing_intents(
        &self,
        _observation: &ObservationRecord,
    ) -> Result<(), WorldModelPortError> {
        Ok(())
    }

    async fn upsert_ingestion_checkpoint(
        &self,
        _input: WorldModelCheckpointInput,
    ) -> Result<(), WorldModelPortError> {
        Ok(())
    }
}
