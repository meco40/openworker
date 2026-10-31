//! Port of `src/server/world-model/repositories/observationRepository.ts`
//! (107 lines) — the idempotent observation write of the canonical store.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `observationRepository.ts:4-15` (`ObservationRow`) | the column names of the statements and [`to_observation`] |
//! | `observationRepository.ts:17-21` (`ObservationScope`) | [`ObservationScope`] |
//! | `observationRepository.ts:23-36` (`toObservation`) | [`to_observation`] |
//! | `observationRepository.ts:38-76` (`insertObservationWithResult`) | [`insert_observation_with_result`] |
//! | `observationRepository.ts:78-83` (`insertObservation`) | [`insert_observation`] |
//! | `observationRepository.ts:85-107` (`getObservationById`) | [`get_observation_by_id`] |
//! | `observationRepository.ts:43-48` (insert) | [`SQL_INSERT_OBSERVATION`] |
//! | `observationRepository.ts:65-69` (conflict read) | [`SQL_EXISTING_OBSERVATION`] |
//! | `observationRepository.ts:101-103` (by id) | [`SQL_OBSERVATION_BY_ID`] |
//!
//! The three statements repeat the same column list; the port repeats it the
//! same way, so every constant can be diffed against its template literal line
//! by line.
//!
//! # Scope
//!
//! `scope` of the source is *not* the RLS scope: it is the additional `WHERE`
//! clause of `getObservationById` (`:92-99`). The RLS scope is the ambient
//! `getWorldModelScope()`, which Rust cannot read, so
//! [`get_observation_by_id`] takes both — `filter` for the `WHERE` clause and
//! `scope` for the transaction. Every `db.query` of the source is
//! `getWorldModelDb().query` (`db.ts:107-110`), hence the
//! `Option<&WorldModelScope>` of [`crate::world_model::repositories`].
//!
//! # Deviations
//!
//! 1. **The row's `source_type` literal is parsed back into the union.** The
//!    source trusts the column (its `ObservationRow` types it as
//!    `Observation['sourceType']`); the port maps an unknown literal to
//!    [`ObservationSourceType::Manual`], because [`ObservationSourceType`] has
//!    no catch-all member. A column outside the union is a data error the source
//!    cannot produce, and the fallback keeps it observable instead of failing a
//!    read of every other column.

use serde_json::Value;

use crate::world_model::db::{PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::repositories::{ambient_query, row_object, row_text};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::{Observation, ObservationInput, ObservationSourceType};

/// `ObservationScope` from `observationRepository.ts:17-21`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationScope {
    pub user_id: String,
    pub persona_id: String,
    /// `workspaceId?: string` — `undefined` means "do not filter on it".
    pub workspace_id: Option<String>,
}

/// `{ observation, created }` from `observationRepository.ts:41`.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservationInsertResult {
    pub observation: Observation,
    pub created: bool,
}

/// `observationRepository.ts:43-48`.
pub const SQL_INSERT_OBSERVATION: &str = "INSERT INTO world_model_observations\n  (user_id, persona_id, workspace_id, source_type, source_id, occurred_at, payload, source_authority)\nVALUES ($1,$2,$3,$4,$5,$6,$7,$8)\nON CONFLICT (user_id, persona_id, workspace_id, source_type, source_id) DO NOTHING\nRETURNING id, user_id, persona_id, workspace_id, source_type, source_id,\n          occurred_at, received_at, payload, source_authority";

/// `observationRepository.ts:65-69`.
pub const SQL_EXISTING_OBSERVATION: &str = "SELECT id, user_id, persona_id, workspace_id, source_type, source_id,\n          occurred_at, received_at, payload, source_authority\nFROM world_model_observations\nWHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n  AND source_type = $4 AND source_id = $5";

/// `observationRepository.ts:73`.
pub const OBSERVATION_CONFLICT_MESSAGE: &str =
    "[world-model] observation conflict occurred but existing row was not found";

/// The `SELECT` prefix of `observationRepository.ts:101-103`; the `WHERE` clause
/// is appended because the source joins the conditions at run time.
pub const SQL_OBSERVATION_BY_ID: &str = "SELECT id, user_id, persona_id, workspace_id, source_type, source_id,\n          occurred_at, received_at, payload, source_authority\nFROM world_model_observations WHERE ";

