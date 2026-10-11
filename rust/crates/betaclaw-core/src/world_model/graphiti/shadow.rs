//! Port of `src/server/world-model/graphiti/shadow.ts:1-106`.

use serde_json::{Map, Value};

use crate::world_model::db::{PgError, PgExecutor, PgStatement, PgValue};
use crate::world_model::repositories::{ambient_query, row_integer};
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::OutboxEvent;

#[derive(Debug, Clone, PartialEq)]
pub struct ShadowEdgeInput {
    pub source_outbox_event_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub source_aggregate: String,
    pub source_entity: String,
    pub target_entity: Option<String>,
    pub relation_type: String,
    pub confidence: f64,
    pub evidence_observation_id: Option<String>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub shadow_episode: Value,
}

pub const SQL_INSERT_SHADOW_EDGE: &str = "INSERT INTO world_model_graphiti_shadow\n      (source_outbox_event_id, user_id, persona_id, workspace_id, source_entity, target_entity,\n       relation_type, confidence, evidence_observation_id, source_aggregate, valid_from, valid_to,\n       shadow_episode)\n     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)\n     ON CONFLICT (source_outbox_event_id) DO NOTHING";

pub async fn insert_shadow_edge<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    input: &ShadowEdgeInput,
) -> Result<(), E> {
    ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            SQL_INSERT_SHADOW_EDGE,
            vec![
                PgValue::text(&input.source_outbox_event_id),
                PgValue::text(&input.user_id),
                PgValue::text(&input.persona_id),
                PgValue::text(&input.workspace_id),
                PgValue::text(&input.source_entity),
                PgValue::nullable_text(input.target_entity.clone()),
                PgValue::text(&input.relation_type),
                PgValue::float(input.confidence),
                PgValue::nullable_text(input.evidence_observation_id.clone()),
                PgValue::text(&input.source_aggregate),
                PgValue::nullable_text(input.valid_from.clone()),
                PgValue::nullable_text(input.valid_to.clone()),
                PgValue::text(input.shadow_episode.to_string()),
            ],
        ),
    )
    .await?;
    Ok(())
}

pub fn shadow_input_from_event(event: &OutboxEvent) -> ShadowEdgeInput {
    let payload = &event.input.payload;
    let user_id = payload
        .get("userId")
        .filter(|value| !value.is_null())
        .map(js_string)
        .unwrap_or_default();
    let persona_id = payload
        .get("personaId")
        .filter(|value| !value.is_null())
        .map(js_string)
        .unwrap_or_default();
    let workspace_id = payload
        .get("workspaceId")
        .filter(|value| !value.is_null())
        .map(js_string)
        .or_else(|| event.input.workspace_id.clone())
        .unwrap_or_default();
    let text = payload
        .get("text")
        .filter(|value| !value.is_null())
        .map(js_string)
        .unwrap_or_default();
    let source_entity = payload
        .get("sourceEntity")
        .filter(|value| !value.is_null())
        .map(js_string)
        .unwrap_or_else(|| {
            if user_id.is_empty() {
                "user".to_owned()
            } else {
                user_id.clone()
            }
        });
    let target_entity = payload
        .get("targetEntity")
        .filter(|value| js_truthy(value))
        .map(js_string)
        .or_else(|| {
            let target = utf16_prefix(&text, 80);
            (!target.is_empty()).then_some(target)
        });
    let confidence = match payload.get("confidence") {
        Some(Value::Number(value)) => value.as_f64().unwrap_or(1.0),
        _ => 1.0,
    };
    let shadow_episode = Value::Object(Map::from_iter([
        (
            "eventType".to_owned(),
            Value::String(event.input.event_type.clone()),
        ),
        (
            "createdAt".to_owned(),
            Value::String(event.created_at.clone()),
        ),
    ]));
    ShadowEdgeInput {
        source_outbox_event_id: event.id.clone(),
        user_id,
        persona_id,
        workspace_id,
        source_aggregate: event.input.aggregate_type.clone(),
        source_entity,
        target_entity,
        relation_type: payload
            .get("relationType")
            .filter(|value| !value.is_null())
            .map(js_string)
            .unwrap_or_else(|| "mentions".to_owned()),
        confidence,
        evidence_observation_id: (!event.input.aggregate_id.is_empty())
            .then(|| event.input.aggregate_id.clone()),
        valid_from: None,
        valid_to: None,
        shadow_episode,
    }
}

pub async fn count_shadow_edges<E: From<PgError> + Send + 'static>(
    executor: &dyn PgExecutor,
    scope: Option<&WorldModelScope>,
    user_id: Option<&str>,
    persona_id: Option<&str>,
    workspace_id: Option<&str>,
) -> Result<i64, E> {
    let mut params = Vec::new();
    let mut conditions = Vec::new();
    for (column, value) in [
        ("user_id", user_id),
        ("persona_id", persona_id),
        ("workspace_id", workspace_id),
    ] {
        if let Some(value) = value {
            params.push(PgValue::text(value));
            conditions.push(format!("{column} = ${}", params.len()));
        }
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let result = ambient_query::<E>(
        executor,
        scope,
        PgStatement::with_params(
            format!(
                "SELECT count(*)::text AS count FROM world_model_graphiti_shadow{where_clause}"
            ),
            params,
        ),
    )
    .await?;
    Ok(result
        .rows
        .first()
        .map(|row| row_integer(row, "count"))
        .unwrap_or(0))
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn utf16_prefix(value: &str, max_units: usize) -> String {
    let units = value.encode_utf16().take(max_units).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::types::{OutboxEventInput, OutboxStatus};

    #[test]
    fn observation_event_maps_to_shadow_edge_defaults() {
        let event = OutboxEvent {
            input: OutboxEventInput {
                event_type: "world.observation.created".into(),
                aggregate_type: "observation".into(),
                aggregate_id: "obs-1".into(),
                payload: Map::from_iter([
                    ("userId".into(), Value::String("u-1".into())),
                    ("personaId".into(), Value::String("p-1".into())),
                    (
                        "text".into(),
                        Value::String("Mira went to the cinema".into()),
                    ),
                ]),
                idempotency_key: None,
                correlation_id: None,
                user_id: None,
                persona_id: None,
                workspace_id: None,
            },
            id: "event-1".into(),
            status: OutboxStatus::Pending,
            attempts: 0,
            error_message: None,
            created_at: "2026-10-11T12:00:00.000Z".into(),
            dispatched_at: None,
            created: None,
        };
        let edge = shadow_input_from_event(&event);
        assert_eq!(edge.source_entity, "u-1");
        assert_eq!(
            edge.target_entity.as_deref(),
            Some("Mira went to the cinema")
        );
        assert_eq!(edge.relation_type, "mentions");
        assert_eq!(edge.evidence_observation_id.as_deref(), Some("obs-1"));
    }
}
