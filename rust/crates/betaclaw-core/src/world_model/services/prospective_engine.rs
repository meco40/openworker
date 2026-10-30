//! Port of `src/server/world-model/services/prospectiveEngine.ts:1-136`.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `prospectiveEngine.ts:18-20` (`OpenLoopFollowupRule`) | the `is_quiet_time` parameter of [`collect_due_follow_ups`] |
//! | `prospectiveEngine.ts:22` (`DEFAULT_OVERDUE_MS`) | [`DEFAULT_OVERDUE_MS`] |
//! | `prospectiveEngine.ts:24-36` (`collectDueFollowUps`) | [`collect_due_follow_ups`] |
//! | `prospectiveEngine.ts:38-40` (`markFollowUpAsked`) | [`mark_follow_up_asked`] |
//! | `prospectiveEngine.ts:42-52` (`resolveFollowUp`) | [`resolve_follow_up`] |
//! | `prospectiveEngine.ts:54-82` (`matchStandingIntents`) | [`match_standing_intents`] |
//! | `prospectiveEngine.ts:84-126` (`evaluateIntent`) | [`evaluate_intent`] + [`intent_matches`] |
//! | `prospectiveEngine.ts:129-134` (`heartbeatScan`) | [`heartbeat_scan`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `:119-124` uses
//!    `withWorldModelTransaction`, whose scope comes from
//!    `getWorldModelScope()`; the port takes `Option<&WorldModelScope>` and hands
//!    it to `run_scoped`, so the `BEGIN` → `world_model_set_scope` → `COMMIT`
//!    contract is unchanged.
//! 2. **The wall clock is passed in.** `:50`, `:63` use
//!    `new Date().toISOString()` and `:91-94` parse `now`; the port takes `now`
//!    explicitly. `matchStandingIntents` keeps the source's rule that the
//!    observation's `occurredAt` *is* `now` (`:63`).
//! 3. **`OpenLoopFollowupRule` is a function parameter.** Rust has no
//!    single-property options object, so `rule?.isQuietTime?.(at)` (`:32`) becomes
//!    `is_quiet_time: Option<&dyn Fn(&str) -> bool>`, which is the same
//!    "provided or absent" question.
//! 4. **The match is split from the write.** `evaluateIntent` interleaves the
//!    pure checks with the dispatch (`:119-124`); the port keeps
//!    [`intent_matches`] pure and testable and lets [`evaluate_intent`] call it
//!    before the transaction. The order of the checks is untouched.

use std::sync::Arc;

use serde_json::Value;

use crate::world_model::db::{
    run_scoped, BoxFuture, PgError, PgExecutor, PgQueryResult, PgSession, PgStatement,
};
use crate::world_model::repositories::normalized_scope;
use crate::world_model::repositories::prospective_repository::{
    list_armed_standing_intents, list_due_open_loops, list_overdue_open_loops,
    mark_open_loop_asked, register_standing_intent_fire, update_open_loop_status,
};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::standing_intent_dispatcher::{
    dispatch_standing_intent_action, StandingIntentDispatchInput,
};
use crate::world_model::types::{
    Observation, OpenLoopRecord, OpenLoopStatus, StandingIntentFireResult, StandingIntentRecord,
    StandingIntentStatus,
};

/// `DEFAULT_OVERDUE_MS` from `prospectiveEngine.ts:22`.
pub const DEFAULT_OVERDUE_MS: i64 = 24 * 60 * 60 * 1000;

/// `collectDueFollowUps(userId, personaId, at, workspaceId, rule)` —
/// `prospectiveEngine.ts:24-36`.
pub async fn collect_due_follow_ups(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: &str,
    persona_id: &str,
    at: &str,
    workspace_id: &str,
    is_quiet_time: Option<&dyn Fn(&str) -> bool>,
) -> Result<Vec<OpenLoopRecord>, PgError> {
    let due =
        list_due_open_loops::<PgError>(executor, scope, user_id, persona_id, at, workspace_id, 50)
            .await?;
    if is_quiet_time.map(|is_quiet| is_quiet(at)).unwrap_or(false) {
        return Ok(Vec::new());
    }
    Ok(due)
}

/// `markFollowUpAsked(loop, now)` — `prospectiveEngine.ts:38-40`.
pub async fn mark_follow_up_asked(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    loop_record: &OpenLoopRecord,
    now: &str,
) -> Result<(), PgError> {
    mark_open_loop_asked::<PgError>(executor, scope, &loop_record.id, now).await
}

