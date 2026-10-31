//! Port of
//! `src/server/world-model/repositories/ingestionCheckpointRepository.ts`
//! (93 lines) — the idempotent ingestion checkpoint of the knowledge slice.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `ingestionCheckpointRepository.ts:3-12` (`WorldModelIngestionCheckpoint`) | [`WorldModelIngestionCheckpoint`] |
//! | `ingestionCheckpointRepository.ts:14-23` (`CheckpointRow`) | the column names of the statements |
//! | `ingestionCheckpointRepository.ts:25-36` (`toCheckpoint`) | [`to_checkpoint`] |
//! | `ingestionCheckpointRepository.ts:38-76` (`upsertWorldModelIngestionCheckpoint`) | [`upsert_world_model_ingestion_checkpoint`], [`IngestionCheckpointInput`] |
//! | `ingestionCheckpointRepository.ts:78-93` (`getWorldModelIngestionCheckpoint`) | [`get_world_model_ingestion_checkpoint`] |
//! | `ingestionCheckpointRepository.ts:51-64` (upsert) | [`SQL_UPSERT_CHECKPOINT`] |
//! | `ingestionCheckpointRepository.ts:86-89` (read) | [`SQL_GET_CHECKPOINT`] |
//!
//! # Deviations
//!
//! 1. **The clock and the counter are the JavaScript ones.** `lastSeq` stays an
//!    `f64` like the `number` of the interface and goes through
//!    [`last_seq_param`], which is `Math.max(0, Math.floor(input.lastSeq))`
//!    including its `NaN`/`Infinity` results. `last_seq` comes back through
//!    `Number(row.last_seq)` ([`row_integer`]) because `pg` hands an `int8` over
//!    as text.
//! 2. **A missing `RETURNING` row is an error instead of a `TypeError`.** The
//!    source reads `result.rows[0]!` (`:75`); the port answers
//!    [`MISSING_CHECKPOINT_ROW`], because the `INSERT … RETURNING` of the
//!    statement cannot legitimately produce no row and Rust has no `undefined`
//!    to propagate.

use crate::world_model::db::{PgError, PgExecutor, PgRow, PgStatement, PgValue};
use crate::world_model::repositories::{ambient_query, row_integer, row_optional_text, row_text};
use crate::world_model::scope::WorldModelScope;

/// `WorldModelIngestionCheckpoint` from `ingestionCheckpointRepository.ts:3-12`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldModelIngestionCheckpoint {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub last_seq: i64,
    pub source_window_id: String,
    pub committed_observation_id: Option<String>,
    pub updated_at: String,
}

/// The input of `upsertWorldModelIngestionCheckpoint`
/// (`ingestionCheckpointRepository.ts:39-47`).
#[derive(Debug, Clone, PartialEq)]
pub struct IngestionCheckpointInput {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
    /// `workspaceId?: string` — `input.workspaceId ?? ''`.
    pub workspace_id: Option<String>,
    /// `lastSeq: number`.
    pub last_seq: f64,
    pub source_window_id: String,
    /// `committedObservationId?: string | null` — `… ?? null`.
    pub committed_observation_id: Option<String>,
}

/// `ingestionCheckpointRepository.ts:51-64`.
pub const SQL_UPSERT_CHECKPOINT: &str = "INSERT INTO world_model_ingestion_checkpoints\n  (conversation_id, user_id, persona_id, workspace_id, last_seq, source_window_id, committed_observation_id)\nVALUES ($1,$2,$3,$4,$5,$6,$7)\nON CONFLICT (user_id, persona_id, workspace_id, conversation_id) DO UPDATE SET\n  last_seq = GREATEST(world_model_ingestion_checkpoints.last_seq, EXCLUDED.last_seq),\n  source_window_id = CASE\n    WHEN EXCLUDED.last_seq >= world_model_ingestion_checkpoints.last_seq\n    THEN EXCLUDED.source_window_id ELSE world_model_ingestion_checkpoints.source_window_id END,\n  committed_observation_id = CASE\n    WHEN EXCLUDED.last_seq >= world_model_ingestion_checkpoints.last_seq\n    THEN EXCLUDED.committed_observation_id ELSE world_model_ingestion_checkpoints.committed_observation_id END,\n  updated_at = now()\nRETURNING conversation_id, user_id, persona_id, workspace_id, last_seq,\n          source_window_id, committed_observation_id, updated_at";

