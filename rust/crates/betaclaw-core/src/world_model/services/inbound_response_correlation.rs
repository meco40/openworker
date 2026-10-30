//! Port of `src/server/world-model/services/inboundResponseCorrelation.ts:1-223`
//! — the response correlation of the inbound-message path.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `inboundResponseCorrelation.ts:22-30` (`InboundCorrelationInput`) | [`InboundCorrelationInput`], [`InboundConversation`], [`InboundUserMessageInput`] |
//! | `inboundResponseCorrelation.ts:32-37` (`InboundCorrelationResult`) | [`InboundCorrelationResult`], [`MatchedType`], [`CorrelationAction`] |
//! | `inboundResponseCorrelation.ts:43-78` (`buildCorrelationCandidates`) | [`build_correlation_candidates`] |
//! | `inboundResponseCorrelation.ts:84-181` (`correlateInboundResponse`) | [`correlate_inbound_response`] |
//! | `inboundResponseCorrelation.ts:187-223` (`looksLikeResponse`) | [`looks_like_response`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `withWorldModelTransaction`
//!    (`db.ts:204-229`) and the repositories read `getWorldModelScope()`; the
//!    port takes the [`WorldModelScope`] as an argument.
//! 2. **`getWorldModelConfig()` is a parameter.** `:87` reads the process
//!    environment; the port takes the [`WorldModelConfig`] so the caller owns the
//!    environment lookup and the function stays deterministic.
//! 3. **`Conversation` is reduced to the fields this service reads.** The
//!    `@/shared/domain/types` interface belongs to the domain layer, not to the
//!    World Model slice; [`InboundConversation`] is the projection `:92-103`,
//!    `:151-160` accesses.
//! 4. **`new Date().toISOString()` of the answered note** is supplied as `now` so
//!    the port has no ambient clock.

use serde_json::json;

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{
    BoxFuture, PgError, PgExecutor, PgQueryResult, PgSession, PgStatement,
};
use crate::world_model::repositories::ambient_transaction;
use crate::world_model::repositories::delivery_receipt_repository::get_latest_delivery_receipt_by_open_loop_id;
use crate::world_model::repositories::prospective_repository::list_asked_open_loops;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::event_service::{
    confirm_event_outcome_in_tx, ConfirmEventOutcomeInput, EventOutcome,
};
use crate::world_model::services::open_loop_service::resolve_open_loop_as_answered_in_tx;
use crate::world_model::services::response_correlation_service::{
    correlate_user_response, CorrelatableTarget, CorrelatableTargetType, CorrelationReason,
    InboundUserMessage,
};
use crate::world_model::types::{ObservationInput, ObservationSourceType, OpenLoopType};

/// `10 * 60 * 1000` — the default window of `responseCorrelationService.ts:39`.
const DEFAULT_WINDOW_MS: i64 = 10 * 60 * 1000;

/// `24 * 60 * 60 * 1000` — the response window of `:63`.
const RESPONSE_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// The fields of `Conversation` (`@/shared/domain/types`) this service reads —
/// deviation 3.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundConversation {
    pub id: String,
    pub user_id: String,
    pub persona_id: Option<String>,
    pub workspace_id: Option<String>,
    pub channel_type: String,
    pub external_chat_id: Option<String>,
}

/// The `userMessage` of `InboundCorrelationInput` — `:24-29`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundUserMessageInput {
    pub text: String,
    pub received_at: String,
    pub observation_id: Option<String>,
    pub source_id: Option<String>,
}

/// `InboundCorrelationInput` from `:22-30`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundCorrelationInput {
    pub conversation: InboundConversation,
    pub user_message: InboundUserMessageInput,
}

/// `CorrelatableTargetType` — the `matchedType` union of `:34`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchedType {
    OpenLoop,
    Event,
    Task,
    IntentFire,
}

/// The `action` union of `:36`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorrelationAction {
    Answered,
    Confirmed,
    None,
}

/// `InboundCorrelationResult` from `:32-37`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundCorrelationResult {
    pub correlated: bool,
    pub matched_type: Option<MatchedType>,
    pub matched_id: Option<String>,
    pub action: Option<CorrelationAction>,
}

impl InboundCorrelationResult {
    fn not_correlated() -> Self {
        Self {
            correlated: false,
            matched_type: None,
            matched_id: None,
            action: None,
        }
    }
}

/// The `reason` union of `responseCorrelationService.ts:25` as text (`:129`).
fn correlation_reason_text(reason: CorrelationReason) -> &'static str {
    match reason {
        CorrelationReason::Exact => "exact",
        CorrelationReason::Single => "single",
        CorrelationReason::Ambiguous => "ambiguous",
        CorrelationReason::None => "none",
    }
}