/// `resolveFollowUp(loop, note, resolvedObservationId?)` —
/// `prospectiveEngine.ts:42-52`.
pub async fn resolve_follow_up(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    loop_record: &OpenLoopRecord,
    note: &str,
    resolved_observation_id: Option<&str>,
    now: &str,
) -> Result<(), PgError> {
    update_open_loop_status::<PgError>(
        executor,
        scope,
        &loop_record.id,
        OpenLoopStatus::Resolved,
        Some(now),
        None,
        resolved_observation_id,
        Some(note),
    )
    .await
}

/// `heartbeatScan(now, maxAgeMs)` — `prospectiveEngine.ts:129-134`.
pub async fn heartbeat_scan(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    now: &str,
    max_age_ms: i64,
) -> Result<Vec<OpenLoopRecord>, PgError> {
    let overdue = list_overdue_open_loops::<PgError>(executor, scope, max_age_ms, now, 100).await?;
    Ok(overdue)
}

/// `Object.values(observation.payload ?? {})` filtered to primitives, joined
/// with `' '` — `prospectiveEngine.ts:65-75`.
fn primitive_payload_values(payload: &serde_json::Map<String, Value>) -> Vec<String> {
    payload
        .values()
        .filter_map(|value| match value {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        })
        .collect()
}

/// `String(value)` for the `scopeMatches` comparison (`:104`).
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// `scopeMatches(configured, keys)` — `prospectiveEngine.ts:99-105`.
fn scope_matches(
    configured: Option<&str>,
    keys: &[&str],
    payload: &serde_json::Map<String, Value>,
) -> bool {
    let Some(configured) = configured.filter(|value| !value.is_empty()) else {
        return true;
    };
    let actual = keys
        .iter()
        .find_map(|key| payload.get(*key).filter(|value| !value.is_null()));
    match actual {
        Some(value) => js_string(value).to_lowercase() == configured.to_lowercase(),
        None => false,
    }
}

/// The check part of `evaluateIntent` — `prospectiveEngine.ts:90-117`.
pub fn intent_matches(
    intent: &StandingIntentRecord,
    observation: &Observation,
    haystack: &str,
    now: &str,
) -> bool {
    if intent.status != StandingIntentStatus::Armed {
        return false;
    }
    if let Some(expires_at) = intent.input.expires_at.as_deref() {
        if let (Ok(expires_at), Ok(now)) = (
            chrono::DateTime::parse_from_rfc3339(expires_at),
            chrono::DateTime::parse_from_rfc3339(now),
        ) {
            if expires_at < now {
                return false;
            }
        }
    }
    if let Some(cooldown_until) = intent.cooldown_until.as_deref() {
        if let (Ok(cooldown_until), Ok(now)) = (
            chrono::DateTime::parse_from_rfc3339(cooldown_until),
            chrono::DateTime::parse_from_rfc3339(now),
        ) {
            if cooldown_until > now {
                return false;
            }
        }
    }
    let max_fires = intent.input.max_fires.unwrap_or(0);
    if max_fires > 0 && intent.fire_count >= max_fires {
        return false;
    }

    let payload = &observation.input.payload;
    if !scope_matches(
        intent.input.subject_scope.as_deref(),
        &["subjectId", "subject", "subjectEntityId"],
        payload,
    ) {
        return false;
    }
    if !scope_matches(
        intent.input.channel_scope.as_deref(),
        &["channelType", "channel"],
        payload,
    ) {
        return false;
    }
    if !scope_matches(
        intent.input.sender_scope.as_deref(),
        &["senderId", "sender", "from"],
        payload,
    ) {
        return false;
    }

    if !intent.input.trigger_terms.is_empty() {
        return intent
            .input
            .trigger_terms
            .iter()
            .any(|term| haystack.contains(&term.to_lowercase()));
    }
    if let Some(event_type) = intent.input.event_type.as_deref() {
        let source_type =
            serde_json::to_value(observation.input.source_type).unwrap_or(Value::Null);
        return event_type == js_string(&source_type);
    }
    false
}

/// `matchStandingIntents(observation)` — `prospectiveEngine.ts:54-82`.
pub async fn match_standing_intents(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    observation: &Observation,
) -> Result<Vec<StandingIntentFireResult>, PgError> {
    let workspace_id = observation.input.workspace_id.clone().unwrap_or_default();
    let intents = list_armed_standing_intents::<PgError>(
        executor,
        scope,
        &observation.input.user_id,
        &observation.input.persona_id,
        &observation.input.occurred_at,
        &workspace_id,
    )
    .await?;

    // `now = observation.occurredAt` (`:63`).
    let now = observation.input.occurred_at.as_str();
    let source_type = serde_json::to_value(observation.input.source_type).unwrap_or(Value::Null);
    let mut haystack = vec![js_string(&source_type), observation.input.source_id.clone()];
    haystack.extend(primitive_payload_values(&observation.input.payload));
    let haystack = haystack.join(" ").to_lowercase();

    let mut results = Vec::new();
    for intent in intents {
        let fire = evaluate_intent(executor, scope, &intent, observation, &haystack, now).await?;
        if fire.matched {
            results.push(fire);
        }
    }
    Ok(results)
}

