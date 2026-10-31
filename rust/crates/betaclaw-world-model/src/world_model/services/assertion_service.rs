//! Port of `src/server/world-model/services/assertionService.ts:1-124`.

use crate::world_model::db::{PgError, PgExecutor};
use crate::world_model::repositories::assertion_repository::{
    expire_assertion, insert_assertion, list_active_assertions, retract_assertion,
    WorldModelAssertionInput, WorldModelAssertionRecord,
};
use crate::world_model::scope::WorldModelScope;

pub use crate::world_model::types::Modality;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceAuthority {
    User,
    Persona,
    Inference,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssertionServiceInput {
    pub scope: WorldModelScope,
    pub source_authority: SourceAuthority,
    pub subject_id: String,
    pub predicate: String,
    pub object_value: Option<String>,
    pub object_id: Option<String>,
    pub polarity: Option<i64>,
    pub confidence: Option<f64>,
    pub source_observation_id: Option<String>,
}

pub async fn assert_fact(
    executor: &dyn PgExecutor,
    input: &AssertionServiceInput,
) -> Result<WorldModelAssertionRecord, PgError> {
    insert_assertion::<PgError>(
        executor,
        Some(&input.scope),
        &assertion_input(
            input,
            Some(match input.source_authority {
                SourceAuthority::User => Modality::Confirmed,
                SourceAuthority::Persona | SourceAuthority::Inference => Modality::Observed,
            }),
        ),
        None,
    )
    .await
}

pub async fn supersede_fact(
    executor: &dyn PgExecutor,
    input: &AssertionServiceInput,
) -> Result<WorldModelAssertionRecord, PgError> {
    assert_fact(executor, input).await
}

pub async fn deny_fact(
    executor: &dyn PgExecutor,
    input: &AssertionServiceInput,
    _reason: Option<&str>,
) -> Result<WorldModelAssertionRecord, PgError> {
    retract_by_identity_if_active(executor, input, false).await?;
    insert_assertion::<PgError>(
        executor,
        Some(&input.scope),
        &WorldModelAssertionInput {
            user_id: input.scope.user_id.clone(),
            persona_id: input.scope.persona_id.clone(),
            workspace_id: input.scope.workspace_id.clone().unwrap_or_default(),
            subject_id: input.subject_id.clone(),
            predicate: input.predicate.clone(),
            object_value: input.object_value.clone(),
            object_id: None,
            polarity: None,
            modality: Some(Modality::Denied),
            confidence: Some(0.99),
            source_observation_id: None,
        },
        None,
    )
    .await
}

pub async fn confirm_fact(
    executor: &dyn PgExecutor,
    input: &AssertionServiceInput,
) -> Result<WorldModelAssertionRecord, PgError> {
    let confidence = match input.confidence.unwrap_or(0.8) {
        value if value.is_nan() => f64::NAN,
        value => value.max(0.95),
    };
    insert_assertion::<PgError>(
        executor,
        Some(&input.scope),
        &WorldModelAssertionInput {
            user_id: input.scope.user_id.clone(),
            persona_id: input.scope.persona_id.clone(),
            workspace_id: input.scope.workspace_id.clone().unwrap_or_default(),
            subject_id: input.subject_id.clone(),
            predicate: input.predicate.clone(),
            object_value: input.object_value.clone(),
            object_id: None,
            polarity: None,
            modality: Some(Modality::Confirmed),
            confidence: Some(confidence),
            source_observation_id: None,
        },
        None,
    )
    .await
}

pub async fn retract_fact(
    executor: &dyn PgExecutor,
    input: &AssertionServiceInput,
) -> Result<(), PgError> {
    retract_by_identity_if_active(executor, input, false).await
}

pub async fn expire_fact(
    executor: &dyn PgExecutor,
    input: &AssertionServiceInput,
) -> Result<(), PgError> {
    retract_by_identity_if_active(executor, input, true).await
}

async fn retract_by_identity_if_active(
    executor: &dyn PgExecutor,
    input: &AssertionServiceInput,
    expire: bool,
) -> Result<(), PgError> {
    let active = list_active_assertions::<PgError>(
        executor,
        Some(&input.scope),
        &input.scope.user_id,
        &input.scope.persona_id,
        input.scope.workspace_id.as_deref(),
    )
    .await?;
    if let Some(match_) = active.iter().find(|assertion| {
        assertion.predicate == input.predicate
            && input
                .object_value
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && assertion.object_value == input.object_value
    }) {
        if expire {
            expire_assertion::<PgError>(executor, Some(&input.scope), &match_.id).await?;
        } else {
            retract_assertion::<PgError>(executor, Some(&input.scope), &match_.id).await?;
        }
    }
    Ok(())
}

fn assertion_input(
    input: &AssertionServiceInput,
    modality: Option<Modality>,
) -> WorldModelAssertionInput {
    WorldModelAssertionInput {
        user_id: input.scope.user_id.clone(),
        persona_id: input.scope.persona_id.clone(),
        workspace_id: input.scope.workspace_id.clone().unwrap_or_default(),
        subject_id: input.subject_id.clone(),
        predicate: input.predicate.clone(),
        object_value: input.object_value.clone(),
        object_id: input.object_id.clone(),
        polarity: input.polarity,
        modality,
        confidence: input.confidence,
        source_observation_id: input.source_observation_id.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assertion_input_uses_scope_and_user_authority_selects_confirmed_modality() {
        let input = AssertionServiceInput {
            scope: WorldModelScope::new("u", "p", None),
            source_authority: SourceAuthority::User,
            subject_id: "entity".into(),
            predicate: "likes".into(),
            object_value: Some("coffee".into()),
            object_id: None,
            polarity: Some(1),
            confidence: None,
            source_observation_id: None,
        };
        let assertion = assertion_input(&input, Some(Modality::Confirmed));
        assert_eq!(assertion.user_id, "u");
        assert_eq!(assertion.workspace_id, "");
        assert_eq!(assertion.modality, Some(Modality::Confirmed));
    }
}