/// `toObservation(row)` — `observationRepository.ts:23-36`.
///
/// `payload: (row.payload ?? {})` is [`row_object`] and
/// `sourceAuthority: row.source_authority` becomes `Some(…)`, because the
/// record's property is present while the input's is optional.
fn to_observation(row: &PgRow) -> Observation {
    Observation {
        input: ObservationInput {
            user_id: row_text(row, "user_id"),
            persona_id: row_text(row, "persona_id"),
            workspace_id: Some(row_text(row, "workspace_id")),
            source_type: source_type_from_column(&row_text(row, "source_type")),
            source_id: row_text(row, "source_id"),
            occurred_at: row_text(row, "occurred_at"),
            payload: row_object(row, "payload"),
            source_authority: Some(row_text(row, "source_authority")),
        },
        id: row_text(row, "id"),
        received_at: row_text(row, "received_at"),
    }
}

/// The union literal of the `source_type` column (deviation 1).
fn source_type_from_column(text: &str) -> ObservationSourceType {
    serde_json::from_value::<ObservationSourceType>(Value::String(text.to_string()))
        .unwrap_or(ObservationSourceType::Manual)
}

/// `insertObservationWithResult(input, db)` — `observationRepository.ts:38-76`.
///
/// The insert is idempotent through `ON CONFLICT … DO NOTHING`; a statement
/// without a `RETURNING` row means the row already existed, which the source
/// then reads back (`:64-71`).
pub async fn insert_observation_with_result<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &ObservationInput,
) -> Result<ObservationInsertResult, E> {
    let workspace_id = input.workspace_id.clone().unwrap_or_default();
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_INSERT_OBSERVATION,
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(workspace_id.as_str()),
                PgValue::text(source_type_literal(input.source_type)),
                PgValue::text(input.source_id.as_str()),
                PgValue::text(input.occurred_at.as_str()),
                PgValue::text(Value::Object(input.payload.clone()).to_string()),
                PgValue::text(
                    input
                        .source_authority
                        .clone()
                        .unwrap_or_else(|| "system".to_string()),
                ),
            ],
        ),
    )
    .await?;
    if let Some(row) = result.first() {
        return Ok(ObservationInsertResult {
            observation: to_observation(row),
            created: true,
        });
    }

    let existing = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_EXISTING_OBSERVATION,
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(workspace_id.as_str()),
                PgValue::text(source_type_literal(input.source_type)),
                PgValue::text(input.source_id.as_str()),
            ],
        ),
    )
    .await?;
    match existing.first() {
        Some(row) => Ok(ObservationInsertResult {
            observation: to_observation(row),
            created: false,
        }),
        None => Err(E::from(PgError::new(OBSERVATION_CONFLICT_MESSAGE))),
    }
}

/// `insertObservation(input, db)` — `observationRepository.ts:78-83`.
pub async fn insert_observation<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &ObservationInput,
) -> Result<Observation, E> {
    Ok(insert_observation_with_result(executor, scope, input)
        .await?
        .observation)
}

/// `getObservationById(id, scope?, db)` — `observationRepository.ts:85-107`.
///
/// `filter` is the source's `scope?: ObservationScope`, `scope` is the ambient
/// RLS scope of `db.ts:107-110` (see the module header).
pub async fn get_observation_by_id<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
    filter: Option<&ObservationScope>,
) -> Result<Option<Observation>, E> {
    let conditions = observation_conditions(id, filter);
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            format!("{SQL_OBSERVATION_BY_ID}{}", conditions.clause),
            conditions.params,
        ),
    )
    .await?;
    Ok(result.first().map(to_observation))
}

/// The `conditions`/`values` pair of `observationRepository.ts:90-99`.
struct Conditions {
    clause: String,
    params: Vec<PgValue>,
}

/// `conditions`/`values` of `getObservationById` — `observationRepository.ts:90-99`.
///
/// The placeholders are computed from the running length of the value list
/// (`values.length - 1`/`values.length`), exactly like the source, so the
/// `workspace_id` condition is only appended when the property is not
/// `undefined` — an empty string still filters.
fn observation_conditions(id: &str, filter: Option<&ObservationScope>) -> Conditions {
    let mut conditions = vec!["id = $1".to_string()];
    let mut params = vec![PgValue::text(id)];
    if let Some(filter) = filter {
        params.push(PgValue::text(filter.user_id.as_str()));
        params.push(PgValue::text(filter.persona_id.as_str()));
        conditions.push(format!("user_id = ${}", params.len() - 1));
        conditions.push(format!("persona_id = ${}", params.len()));
        if let Some(workspace_id) = filter.workspace_id.as_deref() {
            params.push(PgValue::text(workspace_id));
            conditions.push(format!("workspace_id = ${}", params.len()));
        }
    }
    Conditions {
        clause: conditions.join(" AND "),
        params,
    }
}