/// `evaluateIntent(intent, observation, haystack, now)` —
/// `prospectiveEngine.ts:84-126`.
async fn evaluate_intent(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    intent: &StandingIntentRecord,
    observation: &Observation,
    haystack: &str,
    now: &str,
) -> Result<StandingIntentFireResult, PgError> {
    if !intent_matches(intent, observation, haystack, now) {
        return Ok(StandingIntentFireResult::not_matched());
    }

    let parts = scope.map(normalized_scope);
    let intent = intent.clone();
    let observation = observation.clone();
    let now = now.to_string();
    run_scoped(
        executor,
        parts.as_ref(),
        Box::new(move |session| {
            Box::pin(async move {
                let transaction_executor = SessionExecutor(Arc::clone(&session));
                let input = StandingIntentDispatchInput {
                    intent: intent.clone(),
                    observation: observation.clone(),
                };
                let dispatch =
                    dispatch_standing_intent_action(&transaction_executor, None, &input).await?;
                if dispatch.created {
                    register_standing_intent_fire::<PgError>(
                        &transaction_executor,
                        None,
                        &intent.id,
                        &now,
                    )
                    .await?;
                }
                Ok(StandingIntentFireResult::matched(intent, observation))
            })
        }),
    )
    .await
}

/// The `client` of `withWorldModelTransaction` (`:119-124`) as an executor.
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
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow};
    use crate::world_model::types::{
        ObservationInput, ObservationSourceType, StandingIntentInput, StandingIntentStatus,
    };
    use serde_json::json;

    fn intent() -> StandingIntentRecord {
        StandingIntentRecord {
            input: StandingIntentInput {
                user_id: "u1".into(),
                persona_id: "p1".into(),
                workspace_id: Some("".into()),
                description: "Erinnere mich an das Angebot".into(),
                trigger_terms: vec!["Angebot".into()],
                event_type: None,
                subject_scope: Some("Mike".into()),
                channel_scope: None,
                sender_scope: None,
                expires_at: None,
                cooldown_ms: None,
                max_fires: Some(2),
                deduplication_key: "intent-key".into(),
            },
            id: "si1".into(),
            status: StandingIntentStatus::Armed,
            cooldown_until: None,
            fire_count: 0,
            last_fired_at: None,
            created_at: "2026-10-10T10:00:00.000Z".into(),
            updated_at: "2026-10-10T10:00:00.000Z".into(),
        }
    }

    fn observation(payload: serde_json::Map<String, Value>) -> Observation {
        Observation {
            input: ObservationInput {
                user_id: "u1".into(),
                persona_id: "p1".into(),
                workspace_id: Some("".into()),
                source_type: ObservationSourceType::ChatMessage,
                source_id: "m1".into(),
                occurred_at: "2026-10-10T10:05:00.000Z".into(),
                payload,
                source_authority: None,
            },
            id: "o1".into(),
            received_at: "2026-10-10T10:05:00.000Z".into(),
        }
    }

    fn haystack(observation: &Observation) -> String {
        let source_type = serde_json::to_value(observation.input.source_type).unwrap();
        let mut parts = vec![js_string(&source_type), observation.input.source_id.clone()];
        parts.extend(primitive_payload_values(&observation.input.payload));
        parts.join(" ").to_lowercase()
    }

    fn loop_row() -> PgRow {
        json!({
            "id": "l1", "user_id": "u1", "persona_id": "p1", "workspace_id": "",
            "type": "clarification", "status": "open", "subject_id": null,
            "question": "Which?", "missing_information": null, "importance": 1,
            "trigger_at": null, "do_not_ask_before": null, "last_checked_at": null,
            "deduplication_key": "key", "max_attempts": 3, "attempts": 0,
            "last_asked_at": null, "resolved_observation_id": null, "note": null,
            "created_at": "2026-10-10T10:00:00.000Z", "updated_at": "2026-10-10T10:00:00.000Z"
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn a_scope_match_compares_the_first_present_key_case_insensitively() {
        let payload = json!({ "subjectId": "MIKE", "text": "Das Angebot steht" })
            .as_object()
            .unwrap()
            .clone();
        let observation = observation(payload);
        let haystack = haystack(&observation);
        assert!(intent_matches(
            &intent(),
            &observation,
            &haystack,
            "2026-10-10T10:05:00.000Z"
        ));
    }

    #[test]
    fn a_missing_or_different_scope_value_never_fires() {
        let payload = json!({ "subjectId": "Anna", "text": "Das Angebot steht" })
            .as_object()
            .unwrap()
            .clone();
        let first = observation(payload);
        let first_haystack = haystack(&first);
        assert!(!intent_matches(
            &intent(),
            &first,
            &first_haystack,
            "2026-10-10T10:05:00.000Z"
        ));

        // The scope matches but no trigger term is part of the haystack.
        let payload = json!({ "subjectId": "Mike", "text": "Nichts dergleichen" })
            .as_object()
            .unwrap()
            .clone();
        let second = observation(payload);
        let second_haystack = haystack(&second);
        assert!(!intent_matches(
            &intent(),
            &second,
            &second_haystack,
            "2026-10-10T10:05:00.000Z"
        ));
    }

    #[test]
    fn the_fire_and_time_guards_run_before_the_scope_checks() {
        let payload = json!({ "subjectId": "Mike", "text": "Das Angebot steht" })
            .as_object()
            .unwrap()
            .clone();
        let observation = observation(payload);
        let haystack = haystack(&observation);
        let now = "2026-10-10T10:05:00.000Z";

        // `maxFires: 2` with two fires is exhausted, the third never fires.
        let mut exhausted = intent();
        exhausted.fire_count = 2;
        assert!(!intent_matches(&exhausted, &observation, &haystack, now));

        let mut expired = intent();
        expired.input.expires_at = Some("2026-10-10T09:00:00.000Z".into());
        assert!(!intent_matches(&expired, &observation, &haystack, now));

        let mut cooling = intent();
        cooling.cooldown_until = Some("2026-10-10T11:00:00.000Z".into());
        assert!(!intent_matches(&cooling, &observation, &haystack, now));

        let mut disarmed = intent();
        disarmed.status = StandingIntentStatus::Cooldown;
        assert!(!intent_matches(&disarmed, &observation, &haystack, now));
    }

    #[test]
    fn an_event_type_intent_matches_the_observation_source_type() {
        let mut intent = intent();
        intent.input.trigger_terms = Vec::new();
        intent.input.subject_scope = None;
        intent.input.event_type = Some("chat_message".into());
        let observation = observation(serde_json::Map::new());
        let haystack = haystack(&observation);
        assert!(intent_matches(
            &intent,
            &observation,
            &haystack,
            "2026-10-10T10:05:00.000Z"
        ));
        intent.input.event_type = Some("email".into());
        assert!(!intent_matches(
            &intent,
            &observation,
            &haystack,
            "2026-10-10T10:05:00.000Z"
        ));
    }

    #[test]
    fn the_quiet_hour_rule_empties_the_due_list_without_a_second_statement() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![loop_row()]))]);
        let quiet = |_now: &str| true;
        let due = drive_sync(collect_due_follow_ups(
            &executor,
            None,
            "u1",
            "p1",
            "2026-10-10T23:00:00.000Z",
            "",
            Some(&quiet),
        ))
        .expect("bridge")
        .expect("due");
        assert!(due.is_empty());
        assert_eq!(executor.calls().len(), 1, "only the due scan runs");
        assert!(executor.calls()[0]
            .sql()
            .contains("status IN ('open','scheduled')"));

        let loud = |_now: &str| false;
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![loop_row()]))]);
        let due = drive_sync(collect_due_follow_ups(
            &executor,
            None,
            "u1",
            "p1",
            "2026-10-10T12:00:00.000Z",
            "",
            Some(&loud),
        ))
        .expect("bridge")
        .expect("due");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "l1");
    }

    #[test]
    fn heartbeat_scan_keeps_the_sources_default_limit_of_one_hundred() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(vec![loop_row()]))]);
        let overdue = drive_sync(heartbeat_scan(
            &executor,
            None,
            "2026-10-11T12:00:00.000Z",
            DEFAULT_OVERDUE_MS,
        ))
        .expect("bridge")
        .expect("scan");
        assert_eq!(overdue.len(), 1);
        match &executor.calls()[0] {
            Recorded::Statement(statement) => {
                // `now - maxAgeMs` is `2026-10-10T12:00:00.000Z`.
                assert_eq!(
                    statement.params[0],
                    crate::world_model::db::PgValue::text("2026-10-10T12:00:00.000Z")
                );
                assert_eq!(
                    statement.params[1],
                    crate::world_model::db::PgValue::int(100)
                );
            }
            other => panic!("expected the overdue scan, got {other:?}"),
        }
    }
}
