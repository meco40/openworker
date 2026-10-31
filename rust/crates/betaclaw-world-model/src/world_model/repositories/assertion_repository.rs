//! Port of `src/server/world-model/repositories/assertionRepository.ts`
//! (172 lines) — the bitemporal truth store.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `assertionRepository.ts:4-16` (`WorldModelAssertionInput`) | [`WorldModelAssertionInput`] |
//! | `assertionRepository.ts:18-33` (`WorldModelAssertionRecord`) | [`WorldModelAssertionRecord`], [`AssertionStatus`], [`Modality`](crate::world_model::types::Modality) |
//! | `assertionRepository.ts:35-50` (`AssertionRow`) | the column names of the statements |
//! | `assertionRepository.ts:52-69` (`toAssertion`) | [`to_assertion`] |
//! | `assertionRepository.ts:71-73` (`SELECT_COLUMNS`) | [`SELECT_COLUMNS`] |
//! | `assertionRepository.ts:81-135` (`insertAssertion`) | [`insert_assertion`] |
//! | `assertionRepository.ts:137-150` (`listActiveAssertions`) | [`list_active_assertions`] |
//! | `assertionRepository.ts:152-161` (`retractAssertion`) | [`retract_assertion`] |
//! | `assertionRepository.ts:163-172` (`expireAssertion`) | [`expire_assertion`] |
//! | `assertionRepository.ts:87-91` (replay read) | [`replay_sql`] |
//! | `assertionRepository.ts:105-109` (supersede) | [`SQL_SUPERSEDE`] |
//! | `assertionRepository.ts:114-118` (insert) | [`insert_sql`] |
//! | `assertionRepository.ts:144-146` (active list) | [`active_sql`] |
//! | `assertionRepository.ts:157-158` (retract) | [`SQL_RETRACT`] |
//! | `assertionRepository.ts:168-169` (expire) | [`SQL_EXPIRE`] |
//!
//! # `new Date().toISOString()`
//!
//! `insertAssertion` stamps `known_to` of the superseded row with the current
//! instant (`:102`) and binds it as `$4`. Rust has no ambient clock, so
//! [`insert_assertion`] takes it as `now: Option<&str>`: `Some(value)` is the
//! exact `now` of the source, `None` is `new Date().toISOString()`
//! ([`now_iso`]). The statement, the parameter order and the used value are
//! unchanged; only the source of the value is explicit.
//!
//! # Deviations
//!
//! 1. **`status` is parsed back into the union with a fallback.**
//!    `toAssertion` forwards `row.status` (`:62`); a Rust enum needs a member for
//!    an out-of-union literal, and [`AssertionStatus::Active`] is the state an
//!    insert writes.
//! 2. **`polarity` is `1 | 0 | -1` in the source and binds as an integer.** The
//!    column is `INT`-like, and `pg` receives `1` as the integral JavaScript
//!    number the seam maps to [`PgValue::Int64`].
//! 3. **A missing `RETURNING` row is an error instead of a `TypeError`.** The
//!    source reads `res.rows[0]` (`:134`) into `toAssertion`, which would fail on
//!    a missing row; the port answers [`MISSING_ASSERTION_ROW`].

use serde_json::Value;

use crate::world_model::db::{PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::repositories::{ambient_query, row_number, row_optional_text, row_text};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::Modality;

/// The input of `insertAssertion` (`assertionRepository.ts:4-16`).
#[derive(Debug, Clone, PartialEq)]
pub struct WorldModelAssertionInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub subject_id: String,
    pub predicate: String,
    pub object_value: Option<String>,
    pub object_id: Option<String>,
    /// `polarity?: 1 | 0 | -1`.
    pub polarity: Option<i64>,
    pub modality: Option<Modality>,
    pub confidence: Option<f64>,
    pub source_observation_id: Option<String>,
}

/// `WorldModelAssertionRecord` from `assertionRepository.ts:18-33`.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldModelAssertionRecord {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub subject_id: String,
    pub predicate: String,
    pub object_value: Option<String>,
    pub modality: Modality,
    pub status: AssertionStatus,
    pub confidence: f64,
    pub known_from: String,
    pub known_to: Option<String>,
    pub source_observation_id: Option<String>,
    pub supersedes_assertion_id: Option<String>,
}