/// `ingestionCheckpointRepository.ts:86-89`.
pub const SQL_GET_CHECKPOINT: &str = "SELECT conversation_id, user_id, persona_id, workspace_id, last_seq,\n       source_window_id, committed_observation_id, updated_at\nFROM world_model_ingestion_checkpoints\nWHERE conversation_id = $1 AND user_id = $2 AND persona_id = $3 AND workspace_id = $4";

/// The port's answer for `result.rows[0]!` (`:75`) — deviation 2.
pub const MISSING_CHECKPOINT_ROW: &str =
    "[world-model] ingestion checkpoint upsert returned no row";

/// `toCheckpoint(row)` — `ingestionCheckpointRepository.ts:25-36`.
fn to_checkpoint(row: &PgRow) -> WorldModelIngestionCheckpoint {
    WorldModelIngestionCheckpoint {
        conversation_id: row_text(row, "conversation_id"),
        user_id: row_text(row, "user_id"),
        persona_id: row_text(row, "persona_id"),
        workspace_id: row_text(row, "workspace_id"),
        last_seq: row_integer(row, "last_seq"),
        source_window_id: row_text(row, "source_window_id"),
        committed_observation_id: row_optional_text(row, "committed_observation_id"),
        updated_at: row_text(row, "updated_at"),
    }
}

/// `Math.max(0, Math.floor(input.lastSeq))` —
/// `ingestionCheckpointRepository.ts:70`.
///
/// Reproduced for every JavaScript number: `Math.floor` keeps `NaN` and the
/// infinities, `Math.max(0, …)` answers `NaN` for `NaN`, `0` for `-Infinity` and
/// `Infinity` for `Infinity`. Only a finite result can become the [`i64`] of the
/// seam, so a non-finite one stays a [`PgValue::Float64`] and reaches `pg` as the
/// same text parameter JavaScript would send.
fn last_seq_param(value: f64) -> PgValue {
    let floored = value.floor();
    let clamped = if floored.is_nan() || floored > 0.0 {
        floored
    } else {
        0.0
    };
    if clamped.is_finite() {
        PgValue::Int64(clamped as i64)
    } else {
        PgValue::Float64(clamped)
    }
}

/// `upsertWorldModelIngestionCheckpoint(input, db)` —
/// `ingestionCheckpointRepository.ts:38-76`.
pub async fn upsert_world_model_ingestion_checkpoint<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &IngestionCheckpointInput,
) -> Result<WorldModelIngestionCheckpoint, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_UPSERT_CHECKPOINT,
            vec![
                PgValue::text(input.conversation_id.as_str()),
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.clone().unwrap_or_default()),
                last_seq_param(input.last_seq),
                PgValue::text(input.source_window_id.as_str()),
                PgValue::nullable_text(input.committed_observation_id.clone()),
            ],
        ),
    )
    .await?;
    match result.first() {
        Some(row) => Ok(to_checkpoint(row)),
        None => Err(E::from(PgError::new(MISSING_CHECKPOINT_ROW))),
    }
}

