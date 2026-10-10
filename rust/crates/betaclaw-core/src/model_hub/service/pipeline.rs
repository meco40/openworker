//! Port of `src/server/model-hub/service/pipeline/get.ts`.
//!
//! Only `listPipeline` is ported here: it is the one pipeline read the dispatch
//! path and the four callers that gate slice S4a need. The write operations of
//! `service/pipeline/update.ts` (`addModelToPipeline`, `removeModelFromPipeline`,
//! `updateModelStatus`, `movePipelineModel`) are exercised by the pipeline
//! routes and stay with the route slice, because they exist only to serve them.

use crate::model_hub::repository::{ModelHubRepository, RepositoryError};
use crate::model_hub::types::PipelineModelEntry;

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
