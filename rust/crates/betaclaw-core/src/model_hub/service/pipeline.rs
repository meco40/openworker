//! Port of `src/server/model-hub/service/pipeline/get.ts`.
//!
//! The four reads/writes of `get.ts`: `listPipeline` (`get.ts:7-12`),
//! `addModelToPipeline` (`get.ts:14-19`), `removeModelFromPipeline`
//! (`get.ts:21-23`) and `updateModelStatus` (`get.ts:25-31`).
//!
//! `service/pipeline/update.ts` (`movePipelineModel`, `replacePipeline`) lives in
//! the child module [`update`].

pub mod update;

use crate::model_hub::repository::{ModelHubRepository, RepositoryError};
use crate::model_hub::types::{CreatePipelineModelInput, PipelineModelEntry, PipelineStatus};

/// `listPipeline(repository, profileId)` from `pipeline/get.ts:7-12`.
///
/// A 1:1 delegation. The TypeScript signature promises a
/// `PipelineModelEntry[]`; the underlying repository can only fail at the
/// database boundary, so the port surfaces [`RepositoryError`] instead of
/// panicking.
pub fn list_pipeline(
    repository: &dyn ModelHubRepository,
    profile_id: &str,
) -> Result<Vec<PipelineModelEntry>, RepositoryError> {
    repository.list_pipeline_models(profile_id)
}

/// `addModelToPipeline(repository, input)` from `pipeline/get.ts:14-19`.
pub fn add_model_to_pipeline(
    repository: &dyn ModelHubRepository,
    input: CreatePipelineModelInput,
) -> Result<PipelineModelEntry, RepositoryError> {
    repository.add_pipeline_model(input)
}

/// `removeModelFromPipeline(repository, modelId)` from `pipeline/get.ts:21-23`.
pub fn remove_model_from_pipeline(
    repository: &dyn ModelHubRepository,
    model_id: &str,
) -> Result<bool, RepositoryError> {
    repository.remove_pipeline_model(model_id)
}

/// `updateModelStatus(repository, modelId, status)` from `pipeline/get.ts:25-31`.
pub fn update_model_status(
    repository: &dyn ModelHubRepository,
    model_id: &str,
    status: PipelineStatus,
) -> Result<(), RepositoryError> {
    repository.update_pipeline_model_status(model_id, status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::service::test_doubles::StubRepository;
    use crate::model_hub::sqlite::SqliteModelHubRepository;

    fn entry(id: &str, profile_id: &str) -> PipelineModelEntry {
        PipelineModelEntry {
            id: id.to_string(),
            profile_id: profile_id.to_string(),
            account_id: "acc".to_string(),
            provider_id: "openai".to_string(),
            model_name: "gpt-4.1".to_string(),
            reasoning_effort: None,
            priority: 1,
            status: crate::model_hub::types::PipelineStatus::Active,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn list_pipeline_forwards_the_profile_id_verbatim() {
        let repository = StubRepository::default();
        let entries = list_pipeline(&repository, "p1").expect("repository call");
        assert!(entries.is_empty());
        assert_eq!(repository.pipeline_requests(), vec!["p1".to_string()]);
    }

    /// Against the real SQLite repository the wrapper must observe whatever the
    /// `ORDER BY priority ASC` query produces.
    #[test]
    fn list_pipeline_reads_the_real_repository() {
        let repository = SqliteModelHubRepository::in_memory().expect("in-memory database");
        repository
            .add_pipeline_model(crate::model_hub::types::CreatePipelineModelInput {
                profile_id: "p1".to_string(),
                account_id: "acc".to_string(),
                provider_id: "openai".to_string(),
                model_name: "gpt-4.1".to_string(),
                reasoning_effort: None,
                priority: 1,
            })
            .expect("insert");

        let entries = list_pipeline(&repository, "p1").expect("repository call");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].model_name, "gpt-4.1");
        assert!(list_pipeline(&repository, "p1-embeddings")
            .expect("repository call")
            .is_empty());
        let _ = entry("p1", "p1");
    }
}