/// The transaction executor the `*InTx` helpers receive.
struct SessionExecutor(std::sync::Arc<dyn PgSession>);

impl PgExecutor for SessionExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<std::sync::Arc<dyn PgSession>, PgError>> {
        Box::pin(async { Err(PgError::new("[world-model] nested transaction")) })
    }

    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        self.0.query(statement)
    }
}

/// `buildCorrelationCandidates(userId, personaId, workspaceId, conversationId)`
/// — `inboundResponseCorrelation.ts:43-78`.
///
/// Fail-soft: a failing read aborts candidate building and returns what was
/// collected, mirroring the `try`/`catch` of `:51-75`.
async fn build_correlation_candidates(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    workspace_id: &str,
    conversation_id: &str,
) -> Vec<CorrelatableTarget> {
    let mut candidates: Vec<CorrelatableTarget> = Vec::new();
    let open_loops = match list_asked_open_loops::<PgError>(
        executor,
        scope,
        user_id,
        persona_id,
        workspace_id,
        100,
    )
    .await
    {
        Ok(open_loops) => open_loops,
        Err(_) => return candidates,
    };
    for loop_record in open_loops {
        if loop_record.input.question.is_none() {
            continue;
        }
        let is_event_outcome = loop_record.input.loop_type == OpenLoopType::EventOutcome
            && loop_record
                .input
                .deduplication_key
                .starts_with("event-outcome:");
        let id = if is_event_outcome {
            loop_record.input.deduplication_key["event-outcome:".len()..].to_string()
        } else {
            loop_record.id.clone()
        };
        let target_type = if is_event_outcome {
            CorrelatableTargetType::Event
        } else {
            CorrelatableTargetType::OpenLoop
        };
        candidates.push(CorrelatableTarget {
            id,
            target_type,
            channel: None,
            conversation_id: Some(conversation_id.to_string()),
            external_chat_id: None,
            asked_at: loop_record.last_asked_at.clone(),
            window_ms: Some(RESPONSE_WINDOW_MS),
        });
        match get_latest_delivery_receipt_by_open_loop_id::<PgError>(
            executor,
            scope,
            &loop_record.id,
        )
        .await
        {
            Ok(Some(receipt)) => {
                if let Some(candidate) = candidates.last_mut() {
                    candidate.channel = Some(receipt.channel.clone());
                    candidate.external_chat_id = Some(receipt.target.clone());
                }
            }
            Ok(None) => {}
            // `:65` is inside the `try`, so a failing read ends candidate
            // building and keeps the candidates collected so far.
            Err(_) => break,
        }
    }
    candidates
}

/// `looksLikeResponse(text)` — `inboundResponseCorrelation.ts:187-223`.
///
/// `trimmed.length` is the UTF-16 length (`String#length`) of the source.
pub fn looks_like_response(text: &str) -> bool {
    let trimmed = text.trim().to_lowercase();
    if trimmed.encode_utf16().count() < 2 {
        return false;
    }
    const SHORT_RESPONSES: [&str; 21] = [
        "ja", "nein", "yes", "no", "ok", "okay", "doch", "genau", "stimmt", "richtig", "falsch",
        "ja,", "nein,", "yes,", "no,", "war", "hatte", "hat", "habe", "bin", "waren",
    ];
    if SHORT_RESPONSES
        .iter()
        .any(|r| trimmed == *r || trimmed.starts_with(r))
    {
        return true;
    }
    if trimmed.encode_utf16().count() > 200 {
        return false;
    }
    false
}