/// `WorldModelAssertionRecord['status']` from `assertionRepository.ts:27`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssertionStatus {
    Active,
    Superseded,
    Cancelled,
    Retracted,
}

impl AssertionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AssertionStatus::Active => "active",
            AssertionStatus::Superseded => "superseded",
            AssertionStatus::Cancelled => "cancelled",
            AssertionStatus::Retracted => "retracted",
        }
    }
}

/// The `SELECT_COLUMNS` of `assertionRepository.ts:71-73`.
pub const SELECT_COLUMNS: &str = "id, user_id, persona_id, workspace_id, subject_id, predicate,\n  object_value, modality, status, confidence, known_from, known_to,\n  source_observation_id, supersedes_assertion_id";

/// `assertionRepository.ts:87-91` with `${SELECT_COLUMNS}` expanded.
pub fn replay_sql() -> String {
    format!(
        "SELECT {SELECT_COLUMNS} FROM world_model_assertions\nWHERE source_observation_id = $1 AND subject_id = $2 AND predicate = $3\n  AND object_id IS NOT DISTINCT FROM $4::uuid\n  AND object_value IS NOT DISTINCT FROM $5\nLIMIT 1"
    )
}

/// `assertionRepository.ts:105-109`.
pub const SQL_SUPERSEDE: &str = "UPDATE world_model_assertions\nSET known_to = $4, status = 'superseded'\nWHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n  AND subject_id = $5 AND predicate = $6 AND known_to IS NULL\nRETURNING id";

/// `assertionRepository.ts:114-118` with `RETURNING ${SELECT_COLUMNS}` expanded.
pub fn insert_sql() -> String {
    format!(
        "INSERT INTO world_model_assertions\n  (user_id, persona_id, workspace_id, subject_id, predicate, object_id, object_value,\n   polarity, modality, confidence, source_observation_id, supersedes_assertion_id)\nVALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)\nRETURNING {SELECT_COLUMNS}"
    )
}

/// `assertionRepository.ts:144-146` with `${SELECT_COLUMNS}` expanded.
pub fn active_sql() -> String {
    format!(
        "SELECT {SELECT_COLUMNS} FROM world_model_assertions\nWHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3\n  AND status = 'active' AND known_to IS NULL"
    )
}

/// `assertionRepository.ts:157-158`.
pub const SQL_RETRACT: &str = "UPDATE world_model_assertions SET status = 'retracted', known_to = now()\nWHERE id = $1 AND status = 'active'";

/// `assertionRepository.ts:168-169`.
pub const SQL_EXPIRE: &str = "UPDATE world_model_assertions SET status = 'cancelled', known_to = now()\nWHERE id = $1 AND status = 'active'";

/// The port's answer for `res.rows[0]` being absent (`:134`) — deviation 1.
pub const MISSING_ASSERTION_ROW: &str = "[world-model] assertion insert returned no row";

/// `new Date().toISOString()` — millisecond precision, always UTC, `Z` suffix.
///
/// Used when the caller does not pin the instant (see the module header).
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `toAssertion(row)` — `assertionRepository.ts:52-69`.
fn to_assertion(row: &PgRow) -> WorldModelAssertionRecord {
    WorldModelAssertionRecord {
        id: row_text(row, "id"),
        user_id: row_text(row, "user_id"),
        persona_id: row_text(row, "persona_id"),
        workspace_id: row_text(row, "workspace_id"),
        subject_id: row_text(row, "subject_id"),
        predicate: row_text(row, "predicate"),
        object_value: row_optional_text(row, "object_value"),
        modality: modality_from_column(&row_text(row, "modality")),
        status: status_from_column(&row_text(row, "status")),
        confidence: row_number(row, "confidence"),
        known_from: row_text(row, "known_from"),
        known_to: row_optional_text(row, "known_to"),
        source_observation_id: row_optional_text(row, "source_observation_id"),
        supersedes_assertion_id: row_optional_text(row, "supersedes_assertion_id"),
    }
}