/// `getWorldModelIngestionCheckpoint(conversationId, userId, personaId,
/// workspaceId = '', db)` — `ingestionCheckpointRepository.ts:78-93`.
pub async fn get_world_model_ingestion_checkpoint<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    conversation_id: &str,
    user_id: &str,
    persona_id: &str,
    workspace_id: Option<&str>,
) -> Result<Option<WorldModelIngestionCheckpoint>, E> {
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_GET_CHECKPOINT,
            vec![
                PgValue::text(conversation_id),
                PgValue::text(user_id),
                PgValue::text(persona_id),
                PgValue::text(workspace_id.unwrap_or("")),
            ],
        ),
    )
    .await?;
    Ok(result.first().map(to_checkpoint))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::RecordingExecutor;
    use crate::world_model::db::{drive_sync, PgQueryResult, SQL_BEGIN, SQL_COMMIT, SQL_SET_SCOPE};
    use serde_json::json;

    fn ambient() -> WorldModelScope {
        WorldModelScope::new("u1", "p1", Some("w1".to_string()))
    }

    fn input(last_seq: f64) -> IngestionCheckpointInput {
        IngestionCheckpointInput {
            conversation_id: "c1".to_string(),
            user_id: "u1".to_string(),
            persona_id: "p1".to_string(),
            workspace_id: None,
            last_seq,
            source_window_id: "window-1".to_string(),
            committed_observation_id: Some("o1".to_string()),
        }
    }

    fn checkpoint_row() -> PgRow {
        json!({
            "conversation_id": "c1",
            "user_id": "u1",
            "persona_id": "p1",
            "workspace_id": "",
            "last_seq": "7",
            "source_window_id": "window-1",
            "committed_observation_id": null,
            "updated_at": "2026-10-10T10:00:00.000Z",
        })
        .as_object()
        .expect("object")
        .clone()
    }

    #[test]
    fn the_upsert_runs_scoped_and_maps_the_checkpoint() {
        let executor =
            RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![checkpoint_row()]))]);
        let checkpoint = drive_sync(upsert_world_model_ingestion_checkpoint::<PgError>(
            &executor,
            Some(&ambient()),
            &input(7.0),
        ))
        .expect("bridge")
        .expect("upsert");
        assert_eq!(
            checkpoint,
            WorldModelIngestionCheckpoint {
                conversation_id: "c1".to_string(),
                user_id: "u1".to_string(),
                persona_id: "p1".to_string(),
                workspace_id: String::new(),
                last_seq: 7,
                source_window_id: "window-1".to_string(),
                committed_observation_id: None,
                updated_at: "2026-10-10T10:00:00.000Z".to_string(),
            },
            "`Number(row.last_seq)` parses the int8 text form"
        );
        let calls = executor.calls();
        let sqls: Vec<String> = calls
            .iter()
            .filter(|call| !matches!(call, crate::world_model::db::testing::Recorded::Release))
            .map(|call| call.sql().to_string())
            .collect();
        assert_eq!(
            sqls,
            vec![
                SQL_BEGIN.to_string(),
                SQL_SET_SCOPE.to_string(),
                SQL_UPSERT_CHECKPOINT.to_string(),
                SQL_COMMIT.to_string(),
            ]
        );
        match &calls[2] {
            crate::world_model::db::testing::Recorded::Statement(statement) => assert_eq!(
                statement.params,
                vec![
                    PgValue::text("c1"),
                    PgValue::text("u1"),
                    PgValue::text("p1"),
                    PgValue::text(""),
                    PgValue::Int64(7),
                    PgValue::text("window-1"),
                    PgValue::text("o1"),
                ]
            ),
            other => panic!("expected the upsert, got {other:?}"),
        }
    }

    #[test]
    fn the_last_seq_is_floored_and_clamped_like_javascript() {
        assert_eq!(last_seq_param(7.9), PgValue::Int64(7));
        assert_eq!(last_seq_param(-3.5), PgValue::Int64(0), "`Math.max(0, -4)`");
        assert_eq!(last_seq_param(-0.5), PgValue::Int64(0));
        assert_eq!(
            last_seq_param(f64::NEG_INFINITY),
            PgValue::Int64(0),
            "`Math.max(0, -Infinity)`"
        );
        assert_eq!(
            last_seq_param(f64::INFINITY),
            PgValue::Float64(f64::INFINITY)
        );
        match last_seq_param(f64::NAN) {
            PgValue::Float64(value) => assert!(value.is_nan(), "`Math.max(0, NaN)` is NaN"),
            other => panic!("expected the NaN float, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_returning_row_is_an_error() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let error = drive_sync(upsert_world_model_ingestion_checkpoint::<PgError>(
            &executor,
            None,
            &input(1.0),
        ))
        .expect("bridge")
        .expect_err("no row");
        assert_eq!(error.message, MISSING_CHECKPOINT_ROW);
    }

    #[test]
    fn the_read_binds_the_default_workspace_and_answers_none_without_a_row() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        let checkpoint = drive_sync(get_world_model_ingestion_checkpoint::<PgError>(
            &executor, None, "c1", "u1", "p1", None,
        ))
        .expect("bridge")
        .expect("read");
        assert!(checkpoint.is_none());
        let calls = executor.calls();
        assert_eq!(calls.len(), 1, "unscoped: no BEGIN, no scope, no COMMIT");
        match &calls[0] {
            crate::world_model::db::testing::Recorded::Statement(statement) => {
                assert_eq!(statement.sql, SQL_GET_CHECKPOINT);
                assert_eq!(
                    statement.params,
                    vec![
                        PgValue::text("c1"),
                        PgValue::text("u1"),
                        PgValue::text("p1"),
                        PgValue::text(""),
                    ],
                    "`workspaceId = ''`"
                );
            }
            other => panic!("expected the read, got {other:?}"),
        }
    }
}