/// The literal of the `sourceType` union (`types.ts:53-62`).
fn source_type_literal(source_type: ObservationSourceType) -> &'static str {
    match source_type {
        ObservationSourceType::ChatMessage => "chat_message",
        ObservationSourceType::Email => "email",
        ObservationSourceType::CalendarEvent => "calendar_event",
        ObservationSourceType::LocationSignal => "location_signal",
        ObservationSourceType::ToolExecution => "tool_execution",
        ObservationSourceType::OutboundMessage => "outbound_message",
        ObservationSourceType::UserConfirmation => "user_confirmation",
        ObservationSourceType::Automation => "automation",
        ObservationSourceType::Manual => "manual",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use serde_json::{json, Map};

    fn ambient() -> WorldModelScope {
        WorldModelScope::new("u1", "p1", Some("w1".to_string()))
    }

    fn input() -> ObservationInput {
        ObservationInput {
            user_id: "u1".to_string(),
            persona_id: "p1".to_string(),
            workspace_id: None,
            source_type: ObservationSourceType::ChatMessage,
            source_id: "m1".to_string(),
            occurred_at: "2026-10-10T10:00:00.000Z".to_string(),
            payload: Map::new(),
            source_authority: None,
        }
    }

    fn observation_row() -> PgRow {
        json!({
            "id": "o1",
            "user_id": "u1",
            "persona_id": "p1",
            "workspace_id": "",
            "source_type": "chat_message",
            "source_id": "m1",
            "occurred_at": "2026-10-10T10:00:00.000Z",
            "received_at": "2026-10-10T10:00:01.000Z",
            "payload": { "text": "hi" },
            "source_authority": "system",
        })
        .as_object()
        .expect("object")
        .clone()
    }

    fn sqls(executor: &RecordingExecutor) -> Vec<String> {
        executor
            .calls()
            .iter()
            .filter(|call| !matches!(call, Recorded::Release))
            .map(|call| call.sql().to_string())
            .collect()
    }

    #[test]
    fn an_insert_returns_the_created_row_between_begin_and_commit() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![observation_row()]))]);
        let inserted = drive_sync(insert_observation_with_result::<PgError>(
            &executor,
            Some(&ambient()),
            &input(),
        ))
        .expect("bridge")
        .expect("insert");
        assert!(inserted.created);
        assert_eq!(inserted.observation.id, "o1");
        assert_eq!(inserted.observation.received_at, "2026-10-10T10:00:01.000Z");
        assert_eq!(inserted.observation.input.payload["text"], json!("hi"));
        assert_eq!(
            inserted.observation.input.source_authority.as_deref(),
            Some("system")
        );

        assert_eq!(
            sqls(&executor),
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_INSERT_OBSERVATION.to_string(),
                SQL_COMMIT.to_string(),
            ]
        );
        let calls = executor.calls();
        assert_eq!(calls.last(), Some(&Recorded::Release));
        match &calls[1] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text("w1"),
                ],
                "`world_model_set_scope($1, $2, $3)`"
            ),
            other => panic!("expected the scope statement, got {other:?}"),
        }
        match &calls[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text(""),
                    PgValue::text("chat_message"),
                    PgValue::text("m1"),
                    PgValue::text("2026-10-10T10:00:00.000Z"),
                    PgValue::text("{}"),
                    PgValue::text("system"),
                ],
                "`workspaceId ?? ''`, `JSON.stringify(payload ?? {{}})`, \
                 `sourceAuthority ?? 'system'`"
            ),
            other => panic!("expected the insert, got {other:?}"),
        }
    }

    #[test]
    fn a_conflict_reads_the_existing_row() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![observation_row()])),
        ]);
        let inserted = drive_sync(insert_observation_with_result::<PgError>(
            &executor,
            Some(&ambient()),
            &input(),
        ))
        .expect("bridge")
        .expect("insert");
        assert!(!inserted.created);
        assert_eq!(inserted.observation.id, "o1");
        assert_eq!(
            sqls(&executor),
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_INSERT_OBSERVATION.to_string(),
                SQL_COMMIT.to_string(),
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_EXISTING_OBSERVATION.to_string(),
                SQL_COMMIT.to_string(),
            ],
            "each `db.query` of the source is its own scoped transaction"
        );
        match &executor.calls()[7] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text(""),
                    PgValue::text("chat_message"),
                    PgValue::text("m1"),
                ]
            ),
            other => panic!("expected the conflict read, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_conflict_reports_the_source_message() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::empty()), Ok(PgQueryResult::empty())]);
        let error = drive_sync(insert_observation_with_result::<PgError>(
            &executor,
            Some(&ambient()),
            &input(),
        ))
        .expect("bridge")
        .expect_err("no row");
        assert_eq!(
            error.message,
            "[world-model] observation conflict occurred but existing row was not found"
        );
    }

    #[test]
    fn an_unscoped_statement_skips_the_transaction() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![observation_row()]))]);
        drive_sync(insert_observation::<PgError>(&executor, None, &input()))
            .expect("bridge")
            .expect("insert");
        assert_eq!(
            sqls(&executor),
            vec![SQL_INSERT_OBSERVATION.to_string()],
            "without an ambient scope the statement is the bare `pool.query`"
        );
        assert_eq!(executor.calls().len(), 1, "no session, no release");
    }

    #[test]
    fn a_missing_row_is_none() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let found = drive_sync(get_observation_by_id::<PgError>(
            &executor, None, "o1", None,
        ))
        .expect("bridge")
        .expect("lookup");
        assert!(found.is_none());
    }

    #[test]
    fn an_unknown_source_type_column_falls_back_to_manual() {
        let mut row = observation_row();
        row.insert("source_type".to_string(), json!("not_a_source_type"));
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![row]))]);
        let inserted = drive_sync(insert_observation::<PgError>(&executor, None, &input()))
            .expect("bridge")
            .expect("insert");
        assert_eq!(
            inserted.input.source_type,
            ObservationSourceType::Manual,
            "deviation 1: the union has no catch-all member"
        );
    }

    #[test]
    fn the_by_id_lookup_appends_the_filter_conditions() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(get_observation_by_id::<PgError>(
            &executor,
            Some(&ambient()),
            "o1",
            None,
        ))
        .expect("bridge")
        .expect("lookup");
        match &executor.calls()[2] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, format!("{SQL_OBSERVATION_BY_ID}id = $1"));
                assert_eq!(statement.params, vec![PgValue::text("o1")]);
            }
            other => panic!("expected the lookup, got {other:?}"),
        }

        let with_persona = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        drive_sync(get_observation_by_id::<PgError>(
            &with_persona,
            Some(&ambient()),
            "o1",
            Some(&ObservationScope {
                user_id: "u1".to_string(),
                persona_id: "p1".to_string(),
                workspace_id: None,
            }),
        ))
        .expect("bridge")
        .expect("lookup");
        match &with_persona.calls()[2] {
            Recorded::Statement(statement) => {
                assert_eq!(
                    statement.sql,
                    format!("{SQL_OBSERVATION_BY_ID}id = $1 AND user_id = $2 AND persona_id = $3")
                );
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::text("o1"),
                        PgValue::text("u1"),
                        PgValue::text("p1"),
                    ]
                );
            }
            other => panic!("expected the lookup, got {other:?}"),
        }

        let with_workspace =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![observation_row()]))]);
        let found = drive_sync(get_observation_by_id::<PgError>(
            &with_workspace,
            Some(&ambient()),
            "o1",
            Some(&ObservationScope {
                user_id: "u1".to_string(),
                persona_id: "p1".to_string(),
                workspace_id: Some(String::new()),
            }),
        ))
        .expect("bridge")
        .expect("lookup");
        assert_eq!(
            found.map(|observation| observation.id),
            Some("o1".to_string())
        );
        match &with_workspace.calls()[2] {
            Recorded::Statement(statement) => {
                assert_eq!(
                    statement.sql,
                    format!(
                        "{SQL_OBSERVATION_BY_ID}id = $1 AND user_id = $2 AND persona_id = $3 \
                         AND workspace_id = $4"
                    ),
                    "an empty workspace still filters, only `undefined` does not"
                );
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::text("o1"),
                        PgValue::text("u1"),
                        PgValue::text("p1"),
                        PgValue::text(""),
                    ]
                );
            }
            other => panic!("expected the lookup, got {other:?}"),
        }
    }
}