/// The atomic update of `:122-178`.
#[allow(clippy::too_many_arguments)]
async fn update_matched_target(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    matched: &CorrelatableTarget,
    decision_reason: CorrelationReason,
    conversation: &InboundConversation,
    persona_id: &str,
    workspace_id: &str,
    user_message: &InboundUserMessageInput,
    now: &str,
) -> Result<InboundCorrelationResult, PgError> {
    match matched.target_type {
        CorrelatableTargetType::OpenLoop => {
            let note = format!(
                "User response correlated via {} match",
                correlation_reason_text(decision_reason)
            );
            let loop_id = matched.id.clone();
            let observation_id = user_message.observation_id.clone();
            let now = now.to_string();
            ambient_transaction::<(), PgError>(
                executor,
                scope,
                Box::new(move |session| {
                    Box::pin(async move {
                        let transaction_executor = SessionExecutor(session);
                        resolve_open_loop_as_answered_in_tx(
                            &transaction_executor,
                            &loop_id,
                            observation_id.as_deref(),
                            Some(&note),
                            &now,
                        )
                        .await
                    })
                }),
            )
            .await?;
            Ok(InboundCorrelationResult {
                correlated: true,
                matched_type: Some(MatchedType::OpenLoop),
                matched_id: Some(matched.id.clone()),
                action: Some(CorrelationAction::Answered),
            })
        }
        CorrelatableTargetType::Event => {
            let (Some(_observation_id), Some(source_id)) = (
                user_message.observation_id.clone(),
                user_message.source_id.clone(),
            ) else {
                return Ok(InboundCorrelationResult::not_correlated());
            };
            let observation = ObservationInput {
                user_id: conversation.user_id.clone(),
                persona_id: persona_id.to_string(),
                workspace_id: Some(workspace_id.to_string()),
                source_type: ObservationSourceType::ChatMessage,
                source_id,
                occurred_at: user_message.received_at.clone(),
                payload: json!({
                    "conversationId": conversation.id,
                    "text": user_message.text,
                    "channelType": conversation.channel_type,
                    "externalChatId": conversation.external_chat_id,
                })
                .as_object()
                .cloned()
                .unwrap_or_default(),
                source_authority: Some("user".to_string()),
            };
            let event_id = matched.id.clone();
            ambient_transaction::<(), PgError>(
                executor,
                scope,
                Box::new(move |session| {
                    Box::pin(async move {
                        let transaction_executor = SessionExecutor(session);
                        confirm_event_outcome_in_tx(
                            &transaction_executor,
                            &ConfirmEventOutcomeInput {
                                event_id,
                                observation,
                                outcome: EventOutcome::Completed,
                            },
                        )
                        .await
                        .map(|_| ())
                    })
                }),
            )
            .await?;
            Ok(InboundCorrelationResult {
                correlated: true,
                matched_type: Some(MatchedType::Event),
                matched_id: Some(matched.id.clone()),
                action: Some(CorrelationAction::Confirmed),
            })
        }
        CorrelatableTargetType::Task | CorrelatableTargetType::IntentFire => {
            Ok(InboundCorrelationResult::not_correlated())
        }
    }
}