/// The `status` column of a row (deviation 1).
fn status_from_column(text: &str) -> AssertionStatus {
    match text {
        "superseded" => AssertionStatus::Superseded,
        "cancelled" => AssertionStatus::Cancelled,
        "retracted" => AssertionStatus::Retracted,
        _ => AssertionStatus::Active,
    }
}

/// The `modality` column; an out-of-union literal falls back to
/// [`Modality::Reported`], the default the insert itself binds (`:128`).
fn modality_from_column(text: &str) -> Modality {
    serde_json::from_value::<Modality>(Value::String(text.to_string()))
        .unwrap_or(Modality::Reported)
}

/// The literal of the `Modality` union (`types.ts:1-8`).
fn modality_literal(modality: Modality) -> &'static str {
    match modality {
        Modality::Reported => "reported",
        Modality::Planned => "planned",
        Modality::Expected => "expected",
        Modality::Inferred => "inferred",
        Modality::Observed => "observed",
        Modality::Confirmed => "confirmed",
        Modality::Denied => "denied",
    }
}

/// `insertAssertion(input, db)` — `assertionRepository.ts:81-135`.
///
/// Three statements, each in its own scoped transaction, exactly like the three
/// `db.query` calls of the source: the replay read (`:86-99`), the supersede of
/// the currently active truth (`:104-111`) and the insert (`:113-133`).
pub async fn insert_assertion<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &WorldModelAssertionInput,
    now: Option<&str>,
) -> Result<WorldModelAssertionRecord, E> {
    if let Some(source_observation_id) = input.source_observation_id.as_deref() {
        let replay = ambient_query::<E>(
            executor,
            scope,
            PgStatement::with_params(
                replay_sql(),
                vec![
                    PgValue::text(source_observation_id),
                    PgValue::text(input.subject_id.as_str()),
                    PgValue::text(input.predicate.as_str()),
                    PgValue::nullable_text(input.object_id.clone()),
                    PgValue::nullable_text(input.object_value.clone()),
                ],
            ),
        )
        .await?;
        if let Some(row) = replay.first() {
            return Ok(to_assertion(row));
        }
    }

    let stamp = now.map(str::to_string).unwrap_or_else(now_iso);
    // Alte aktive Wahrheit schliessen (bitemporal: known_to = now).
    let superseded = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_SUPERSEDE,
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_str()),
                PgValue::text(stamp.as_str()),
                PgValue::text(input.subject_id.as_str()),
                PgValue::text(input.predicate.as_str()),
            ],
        ),
    )
    .await?;

    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            insert_sql(),
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_str()),
                PgValue::text(input.subject_id.as_str()),
                PgValue::text(input.predicate.as_str()),
                PgValue::nullable_text(input.object_id.clone()),
                PgValue::nullable_text(input.object_value.clone()),
                PgValue::Int64(input.polarity.unwrap_or(1)),
                PgValue::text(modality_literal(
                    input.modality.unwrap_or(Modality::Reported),
                )),
                PgValue::Float64(input.confidence.unwrap_or(0.8)),
                PgValue::nullable_text(input.source_observation_id.clone()),
                PgValue::nullable_text(superseded.first().map(|row| row_text(row, "id"))),
            ],
        ),
    )
    .await?;
    match result.first() {
        Some(row) => Ok(to_assertion(row)),
        None => Err(E::from(PgError::new(MISSING_ASSERTION_ROW))),
    }
}
// SENTINEL-END

/// `listActiveAssertions(userId, personaId, workspaceId = '', db)` —
/// `assertionRepository.ts:137-150`.
pub async fn list_active_assertions<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    workspace_id: Option<&str>,
) -> Result<Vec<WorldModelAssertionRecord>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            active_sql(),
            vec![
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id.unwrap_or("")),
            ],
        ),
    )
    .await?;
    Ok(result.rows.iter().map(to_assertion).collect())
}

/// `retractAssertion(id, db)` — `assertionRepository.ts:152-161`.
pub async fn retract_assertion<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
) -> Result<(), E> {
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(SQL_RETRACT, vec![PgValue::text(id)]),
    )
    .await
    .map(|_| ())
}

