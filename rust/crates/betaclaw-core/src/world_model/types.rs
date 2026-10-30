//! Port of `src/server/world-model/types.ts:1-171` — the domain vocabulary of the
//! slice.
//!
//! The TypeScript file is pure type declarations, so the port keeps the same two
//! layers:
//!
//! * the **status and modality unions** become enums with
//!   `#[serde(rename_all = "snake_case")]`, so the wire form of every value is
//!   the literal of the source union (`no_show`, `permanent_failure`, …);
//! * the **row shapes** become structs whose field names are the camelCase
//!   properties of the source interfaces, with `Option` for every optional
//!   property so a partial JSON document round-trips unchanged.
//!
//! The `payload`/`metadata` maps stay `serde_json` values, exactly like the
//! `Record<string, unknown>` of the source.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `Modality` from `types.ts:1-8`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Modality {
    Reported,
    Planned,
    Expected,
    Inferred,
    Observed,
    Confirmed,
    Denied,
}

/// `EventStatus` from `types.ts:10-17`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventStatus {
    Proposed,
    Planned,
    InProgress,
    Completed,
    Cancelled,
    NoShow,
    Unknown,
}

/// `TaskStatus` from `types.ts:19-26`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Proposed,
    Planned,
    InProgress,
    Waiting,
    Completed,
    Cancelled,
    Failed,
}

/// `OpenLoopType` from `types.ts:28-34`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenLoopType {
    Clarification,
    Confirmation,
    EventOutcome,
    Dependency,
    MissingContext,
    PromisedFollowUp,
}

/// `OpenLoopStatus` from `types.ts:36-43`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenLoopStatus {
    Open,
    Scheduled,
    Asked,
    Answered,
    Resolved,
    Cancelled,
    Expired,
}

/// `StandingIntentStatus` from `types.ts:45`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StandingIntentStatus {
    Armed,
    Cooldown,
    Done,
    Cancelled,
    Expired,
}

/// `OutboxStatus` from `types.ts:47`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxStatus {
    Pending,
    Dispatched,
    Failed,
    PermanentFailure,
}

/// The `sourceType` union of `ObservationInput` (`types.ts:53-62`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationSourceType {
    ChatMessage,
    Email,
    CalendarEvent,
    LocationSignal,
    ToolExecution,
    OutboundMessage,
    UserConfirmation,
    Automation,
    Manual,
}

/// `ObservationInput` from `types.ts:49-67`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationInput {
    pub user_id: String,
    pub persona_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub source_type: ObservationSourceType,
    pub source_id: String,
    pub occurred_at: String,
    pub payload: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_authority: Option<String>,
}

/// `Observation extends ObservationInput` from `types.ts:69-72`.
///
/// The `extends` of the source is kept as a flattened field, so the JSON shape
/// is the union of both interfaces and a caller composes
/// `Observation { input, id, received_at }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    #[serde(flatten)]
    pub input: ObservationInput,
    pub id: String,
    pub received_at: String,
}

/// `EventInput` from `types.ts:74-88`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub user_id: String,
    pub persona_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub title: String,
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_entity_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counterpart_entity_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_for: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<EventStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces_event_id: Option<String>,
}

/// `EventRecord extends EventInput` from `types.ts:90-96`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    #[serde(flatten)]
    pub input: EventInput,
    pub id: String,
    /// Required in the record although it is optional in the input.
    pub status: EventStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces_event_id: Option<String>,
}

/// `EventTransitionInput` from `types.ts:98-106`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTransitionInput {
    pub event_id: String,
    pub to_status: EventStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_status: Option<EventStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_observation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transitioned_at: Option<String>,
}

/// `EventTransition extends EventTransitionInput` from `types.ts:108-111`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTransition {
    #[serde(flatten)]
    pub input: EventTransitionInput,
    pub id: String,
    pub transitioned_at: String,
}

/// `OpenLoopInput` from `types.ts:113-126`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenLoopInput {
    pub user_id: String,
    pub persona_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(rename = "type")]
    pub loop_type: OpenLoopType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_information: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub importance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub do_not_ask_before: Option<String>,
    pub deduplication_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<i64>,
}

/// `OpenLoopRecord extends OpenLoopInput` from `types.ts:128-138`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenLoopRecord {
    #[serde(flatten)]
    pub input: OpenLoopInput,
    pub id: String,
    pub status: OpenLoopStatus,
    pub attempts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_asked_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_observation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `StandingIntentInput` from `types.ts:140-154`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingIntentInput {
    pub user_id: String,
    pub persona_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub description: String,
    pub trigger_terms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_fires: Option<i64>,
    pub deduplication_key: String,
}

/// `StandingIntentRecord extends StandingIntentInput` from `types.ts:156-164`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingIntentRecord {
    #[serde(flatten)]
    pub input: StandingIntentInput,
    pub id: String,
    pub status: StandingIntentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_until: Option<String>,
    pub fire_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fired_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `OutboxEventInput` from `types.ts:166-176`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEventInput {
    pub event_type: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub payload: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// `OutboxEvent extends OutboxEventInput` from `types.ts:178-186`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEvent {
    #[serde(flatten)]
    pub input: OutboxEventInput,
    pub id: String,
    pub status: OutboxStatus,
    pub attempts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatched_at: Option<String>,
    /// `created?: boolean` — set by the idempotent insert path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<bool>,
}

/// `StandingIntentFireResult` from `types.ts:188-190`.
///
/// The wire form is a *boolean* discriminator (`{ matched: false }` or
/// `{ matched: true, intent, observation }`), which an internally tagged Rust
/// enum cannot express — its tag is a string. The port therefore keeps the
/// interface shape and provides the two constructors, so the "matched implies a
/// payload" invariant is enforced at construction instead of by the type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingIntentFireResult {
    pub matched: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<StandingIntentRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<Observation>,
}