/// `correlateInboundResponse(input)` — `inboundResponseCorrelation.ts:84-181`.
pub async fn correlate_inbound_response(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    config: &WorldModelConfig,
    input: &InboundCorrelationInput,
    now: &str,
) -> Result<InboundCorrelationResult, PgError> {
    if !config.enabled && !config.e2e_enabled {
        return Ok(InboundCorrelationResult::not_correlated());
    }
    let conversation = &input.conversation;
    let persona_id = match conversation.persona_id.as_deref() {
        Some(persona_id) => persona_id.to_string(),
        None => return Ok(InboundCorrelationResult::not_correlated()),
    };
    let workspace_id = conversation.workspace_id.clone().unwrap_or_default();
    let inbound_msg = InboundUserMessage {
        channel: conversation.channel_type.clone(),
        conversation_id: Some(conversation.id.clone()),
        external_chat_id: conversation.external_chat_id.clone(),
        text: input.user_message.text.clone(),
        received_at: input.user_message.received_at.clone(),
    };
    let candidates = build_correlation_candidates(
        executor,
        scope,
        &conversation.user_id,
        &persona_id,
        &workspace_id,
        &conversation.id,
    )
    .await;
    if candidates.is_empty() {
        return Ok(InboundCorrelationResult::not_correlated());
    }
    let decision = correlate_user_response(&inbound_msg, &candidates, DEFAULT_WINDOW_MS);
    let matched = match (&decision.matched, decision.ambiguous) {
        (Some(matched), false) => matched.clone(),
        _ => return Ok(InboundCorrelationResult::not_correlated()),
    };
    match update_matched_target(
        executor,
        scope,
        &matched,
        decision.reason,
        conversation,
        &persona_id,
        &workspace_id,
        &input.user_message,
        now,
    )
    .await
    {
        Ok(result) => Ok(result),
        // `catch (error) { console.error(...) }` — `:176-178`.
        Err(_) => Ok(InboundCorrelationResult::not_correlated()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow, SQL_BEGIN, SQL_COMMIT};
    use serde_json::json;

    fn row(value: serde_json::Value) -> PgRow {
        value.as_object().expect("row object").clone()
    }

    fn loop_row(key: &str, loop_type: &str) -> PgRow {
        row(json!({
            "id": "l1", "user_id": "u1", "persona_id": "p1", "workspace_id": "w1",
            "type": loop_type, "status": "asked", "subject_id": null, "question": "Which?",
            "missing_information": null, "importance": 1, "trigger_at": null,
            "do_not_ask_before": null, "last_checked_at": null, "deduplication_key": key,
            "max_attempts": 3, "attempts": 1, "last_asked_at": "2026-10-11T10:00:00.000Z",
            "resolved_observation_id": null, "note": null,
            "created_at": "2026-10-11T09:00:00.000Z", "updated_at": "2026-10-11T10:00:00.000Z"
        }))
    }

    fn receipt_row() -> PgRow {
        row(json!({
            "id": "r1", "outbox_event_id": "x1", "open_loop_id": "l1", "user_id": "u1",
            "persona_id": "p1", "workspace_id": "w1", "channel": "telegram", "target": "+49",
            "provider_id": null, "provider_message_id": null,
            "delivered_at": "2026-10-11T10:00:00.000Z", "payload": {}
        }))
    }

    fn enabled() -> WorldModelConfig {
        WorldModelConfig {
            enabled: true,
            ..WorldModelConfig::default()
        }
    }

    fn conversation() -> InboundConversation {
        InboundConversation {
            id: "c1".into(),
            user_id: "u1".into(),
            persona_id: Some("p1".into()),
            workspace_id: Some("w1".into()),
            channel_type: "telegram".into(),
            external_chat_id: Some("+49".into()),
        }
    }

    fn input(source_id: Option<&str>) -> InboundCorrelationInput {
        InboundCorrelationInput {
            conversation: conversation(),
            user_message: InboundUserMessageInput {
                text: "ja".into(),
                received_at: "2026-10-11T10:01:00.000Z".into(),
                observation_id: Some("o1".into()),
                source_id: source_id.map(str::to_string),
            },
        }
    }

    #[test]
    fn looks_like_response_matches_the_short_response_list() {
        assert!(looks_like_response("ja"));
        assert!(looks_like_response("  JA  "));
        assert!(looks_like_response("Nein"));
        assert!(looks_like_response("okay"));
        assert!(!looks_like_response("x"));
        assert!(!looks_like_response("hallo"));
        assert!(!looks_like_response(&"a".repeat(201)));
    }

    #[test]
    fn a_disabled_world_model_correlates_nothing() {
        let executor = RecordingExecutor::new(vec![]);
        let result = drive_sync(correlate_inbound_response(
            &executor,
            None,
            &WorldModelConfig::default(),
            &input(Some("m1")),
            "2026-10-11T10:02:00.000Z",
        ))
        .expect("bridge")
        .expect("result");
        assert_eq!(result, InboundCorrelationResult::not_correlated());
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn an_open_loop_match_is_answered_within_a_scoped_transaction() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![loop_row(
                "k",
                "clarification",
            )])),
            Ok(PgQueryResult::from_rows(vec![receipt_row()])),
            Ok(PgQueryResult::empty()),
        ]);
        let result = drive_sync(correlate_inbound_response(
            &executor,
            None,
            &enabled(),
            &input(Some("m1")),
            "2026-10-11T10:02:00.000Z",
        ))
        .expect("bridge")
        .expect("result");
        assert!(result.correlated);
        assert_eq!(result.matched_type, Some(MatchedType::OpenLoop));
        assert_eq!(result.matched_id.as_deref(), Some("l1"));
        assert_eq!(result.action, Some(CorrelationAction::Answered));
        let calls = executor.calls();
        let sqls: Vec<String> = calls
            .iter()
            .map(|call| match call {
                Recorded::Statement(statement) => statement.sql.clone(),
                Recorded::Release => "<release>".to_string(),
            })
            .collect();
        assert!(sqls[0].contains("world_model_open_loops"));
        assert!(sqls[1].contains("world_model_delivery_receipts"));
        assert_eq!(sqls[2], SQL_BEGIN);
        assert!(sqls[3].contains("UPDATE world_model_open_loops"));
        assert_eq!(sqls[4], SQL_COMMIT);
        assert_eq!(calls.last(), Some(&Recorded::Release));
    }

    #[test]
    fn an_event_match_without_a_source_id_does_not_open_a_transaction() {
        let executor = RecordingExecutor::new(vec![
            Ok(PgQueryResult::from_rows(vec![loop_row(
                "event-outcome:e9",
                "event_outcome",
            )])),
            Ok(PgQueryResult::from_rows(vec![receipt_row()])),
        ]);
        let result = drive_sync(correlate_inbound_response(
            &executor,
            None,
            &enabled(),
            &input(None),
            "2026-10-11T10:02:00.000Z",
        ))
        .expect("bridge")
        .expect("result");
        assert_eq!(result, InboundCorrelationResult::not_correlated());
        assert_eq!(executor.calls().len(), 2, "only the two reads");
    }
}