/// `expireAssertion(id, db)` — `assertionRepository.ts:163-172`.
pub async fn expire_assertion<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    id: &str,
) -> Result<(), E> {
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(SQL_EXPIRE, vec![PgValue::text(id)]),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use serde_json::json;

    const STAMP: &str = "2026-10-10T10:00:00.000Z";

    fn input() -> WorldModelAssertionInput {
        WorldModelAssertionInput {
            user_id: "u1".to_string(),
            persona_id: "p1".to_string(),
            workspace_id: "w1".to_string(),
            subject_id: "e1".to_string(),
            predicate: "likes".to_string(),
            object_value: Some("coffee".to_string()),
            object_id: None,
            polarity: None,
            modality: None,
            confidence: None,
            source_observation_id: None,
        }
    }

    fn assertion_row() -> PgRow {
        json!({
            "id": "as1",
            "user_id": "u1",
            "persona_id": "p1",
            "workspace_id": "w1",
            "subject_id": "e1",
            "predicate": "likes",
            "object_value": "coffee",
            "modality": "reported",
            "status": "active",
            "confidence": 0.8,
            "known_from": STAMP,
            "known_to": null,
            "source_observation_id": null,
            "supersedes_assertion_id": null,
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
    fn an_insert_without_a_source_writes_the_supersede_and_the_row() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![json!({ "id": "old" })
                .as_object()
                .expect("object")
                .clone()])),
            Ok(PgQueryResult::from_rows(vec![assertion_row()])),
        ]);
        let assertion = drive_sync(insert_assertion::<PgError>(
            &executor,
            Some(&WorldModelScope::new("u1", "p1", Some("w1".to_string()))),
            &input(),
            Some(STAMP),
        ))
        .expect("bridge")
        .expect("insert");
        assert_eq!(assertion.id, "as1");
        assert_eq!(assertion.status, AssertionStatus::Active);
        assert_eq!(assertion.modality, Modality::Reported);
        assert_eq!(assertion.confidence, 0.8);
        assert_eq!(
            sqls(&executor),
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_SUPERSEDE.to_string(),
                SQL_COMMIT.to_string(),
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                insert_sql(),
                SQL_COMMIT.to_string(),
            ],
            "no source observation, so the replay read is skipped"
        );
        match &executor.calls()[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text("w1"),
                    PgValue::text(STAMP),
                    PgValue::text("e1"),
                    PgValue::text("likes"),
                ],
                "the bitemporal close binds the caller's instant"
            ),
            other => panic!("expected the supersede, got {other:?}"),
        }
        match &executor.calls()[7] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text("w1"),
                    PgValue::text("e1"),
                    PgValue::text("likes"),
                    PgValue::Null,
                    PgValue::text("coffee"),
                    PgValue::Int64(1),
                    PgValue::text("reported"),
                    PgValue::Float64(0.8),
                    PgValue::Null,
                    PgValue::text("old"),
                ],
                "`polarity ?? 1`, `modality ?? 'reported'`, `confidence ?? 0.8`, \
                 `superseded.rows[0]?.id ?? null`"
            ),
            other => panic!("expected the insert, got {other:?}"),
        }
    }

    #[test]
    fn a_replayed_source_skips_the_supersede_and_the_insert() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![assertion_row()]))]);
        let mut replay = input();
        replay.source_observation_id = Some("o1".to_string());
        replay.object_id = Some("e2".to_string());
        replay.object_value = None;
        let assertion = drive_sync(insert_assertion::<PgError>(
            &executor,
            Some(&WorldModelScope::new("u1", "p1", Some("w1".to_string()))),
            &replay,
            Some(STAMP),
        ))
        .expect("bridge")
        .expect("insert");
        assert_eq!(assertion.id, "as1");
        assert_eq!(
            sqls(&executor),
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                replay_sql(),
                SQL_COMMIT.to_string(),
            ],
            "the replay read ends the call, like the `if (replay.rows[0]) return` of the source"
        );
        match &executor.calls()[2] {
            Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("o1"),
                    PgValue::text("e1"),
                    PgValue::text("likes"),
                    PgValue::text("e2"),
                    PgValue::Null,
                ],
                "`objectId ?? null` and `objectValue ?? null`"
            ),
            other => panic!("expected the replay read, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_insert_row_is_an_error() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::empty()), Ok(PgQueryResult::empty())]);
        let error = drive_sync(insert_assertion::<PgError>(
            &executor,
            None,
            &input(),
            Some(STAMP),
        ))
        .expect("bridge")
        .expect_err("no row");
        assert_eq!(error.message, MISSING_ASSERTION_ROW);
        assert_eq!(
            executor.calls().len(),
            2,
            "without an ambient scope each statement is a bare pool query"
        );
    }

    #[test]
    fn the_active_list_retracts_and_expires() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![assertion_row()]))]);
        let active = drive_sync(list_active_assertions::<PgError>(
            &executor, None, "u1", "p1", None,
        ))
        .expect("bridge")
        .expect("list");
        assert_eq!(active.len(), 1);
        match &executor.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, active_sql());
                assert_eq!(
                    statement.params,
                    vec![PgValue::text("u1"), PgValue::text("p1"), PgValue::text(""),],
                    "`workspaceId = ''`"
                );
            }
            other => panic!("expected the active list, got {other:?}"),
        }

        let retract = RecordingExecutor::new(vec![Ok(PgQueryResult::affected(1))]);
        drive_sync(retract_assertion::<PgError>(&retract, None, "as1"))
            .expect("bridge")
            .expect("retract");
        match &retract.calls()[0] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_RETRACT);
                assert_eq!(statement.params, vec![PgValue::text("as1")]);
            }
            other => panic!("expected the retraction, got {other:?}"),
        }

        let expire = RecordingExecutor::new(vec![Ok(PgQueryResult::affected(1))]);
        drive_sync(expire_assertion::<PgError>(
            &expire,
            Some(&WorldModelScope::new("u1", "p1", None)),
            "as1",
        ))
        .expect("bridge")
        .expect("expire");
        let calls = expire.calls();
        assert_eq!(
            calls.len(),
            5,
            "scoped: BEGIN, scope, statement, COMMIT, release"
        );
        match &calls[2] {
            Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_EXPIRE);
                assert_eq!(statement.params, vec![PgValue::text("as1")]);
            }
            other => panic!("expected the expiry, got {other:?}"),
        }
    }

    #[test]
    fn the_out_of_union_columns_fall_back_to_the_insert_defaults() {
        let mut row = assertion_row();
        row.insert("status".to_string(), json!("archived"));
        row.insert("modality".to_string(), json!("guessed"));
        row.insert("confidence".to_string(), json!("0.5"));
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![row])),
        ]);
        let assertion = drive_sync(insert_assertion::<PgError>(
            &executor,
            None,
            &input(),
            Some(STAMP),
        ))
        .expect("bridge")
        .expect("insert");
        assert_eq!(assertion.status, AssertionStatus::Active, "deviation 1");
        assert_eq!(assertion.modality, Modality::Reported);
        assert_eq!(assertion.confidence, 0.5, "`numeric` arrives as text");
    }

    #[test]
    fn the_instant_defaults_to_now_when_the_caller_does_not_pin_it() {
        let started_at = chrono::Utc::now().timestamp_millis();
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![assertion_row()])),
        ]);
        drive_sync(insert_assertion::<PgError>(&executor, None, &input(), None))
            .expect("bridge")
            .expect("insert");
        match &executor.calls()[0] {
            Recorded::Statement(statement) => match &statement.params[3] {
                PgValue::Text(stamp) => {
                    let parsed =
                        chrono::DateTime::parse_from_rfc3339(stamp).expect("ISO timestamp");
                    let elapsed = parsed.timestamp_millis() - started_at;
                    assert!(
                        (0..=1_000).contains(&elapsed),
                        "stamp must be generated now"
                    );
                    assert!(stamp.ends_with('Z'));
                    let millis = stamp
                        .rsplit_once('.')
                        .expect("fractional seconds")
                        .1
                        .strip_suffix('Z')
                        .expect("UTC suffix");
                    assert_eq!(millis.len(), 3, "ISO timestamp keeps millisecond precision");
                }
                other => panic!("expected the instant, got {other:?}"),
            },
            other => panic!("expected the supersede, got {other:?}"),
        }
    }
}
