//! Port of `src/server/world-model/consolidation/service.ts:1-124` — Phase 12,
//! the derived long-term summaries.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `service.ts:25-30` (`ConsolidationInput`) | [`ConsolidationInput`] |
//! | `service.ts:32-36` (`ConsolidationResult`) | [`ConsolidationResult`] |
//! | `service.ts:38-123` (`consolidateMemory`) | [`consolidate_memory`] |
//! | `service.ts:79-84` (persona lookup) | [`SQL_FIND_PERSONA_ENTITY`] |
//! | `service.ts:87-95` (persona insert) | [`SQL_INSERT_PERSONA_ENTITY`] |
//! | `service.ts:53-123` (`withWorldModelTransaction`) | [`run_scoped`] with the tenant triple |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `service.ts:44` destructures
//!    `input.scope`; the port keeps that field and derives the RLS triple from
//!    it, because [`WorldModelScope`](crate::world_model::scope::WorldModelScope)
//!    cannot be read from an `AsyncLocalStorage` in Rust. The SQL, the statement
//!    order and the `BEGIN` → `world_model_set_scope` → `COMMIT` contract are
//!    unchanged.
//! 2. **The wall clock is passed in.** `service.ts:62` writes
//!    `new Date().toISOString()` and `insertAssertion` stamps its own clock
//!    (`service.ts:113`). The port takes one `now` for the whole operation
//!    ([`now_iso`] when the caller passes `None`), so observation and derived
//!    assertion share the instant and a test is deterministic.
//! 3. **The transaction body runs on the transaction's session.** The TypeScript
//!    hands `client` to `insertObservationWithResult` and `insertAssertion`
//!    (`service.ts:71`, `:103-116`); the port wraps the [`PgSession`] in
//!    [`SessionExecutor`] and passes `None` as the ambient scope, so those calls
//!    issue no second `BEGIN` and no second scope call.
//! 4. **The config is a parameter.** `service.ts:39` reads
//!    `getWorldModelConfig()`; the port takes `&WorldModelConfig` so a test does
//!    not depend on the process environment.
//! 5. **The policy throw becomes the error value.** `service.ts:50` throws
//!    `Error`; the port answers `Err(PgError)` with the same literal text
//!    (`[world-model:consolidation] …`, joined with `'; '`).

use std::sync::Arc;

use serde_json::{json, Value};

use crate::world_model::config::WorldModelConfig;
use crate::world_model::consolidation::policy::{
    normalized_source_observation_ids, validate_consolidation_policy, ConsolidationPolicyInput,
    CONSOLIDATION_POLICY_VERSION,
};
use crate::world_model::db::{
    run_scoped, BoxFuture, PgError, PgExecutor, PgQueryResult, PgSession, PgStatement, PgValue,
};
use crate::world_model::repositories::assertion_repository::{
    insert_assertion, now_iso, WorldModelAssertionInput,
};
use crate::world_model::repositories::normalized_scope;
use crate::world_model::repositories::observation_repository::insert_observation_with_result;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::{Modality, ObservationInput, ObservationSourceType};

/// `ConsolidationInput` from `service.ts:25-30`.
#[derive(Debug, Clone, PartialEq)]
pub struct ConsolidationInput {
    pub scope: WorldModelScope,
    pub summary: String,
    pub source_observation_ids: Vec<String>,
    pub predicate: Option<String>,
}

/// `ConsolidationResult` from `service.ts:32-36`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsolidationResult {
    pub assertion_id: String,
    pub observation_id: String,
    pub created: bool,
}

/// `service.ts:79-84`.
pub const SQL_FIND_PERSONA_ENTITY: &str = "SELECT id FROM world_model_entities\n       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n         AND canonical_name = 'Persona' LIMIT 1";

/// `service.ts:87-95`.
pub const SQL_INSERT_PERSONA_ENTITY: &str = "INSERT INTO world_model_entities\n          (user_id, persona_id, workspace_id, canonical_name, category, owner)\n         VALUES ($1,$2,$3,'Persona','person','persona')\n         ON CONFLICT (user_id, persona_id, workspace_id, canonical_name, owner) DO UPDATE\n           SET canonical_name = EXCLUDED.canonical_name\n         RETURNING id";

/// `service.ts:99`.
pub const SUBJECT_ENTITY_MESSAGE: &str =
    "[world-model:consolidation] could not resolve subject entity";