impl StandingIntentFireResult {
    /// `{ matched: false }`.
    pub fn not_matched() -> Self {
        Self {
            matched: false,
            intent: None,
            observation: None,
        }
    }

    /// `{ matched: true, intent, observation }`.
    pub fn matched(intent: StandingIntentRecord, observation: Observation) -> Self {
        Self {
            matched: true,
            intent: Some(intent),
            observation: Some(observation),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_status_unions_use_the_literals_of_the_source() {
        assert_eq!(
            serde_json::to_value(EventStatus::NoShow).unwrap(),
            json!("no_show")
        );
        assert_eq!(
            serde_json::to_value(EventStatus::InProgress).unwrap(),
            json!("in_progress")
        );
        assert_eq!(
            serde_json::to_value(TaskStatus::InProgress).unwrap(),
            json!("in_progress")
        );
        assert_eq!(
            serde_json::to_value(OutboxStatus::PermanentFailure).unwrap(),
            json!("permanent_failure")
        );
        assert_eq!(
            serde_json::to_value(OpenLoopType::PromisedFollowUp).unwrap(),
            json!("promised_follow_up")
        );
        assert_eq!(
            serde_json::to_value(OpenLoopStatus::Answered).unwrap(),
            json!("answered")
        );
        assert_eq!(
            serde_json::to_value(StandingIntentStatus::Cooldown).unwrap(),
            json!("cooldown")
        );
        assert_eq!(
            serde_json::to_value(Modality::Inferred).unwrap(),
            json!("inferred")
        );
        assert_eq!(
            serde_json::to_value(ObservationSourceType::ChatMessage).unwrap(),
            json!("chat_message")
        );
    }

    #[test]
    fn an_absent_optional_property_is_omitted_like_undefined() {
        let input = EventInput {
            user_id: "u".to_string(),
            persona_id: "p".to_string(),
            workspace_id: None,
            title: "Kickoff".to_string(),
            event_type: "meeting".to_string(),
            subject_entity_id: None,
            counterpart_entity_id: Some("c1".to_string()),
            scheduled_for: None,
            ends_at: None,
            status: None,
            observed_at: None,
            idempotency_key: None,
            replaces_event_id: None,
        };
        let value = serde_json::to_value(&input).unwrap();
        assert_eq!(value["userId"], json!("u"));
        assert_eq!(value["personaId"], json!("p"));
        assert_eq!(value["counterpartEntityId"], json!("c1"));
        assert!(
            value.get("workspaceId").is_none(),
            "an absent optional property is omitted, like `undefined`"
        );
        assert!(value.get("scheduledFor").is_none());
    }

    #[test]
    fn an_open_loop_keeps_the_type_property_of_the_source() {
        let input = OpenLoopInput {
            user_id: "u".to_string(),
            persona_id: "p".to_string(),
            workspace_id: None,
            loop_type: OpenLoopType::Clarification,
            subject_id: None,
            question: Some("Which city?".to_string()),
            missing_information: None,
            importance: Some(0.5),
            trigger_at: None,
            do_not_ask_before: None,
            deduplication_key: "k".to_string(),
            max_attempts: Some(2),
        };
        let value = serde_json::to_value(&input).unwrap();
        assert_eq!(value["type"], json!("clarification"));
        assert_eq!(value["maxAttempts"], json!(2));
        assert_eq!(value["deduplicationKey"], json!("k"));
    }

    #[test]
    fn a_record_flattens_its_input() {
        let record = OutboxEvent {
            input: OutboxEventInput {
                event_type: "observation.recorded".to_string(),
                aggregate_type: "observation".to_string(),
                aggregate_id: "o1".to_string(),
                payload: Map::new(),
                idempotency_key: None,
                correlation_id: None,
                user_id: Some("u".to_string()),
                persona_id: None,
                workspace_id: None,
            },
            id: "e1".to_string(),
            status: OutboxStatus::Pending,
            attempts: 0,
            error_message: None,
            created_at: "2026-10-10T00:00:00.000Z".to_string(),
            dispatched_at: None,
            created: Some(true),
        };
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["eventType"], json!("observation.recorded"));
        assert_eq!(value["aggregateId"], json!("o1"));
        assert_eq!(value["status"], json!("pending"));
        assert_eq!(value["attempts"], json!(0));
        assert_eq!(value["created"], json!(true));
        assert!(value.get("errorMessage").is_none());
    }

    #[test]
    fn the_fire_result_keeps_the_matched_discriminator() {
        let not_matched = serde_json::to_value(StandingIntentFireResult::not_matched()).unwrap();
        assert_eq!(not_matched, json!({ "matched": false }));
        let parsed: StandingIntentFireResult =
            serde_json::from_value(json!({ "matched": false })).unwrap();
        assert!(!parsed.matched);
        assert!(parsed.intent.is_none());
        assert!(parsed.observation.is_none());
    }

    #[test]
    fn an_observation_flattens_its_input_and_deserializes_from_the_wire_form() {
        let wire = json!({
            "userId": "u",
            "personaId": "p",
            "sourceType": "chat_message",
            "sourceId": "m1",
            "occurredAt": "2026-10-10T10:00:00.000Z",
            "payload": { "text": "hi" },
            "id": "o1",
            "receivedAt": "2026-10-10T10:00:01.000Z"
        });
        let observation: Observation = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(
            observation.input.source_type,
            ObservationSourceType::ChatMessage
        );
        assert_eq!(observation.id, "o1");
        assert_eq!(observation.input.payload["text"], json!("hi"));
        assert_eq!(serde_json::to_value(&observation).unwrap(), wire);
    }
}
