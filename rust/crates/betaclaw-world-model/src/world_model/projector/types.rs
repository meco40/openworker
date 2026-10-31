//! Port of `src/server/world-model/projector/types.ts:1-58`.

use serde::{Deserialize, Serialize};

use crate::world_model::types::{EventStatus, Modality};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedAssertion {
    pub subject: String,
    pub predicate: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_value: Option<String>,
    pub modality: Modality,
    pub confidence: f64,
    pub source_message_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedEvent {
    pub title: String,
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_for: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<String>,
    pub status: EventStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces_event_id: Option<String>,
    pub source_message_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedEntity {
    pub canonical_name: String,
    pub category: String,
    pub owner: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub source_message_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedRelation {
    pub source_entity: String,
    pub target_entity: String,
    pub relation_type: String,
    pub confidence: f64,
    pub source_message_seq: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectedOpenLoopType {
    Clarification,
    Confirmation,
    EventOutcome,
    Dependency,
    MissingContext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedOpenLoop {
    #[serde(rename = "type")]
    pub loop_type: ProjectedOpenLoopType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    pub deduplication_key: String,
    pub source_message_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedTask {
    pub title: String,
    pub requester: String,
    pub assignee: String,
    pub source_message_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldModelProjection {
    pub assertions: Vec<ProjectedAssertion>,
    pub events: Vec<ProjectedEvent>,
    pub entities: Vec<ProjectedEntity>,
    pub relations: Vec<ProjectedRelation>,
    pub open_loops: Vec<ProjectedOpenLoop>,
    pub tasks: Vec<ProjectedTask>,
    pub confidence_summary: ConfidenceSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfidenceSummary {
    pub total: usize,
    pub confident: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn optional_projection_fields_are_omitted_like_undefined() {
        let event = ProjectedEvent {
            title: "Film".into(),
            event_type: "plan".into(),
            scheduled_for: None,
            ends_at: None,
            status: EventStatus::Planned,
            replaces_event_id: None,
            source_message_seq: 2,
        };
        let value = serde_json::to_value(event).expect("serialize");
        assert_eq!(
            value,
            json!({"title":"Film", "eventType":"plan", "status":"planned", "sourceMessageSeq":2})
        );
    }
}