/// `consolidateMemory(input)` — `service.ts:38-123`.
///
/// The derived observation carries `sourceType: 'automation'` and the derived
/// assertion `modality: 'inferred'` with `confidence: 0.6`, so a consolidation
/// never overwrites an event or a confirmed fact (`service.ts:20-23`).
pub async fn consolidate_memory(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    input: &ConsolidationInput,
    now: Option<&str>,
) -> Result<ConsolidationResult, PgError> {
    if !config.enabled && !config.e2e_enabled {
        return Ok(ConsolidationResult {
            assertion_id: String::new(),
            observation_id: String::new(),
            created: false,
        });
    }

    let scope = &input.scope;
    let source_observation_ids = normalized_source_observation_ids(&input.source_observation_ids);
    let predicate = input
        .predicate
        .clone()
        .unwrap_or_else(|| "consolidated_summary".to_string());

    let policy_errors = validate_consolidation_policy(&ConsolidationPolicyInput {
        summary: input.summary.clone(),
        source_observation_ids: source_observation_ids.clone(),
    });
    if !policy_errors.is_empty() {
        return Err(PgError::new(format!(
            "[world-model:consolidation] {}",
            policy_errors.join("; ")
        )));
    }

    let workspace_id = scope.workspace_id.clone().unwrap_or_default();
    let observation = ObservationInput {
        user_id: scope.user_id.clone(),
        persona_id: scope.persona_id.clone(),
        workspace_id: Some(workspace_id.clone()),
        source_type: ObservationSourceType::Automation,
        source_id: format!(
            "consolidation:{}:{}:{}:{}",
            scope.user_id,
            scope.persona_id,
            workspace_id,
            source_observation_ids.join(",")
        ),
        occurred_at: now.map(str::to_string).unwrap_or_else(now_iso),
        payload: consolidation_payload(&input.summary, &source_observation_ids),
        source_authority: Some("persona".to_string()),
    };

    let triple = normalized_scope(scope);
    let summary = input.summary.clone();
    let stamp = now.map(str::to_string);
    run_scoped(
        executor,
        Some(&triple),
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(Arc::clone(&session));
                consolidate_in_transaction(
                    &transaction_executor,
                    &session,
                    &observation,
                    &summary,
                    &predicate,
                    stamp.as_deref(),
                )
                .await
            })
        }),
    )
    .await
}

/// The `try` block of `service.ts:54-122`.
async fn consolidate_in_transaction(
    transaction_executor: &dyn PgExecutor,
    session: &Arc<dyn PgSession>,
    observation: &ObservationInput,
    summary: &str,
    predicate: &str,
    now: Option<&str>,
) -> Result<ConsolidationResult, PgError> {
    let inserted =
        insert_observation_with_result::<PgError>(transaction_executor, None, observation).await?;

    if !inserted.created {
        return Ok(ConsolidationResult {
            assertion_id: String::new(),
            observation_id: inserted.observation.id,
            created: false,
        });
    }

    let scope_params = vec![
        PgValue::text(observation.user_id.as_str()),
        PgValue::text(observation.persona_id.as_str()),
        PgValue::text(observation.workspace_id.clone().unwrap_or_default()),
    ];

    let found = session
        .query(PgStatement::with_params(
            SQL_FIND_PERSONA_ENTITY,
            scope_params.clone(),
        ))
        .await?;
    let mut subject_id = found
        .first()
        .map(|row| crate::world_model::repositories::row_text(row, "id"))
        .unwrap_or_default();
    if subject_id.is_empty() {
        let entity = session
            .query(PgStatement::with_params(
                SQL_INSERT_PERSONA_ENTITY,
                scope_params,
            ))
            .await?;
        subject_id = entity
            .first()
            .map(|row| crate::world_model::repositories::row_text(row, "id"))
            .unwrap_or_default();
    }
    if subject_id.is_empty() {
        return Err(PgError::new(SUBJECT_ENTITY_MESSAGE));
    }

    let assertion = insert_assertion::<PgError>(
        transaction_executor,
        None,
        &WorldModelAssertionInput {
            user_id: observation.user_id.clone(),
            persona_id: observation.persona_id.clone(),
            workspace_id: observation.workspace_id.clone().unwrap_or_default(),
            subject_id,
            predicate: predicate.to_string(),
            object_value: Some(summary.to_string()),
            object_id: None,
            polarity: None,
            modality: Some(Modality::Inferred),
            confidence: Some(0.6),
            source_observation_id: Some(inserted.observation.id.clone()),
        },
        now,
    )
    .await?;

    Ok(ConsolidationResult {
        assertion_id: assertion.id,
        observation_id: inserted.observation.id,
        created: true,
    })
}

