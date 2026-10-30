//! Port of `src/server/model-hub/service/pipeline/update.ts` (1-35).
//!
//! `movePipelineModel` swaps the priorities of two adjacent entries
//! (`update.ts:7-27`); the swap is two independent `updatePipelineModelPriority`
//! calls, exactly like the original — so a partial failure is visible to SQLite
//! but never observed here. `replacePipeline` replaces the whole profile
//! (`update.ts:29-35`).

use crate::model_hub::repository::ModelHubRepository;
use crate::model_hub::types::{CreatePipelineModelInput, PipelineModelEntry};

use super::super::ServiceError;

/// `direction` from `update.ts:11` (`'up' | 'down'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineDirection {
    Up,
    Down,
}

impl PipelineDirection {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "up" => Some(PipelineDirection::Up),
            "down" => Some(PipelineDirection::Down),
            _ => None,
        }
    }
}

/// `movePipelineModel(repository, profileId, modelId, direction)` from
/// `update.ts:7-27`.
///
/// Returns `false` when the model is not in the profile or the move would leave
/// the pipeline; otherwise both priorities are swapped and it returns `true`.
pub fn move_pipeline_model(
    repository: &dyn ModelHubRepository,
    profile_id: &str,
    model_id: &str,
    direction: PipelineDirection,
) -> Result<bool, ServiceError> {
    let mut pipeline = repository.list_pipeline_models(profile_id)?;
    pipeline.sort_by_key(|entry| entry.priority);

    let Some(source_index) = pipeline.iter().position(|entry| entry.id == model_id) else {
        return Ok(false);
    };

    let target_index = match direction {
        PipelineDirection::Up => source_index.checked_sub(1),
        PipelineDirection::Down => Some(source_index + 1).filter(|index| *index < pipeline.len()),
    };
    // `targetIndex < 0 || targetIndex >= pipeline.length` -> false.
    let Some(target_index) = target_index.filter(|index| *index < pipeline.len()) else {
        return Ok(false);
    };

    let source = &pipeline[source_index];
    let target = &pipeline[target_index];
    repository.update_pipeline_model_priority(&source.id, target.priority)?;
    repository.update_pipeline_model_priority(&target.id, source.priority)?;
    Ok(true)
}

/// `replacePipeline(repository, profileId, models)` from `update.ts:29-35`.
pub fn replace_pipeline(
    repository: &dyn ModelHubRepository,
    profile_id: &str,
    models: &[CreatePipelineModelInput],
) -> Result<Vec<PipelineModelEntry>, ServiceError> {
    Ok(repository.replace_pipeline(profile_id, models)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::sqlite::SqliteModelHubRepository;

    fn seed(repository: &SqliteModelHubRepository, names: &[(&str, i64)]) -> Vec<String> {
        names
            .iter()
            .map(|(name, priority)| {
                repository
                    .add_pipeline_model(CreatePipelineModelInput {
                        profile_id: "p1".to_string(),
                        account_id: "acc".to_string(),
                        provider_id: "openai".to_string(),
                        model_name: name.to_string(),
                        reasoning_effort: None,
                        priority: *priority,
                    })
                    .expect("insert")
                    .id
            })
            .collect()
    }

    fn order(repository: &SqliteModelHubRepository) -> Vec<String> {
        let mut pipeline = repository.list_pipeline_models("p1").expect("list");
        pipeline.sort_by_key(|entry| entry.priority);
        pipeline.into_iter().map(|entry| entry.model_name).collect()
    }

    /// `update.ts:22-25`: an up-move swaps the priorities of two neighbours.
    #[test]
    fn moving_up_swaps_with_the_previous_entry() {
        let repository = SqliteModelHubRepository::in_memory().expect("in-memory database");
        let ids = seed(&repository, &[("a", 1), ("b", 2), ("c", 3)]);
        assert!(
            move_pipeline_model(&repository, "p1", &ids[1], PipelineDirection::Up).expect("move")
        );
        assert_eq!(order(&repository), vec!["b", "a", "c"]);
    }

    /// A down-move swaps with the following entry.
    #[test]
    fn moving_down_swaps_with_the_next_entry() {
        let repository = SqliteModelHubRepository::in_memory().expect("in-memory database");
        let ids = seed(&repository, &[("a", 1), ("b", 2), ("c", 3)]);
        assert!(
            move_pipeline_model(&repository, "p1", &ids[1], PipelineDirection::Down).expect("move")
        );
        assert_eq!(order(&repository), vec!["a", "c", "b"]);
    }

    /// `update.ts:17,20`: an out-of-range move is a no-op that reports `false`.
    #[test]
    fn moves_past_the_edges_are_rejected() {
        let repository = SqliteModelHubRepository::in_memory().expect("in-memory database");
        let ids = seed(&repository, &[("a", 1), ("b", 2)]);
        assert!(
            !move_pipeline_model(&repository, "p1", &ids[0], PipelineDirection::Up).expect("move")
        );
        assert!(
            !move_pipeline_model(&repository, "p1", &ids[1], PipelineDirection::Down)
                .expect("move")
        );
        // Unknown model id.
        assert!(
            !move_pipeline_model(&repository, "p1", "missing", PipelineDirection::Up)
                .expect("move")
        );
        assert_eq!(order(&repository), vec!["a", "b"]);
    }

    /// `update.ts:34`: `replacePipeline` delegates to the repository.
    #[test]
    fn replace_pipeline_replaces_the_profile() {
        let repository = SqliteModelHubRepository::in_memory().expect("in-memory database");
        seed(&repository, &[("a", 1), ("b", 2)]);

        let saved = replace_pipeline(
            &repository,
            "p1",
            &[CreatePipelineModelInput {
                profile_id: "p1".to_string(),
                account_id: "acc".to_string(),
                provider_id: "anthropic".to_string(),
                model_name: "claude".to_string(),
                reasoning_effort: None,
                priority: 1,
            }],
        )
        .expect("replace");

        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].model_name, "claude");
        assert_eq!(order(&repository), vec!["claude"]);
    }
}
