//! Port of `src/server/knowledge/eventTypes.ts`.
//!
//! | TypeScript                                   | Rust |
//! | -------------------------------------------- | ---- |
//! | `eventTypes.ts:1-19` (`KNOWN_EVENT_TYPES`)    | [`KNOWN_EVENT_TYPES`] |
//! | `eventTypes.ts:21` (`KnowledgeEventType`)     | [`KnowledgeEventType`] |
//! | `eventTypes.ts:23-43` (`KnowledgeEvent`)      | [`KnowledgeEvent`] |
//! | `eventTypes.ts:45-63` (`UpsertKnowledgeEventInput`) | [`UpsertKnowledgeEventInput`] |
//! | `eventTypes.ts:65-75` (`KnowledgeEventFilter`)| [`KnowledgeEventFilter`] |
//! | `eventTypes.ts:77-82` (`EventAggregationResult`) | [`EventAggregationResult`] |
//!
//! # Open event type
//!
//! `KnowledgeEventType` is `(typeof KNOWN_EVENT_TYPES)[number] | string`
//! (`eventTypes.ts:21`): the catalogue is closed but the *stored* value is not.
//! [`KnowledgeEventType`] is therefore a type alias for [`String`]; the port
//! keeps the catalogue in [`KNOWN_EVENT_TYPES`] for callers that need a filter
//! list, and it does not validate a stored spelling, exactly like the source.
//!
//! `speakerRole` is a closed `'assistant' | 'user'` union that the SQLite schema
//! also enforces (`CHECK(speaker_role IN ('assistant','user'))`), so it becomes
//! the closed [`SpeakerRole`] enum.

use serde::{Deserialize, Serialize};

/// `KNOWN_EVENT_TYPES` from `eventTypes.ts:1-19`.
pub const KNOWN_EVENT_TYPES: [&str; 17] = [
    "shared_sleep",
    "visit",
    "trip",
    "meeting",
    "activity",
    "meal",
    "appointment",
    "celebration",
    "conflict",
    "reconciliation",
    "emotion",
    "location_change",
    "routine",
    "milestone",
    "relationship_change",
    "health",
    "finance",
];

/// `KnowledgeEventType` from `eventTypes.ts:21`.
///
/// The union is open: any string is a valid value, the catalogue is advisory.
pub type KnowledgeEventType = String;

/// `speakerRole: 'assistant' | 'user'` from `eventTypes.ts:29`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeakerRole {
    Assistant,
    User,
}

impl SpeakerRole {
    /// The column text of `knowledge_events.speaker_role`.
    pub fn as_str(self) -> &'static str {
        match self {
            SpeakerRole::Assistant => "assistant",
            SpeakerRole::User => "user",
        }
    }

    /// `String(row.speaker_role) as 'assistant' | 'user'` — an unchecked cast in
    /// the TypeScript; here the two known spellings map to the enum and anything
    /// else is [`SpeakerRole::Assistant`].
    pub fn from_column(value: &str) -> Self {
        match value {
            "user" => SpeakerRole::User,
            _ => SpeakerRole::Assistant,
        }
    }
}

/// `KnowledgeEvent` from `eventTypes.ts:23-43`.
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeEvent {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub event_type: KnowledgeEventType,
    pub speaker_role: SpeakerRole,
    pub speaker_entity: String,
    pub subject_entity: String,
    pub counterpart_entity: String,
    pub relation_label: Option<String>,
    pub start_date: String,
    pub end_date: String,
    pub day_count: i64,
    pub source_seq_json: String,
    pub source_summary: String,
    pub is_confirmation: bool,
    pub confidence: f64,
    pub created_at: String,
    pub updated_at: String,
}

/// `UpsertKnowledgeEventInput` from `eventTypes.ts:45-63`.
#[derive(Debug, Clone, PartialEq)]
pub struct UpsertKnowledgeEventInput {
    pub id: String,
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub event_type: KnowledgeEventType,
    pub speaker_role: SpeakerRole,
    pub speaker_entity: String,
    pub subject_entity: String,
    pub counterpart_entity: String,
    pub relation_label: Option<String>,
    pub start_date: String,
    pub end_date: String,
    pub day_count: i64,
    pub source_seq_json: Option<String>,
    pub source_summary: Option<String>,
    pub is_confirmation: Option<bool>,
    pub confidence: Option<f64>,
}

/// `KnowledgeEventFilter` from `eventTypes.ts:65-75`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct KnowledgeEventFilter {
    pub user_id: String,
    pub persona_id: String,
    pub event_type: Option<KnowledgeEventType>,
    pub speaker_role: Option<SpeakerRole>,
    pub subject_entity: Option<String>,
    pub counterpart_entity: Option<String>,
    pub relation_label: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// `EventAggregationResult` from `eventTypes.ts:77-82`.
#[derive(Debug, Clone, PartialEq)]
pub struct EventAggregationResult {
    pub unique_day_count: usize,
    pub unique_days: Vec<String>,
    pub event_count: usize,
    pub events: Vec<KnowledgeEvent>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The catalogue is part of the event contract: a missing type changes which
    /// events the extractor is allowed to emit.
    #[test]
    fn the_catalogue_matches_the_typescript_list() {
        assert_eq!(KNOWN_EVENT_TYPES.len(), 17);
        assert_eq!(KNOWN_EVENT_TYPES[0], "shared_sleep");
        assert_eq!(KNOWN_EVENT_TYPES[16], "finance");
        assert!(KNOWN_EVENT_TYPES.contains(&"reconciliation"));
        assert!(KNOWN_EVENT_TYPES.contains(&"relationship_change"));
    }

    /// An open string survives as an event type; the enum keeps only the two
    /// schema spellings.
    #[test]
    fn the_event_type_is_open_and_the_speaker_role_is_closed() {
        let custom: KnowledgeEventType = "custom_event".to_string();
        assert_eq!(custom, "custom_event");
        assert_eq!(
            SpeakerRole::from_column("assistant"),
            SpeakerRole::Assistant
        );
        assert_eq!(SpeakerRole::from_column("user"), SpeakerRole::User);
        assert_eq!(SpeakerRole::from_column("system"), SpeakerRole::Assistant);
        assert_eq!(SpeakerRole::User.as_str(), "user");
    }
}