/// The `payload` object literal of `service.ts:63-68`.
fn consolidation_payload(
    summary: &str,
    source_observation_ids: &[String],
) -> serde_json::Map<String, Value> {
    let mut payload = serde_json::Map::new();
    payload.insert("summary".to_string(), Value::String(summary.to_string()));
    payload.insert(
        "sourceObservationIds".to_string(),
        json!(source_observation_ids),
    );
    payload.insert(
        "consolidationVersion".to_string(),
        Value::String(CONSOLIDATION_POLICY_VERSION.to_string()),
    );
    payload.insert(
        "sourceCount".to_string(),
        json!(source_observation_ids.len()),
    );
    payload
}

/// The `client` of the source transaction (`service.ts:53`) as an executor.
///
/// `connect()` fails on purpose: a nested [`run_scoped`] inside this body would
/// open a second connection and lose the tenant triple.
struct SessionExecutor(Arc<dyn PgSession>);

impl PgExecutor for SessionExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>> {
        Box::pin(async { Err(PgError::new("[world-model] nested transaction")) })
    }

    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        self.0.query(statement)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{
        drive_sync, PgQueryResult, PgRow, SQL_BEGIN, SQL_COMMIT, SQL_ROLLBACK, SQL_SET_SCOPE,
    };
    use crate::world_model::mode::WorldModelMode;
    use crate::world_model::repositories::observation_repository::{
        SQL_EXISTING_OBSERVATION, SQL_INSERT_OBSERVATION,
    };

    fn row(value: Value) -> PgRow {
        value.as_object().expect("row").clone()
    }

    fn observation_row(id: &str) -> PgQueryResult {
        PgQueryResult::from_rows(vec![row(json!({
            "id": id,
            "user_id": "u1", "persona_id": "p1", "workspace_id": "",
            "source_type": "automation",
            "source_id": "consolidation:u1:p1::o1,o2",
            "occurred_at": "2026-10-10T10:00:00.000Z",
            "received_at": "2026-10-10T10:00:00.000Z",
            "payload": { "summary": "s" }, "source_authority": "persona"
        }))])
    }

    fn assertion_row() -> PgQueryResult {
        PgQueryResult::from_rows(vec![row(json!({
            "id": "a1", "user_id": "u1", "persona_id": "p1", "workspace_id": "",
            "subject_id": "e1", "predicate": "consolidated_summary", "object_value": "s",
            "modality": "inferred", "status": "active", "confidence": 0.6,
            "known_from": "2026-10-10T10:00:00.000Z", "known_to": null,
            "source_observation_id": "o1", "supersedes_assertion_id": null
        }))])
    }

    fn enabled() -> WorldModelConfig {
        WorldModelConfig {
            enabled: true,
            mode: WorldModelMode::Canonical,
            ..Default::default()
        }
    }

    fn input() -> ConsolidationInput {
        ConsolidationInput {
            scope: WorldModelScope::new("u1", "p1", None),
            summary: "s".to_string(),
            source_observation_ids: vec!["o2".to_string(), "o1".to_string()],
            predicate: None,
        }
    }

    fn sql(executor: &RecordingExecutor) -> Vec<String> {
        executor
            .calls()
            .iter()
            .map(|call| call.sql().to_string())
            .collect()
    }

    #[test]
    fn a_disabled_world_model_answers_the_empty_result_without_a_statement() {
        let executor = RecordingExecutor::new(vec![]);
        let result = drive_sync(consolidate_memory(
            &executor,
            &WorldModelConfig::default(),
            &input(),
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect("result");
        assert_eq!(
            result,
            ConsolidationResult {
                assertion_id: String::new(),
                observation_id: String::new(),
                created: false
            }
        );
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn a_policy_violation_is_reported_before_the_first_statement() {
        let executor = RecordingExecutor::new(vec![]);
        let bad = ConsolidationInput {
            summary: "   ".to_string(),
            source_observation_ids: vec![],
            ..input()
        };
        let error = drive_sync(consolidate_memory(
            &executor,
            &enabled(),
            &bad,
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect_err("policy error");
        assert_eq!(
            error.message,
            "[world-model:consolidation] summary must not be empty; at least one source observation is required"
        );
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn a_new_observation_resolves_the_persona_and_writes_an_inferred_assertion() {
        let executor = RecordingExecutor::new(vec![
            Ok(observation_row("o1")),
            Ok(PgQueryResult::from_rows(vec![row(json!({ "id": "e1" }))])),
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::empty()),
            Ok(assertion_row()),
        ]);
        let result = drive_sync(consolidate_memory(
            &executor,
            &enabled(),
            &input(),
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect("result");
        assert_eq!(
            result,
            ConsolidationResult {
                assertion_id: "a1".to_string(),
                observation_id: "o1".to_string(),
                created: true
            }
        );

        let calls = executor.calls();
        assert_eq!(calls[0].sql(), SQL_BEGIN);
        assert_eq!(calls[1].sql(), SQL_SET_SCOPE);
        let Recorded::Statement(insert_observation) = &calls[2] else {
            panic!("expected the observation insert");
        };
        assert_eq!(insert_observation.sql, SQL_INSERT_OBSERVATION);
        // The source ids are normalized (sorted, de-duplicated) first (`service.ts:45`).
        assert_eq!(insert_observation.params[3], PgValue::text("automation"));
        assert_eq!(
            insert_observation.params[4],
            PgValue::text("consolidation:u1:p1::o1,o2")
        );
        assert_eq!(
            insert_observation.params[5],
            PgValue::text("2026-10-10T10:00:00.000Z")
        );
        assert_eq!(insert_observation.params[7], PgValue::text("persona"));

        let Recorded::Statement(find_entity) = &calls[3] else {
            panic!("expected the persona lookup");
        };
        assert_eq!(find_entity.sql, SQL_FIND_PERSONA_ENTITY);
        assert_eq!(
            find_entity.params,
            vec![PgValue::text("u1"), PgValue::text("p1"), PgValue::text("")]
        );

        // calls[4] is the assertion replay read, calls[5] the supersede.
        let Recorded::Statement(insert_assertion) = &calls[6] else {
            panic!("expected the assertion insert");
        };
        assert_eq!(insert_assertion.params[5], PgValue::Null, "objectId");
        assert_eq!(insert_assertion.params[6], PgValue::text("s"));
        assert_eq!(insert_assertion.params[8], PgValue::text("inferred"));
        assert_eq!(insert_assertion.params[9], PgValue::float(0.6));
        assert_eq!(insert_assertion.params[10], PgValue::text("o1"));
        // `run_scoped` releases the connection after the `COMMIT`.
        assert_eq!(
            calls[calls.len() - 2],
            Recorded::Statement(PgStatement::new(SQL_COMMIT))
        );
        assert_eq!(calls.last(), Some(&Recorded::Release));
    }

    #[test]
    fn an_existing_observation_short_circuits_without_an_entity_write() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::empty()), Ok(observation_row("o9"))]);
        let result = drive_sync(consolidate_memory(
            &executor,
            &enabled(),
            &input(),
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect("result");
        assert_eq!(
            result,
            ConsolidationResult {
                assertion_id: String::new(),
                observation_id: "o9".to_string(),
                created: false
            }
        );
        assert_eq!(
            sql(&executor),
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_INSERT_OBSERVATION.to_string(),
                SQL_EXISTING_OBSERVATION.to_string(),
                SQL_COMMIT.to_string(),
                "<release>".to_string()
            ]
        );
    }

    #[test]
    fn an_unresolvable_persona_entity_rolls_back_with_the_source_message() {
        let executor = RecordingExecutor::new(vec![
            Ok(observation_row("o1")),
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::empty()),
        ]);
        let error = drive_sync(consolidate_memory(
            &executor,
            &enabled(),
            &input(),
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect_err("missing subject");
        assert_eq!(error.message, SUBJECT_ENTITY_MESSAGE);
        assert_eq!(
            sql(&executor),
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_INSERT_OBSERVATION.to_string(),
                SQL_FIND_PERSONA_ENTITY.to_string(),
                SQL_INSERT_PERSONA_ENTITY.to_string(),
                SQL_ROLLBACK.to_string(),
                "<release>".to_string()
            ]
        );
        assert_eq!(executor.calls().last(), Some(&Recorded::Release));
    }
}
