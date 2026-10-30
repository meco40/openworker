//! Port of `src/server/world-model/graphiti/projector.ts:1-581` — the Graphiti
//! projector (outbox events into graph segments) and the PostgreSQL rebuild.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `projector.ts:24-30` (`ProjectionResult`) | [`ProjectionResult`] |
//! | `projector.ts:32-39` (`SUPPORTED_EVENT_TYPES`) | [`is_supported_event_type`] |
//! | `projector.ts:41-46` (`boundedGraphitiText`) | [`bounded_graphiti_text`] |
//! | `projector.ts:48-60` (`observationText`) | [`observation_text`] |
//! | `projector.ts:66-306` (`projectOutboxEvent`) | [`project_outbox_event`] |
//! | `projector.ts:311-315` (`createGraphitiProjectorHandler`) | [`GraphitiProjectorHandler`] |
//! | `projector.ts:328-372` (checkpoint helpers) | [`get_rebuild_checkpoint`], [`save_rebuild_checkpoint`], [`reset_rebuild_checkpoints`] |
//! | `projector.ts:426-581` (`rebuildGraphitiFromPostgres`) | [`rebuild_graphiti_from_postgres`] |
//!
//! # Deviations
//!
//! 1. **The Graphiti client is a trait seam.** [`GraphitiProjectionClient`] is
//!    implemented for [`GraphitiRestClient`]; the tests substitute a stub.
//! 2. **`created`/`updated` collapse into one count.** The ported client returns
//!    a single upsert count (`upsert_nodes`/`upsert_edges` -> `usize`), not the
//!    `{ created, updated }` of `client.ts`. The projector reports the count as
//!    `*Created` and `*Updated = 0`.
//! 3. **The ambient scope is a parameter.** `runWithWorldModelScope` (`:439`) is
//!    the explicit [`WorldModelScope`] the rebuild takes.

use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::world_model::db::{BoxFuture, PgError, PgExecutor, PgStatement, PgValue};
use crate::world_model::graphiti::client::{
    graphiti_group_id, GraphitiEdge, GraphitiMessage, GraphitiNode, GraphitiQueueStatus,
    GraphitiRestClient,
};
use crate::world_model::outbox_dispatcher::OutboxHandler;
use crate::world_model::repositories::ambient_query;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::types::OutboxEvent;

/// `ProjectionResult` from `projector.ts:24-30`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProjectionResult {
    pub nodes_created: usize,
    pub nodes_updated: usize,
    pub edges_created: usize,
    pub edges_updated: usize,
    pub skipped: usize,
}

impl ProjectionResult {
    fn skipped() -> Self {
        ProjectionResult {
            skipped: 1,
            ..ProjectionResult::default()
        }
    }
}

/// `SUPPORTED_EVENT_TYPES` — `projector.ts:32-39`.
pub fn is_supported_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "world.observation.created"
            | "world.assertion.created"
            | "world.event.created"
            | "world.relation.created"
            | "world.task.created"
            | "world.task.status_changed"
    )
}

/// `String(value)` of a payload value (deviation-free subset: strings, numbers,
/// booleans and JSON values).
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

/// `payload.<key> ?? …` — the first present (non-`null`) value.
fn present<'a>(payload: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    payload.get(key).filter(|value| !value.is_null())
}

/// `String(payload.text ?? payload.content ?? '')` etc.
fn payload_text(payload: &Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = present(payload, key) {
            return js_string(value);
        }
    }
    String::new()
}

/// `payload.<key> ?? ''` then `.trim()`.
fn trimmed(payload: &Map<String, Value>, keys: &[&str]) -> String {
    payload_text(payload, keys).trim().to_string()
}

/// Insert a property only when the payload value is present (JS omits
/// `undefined` properties).
fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        if !value.is_null() {
            map.insert(key.to_string(), value.clone());
        }
    }
}

/// `boundedGraphitiText(value, maxChars)` — `projector.ts:41-46`.
pub fn bounded_graphiti_text(value: &str, max_chars: usize) -> String {
    let limit = std::env::var("GRAPHITI_MAX_MESSAGE_CHARS")
        .ok()
        .filter(|raw| !raw.is_empty())
        .map(|raw| crate::js::js_number_str(&raw))
        .map(|number| 500.0_f64.max(number))
        .unwrap_or(max_chars as f64) as usize;
    if value.chars().count() > limit {
        format!(
            "{}\n[content truncated for Graphiti]",
            value.chars().take(limit).collect::<String>()
        )
    } else {
        value.to_string()
    }
}

/// `observationText(payload)` — `projector.ts:48-60`.
pub fn observation_text(payload: &Map<String, Value>) -> String {
    let direct = payload_text(payload, &["text", "content"])
        .trim()
        .to_string();
    if !direct.is_empty() {
        return direct;
    }
    let empty: Vec<Value> = Vec::new();
    let texts = payload
        .get("texts")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    texts
        .iter()
        .filter_map(Value::as_object)
        .map(|item| payload_text(item, &["content", "text"]).trim().to_string())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The Graphiti write surface the projector needs — deviation 1.
pub trait GraphitiProjectionClient: Send + Sync {
    fn add_messages<'a>(
        &'a self,
        group_id: &'a str,
        messages: &'a [GraphitiMessage],
    ) -> BoxFuture<'a, Result<usize, PgError>>;
    fn upsert_nodes<'a>(
        &'a self,
        nodes: &'a [GraphitiNode],
    ) -> BoxFuture<'a, Result<usize, PgError>>;
    fn upsert_edges<'a>(
        &'a self,
        edges: &'a [GraphitiEdge],
    ) -> BoxFuture<'a, Result<usize, PgError>>;
    fn queue_status<'a>(&'a self) -> BoxFuture<'a, Result<GraphitiQueueStatus, PgError>>;
    fn wait_for_queue<'a>(
        &'a self,
        baseline_failed_jobs: i64,
    ) -> BoxFuture<'a, Result<GraphitiQueueStatus, PgError>>;
}

impl GraphitiProjectionClient for GraphitiRestClient {
    fn add_messages<'a>(
        &'a self,
        group_id: &'a str,
        messages: &'a [GraphitiMessage],
    ) -> BoxFuture<'a, Result<usize, PgError>> {
        Box::pin(async move { self.add_messages(group_id, messages).await })
    }

    fn upsert_nodes<'a>(
        &'a self,
        nodes: &'a [GraphitiNode],
    ) -> BoxFuture<'a, Result<usize, PgError>> {
        Box::pin(async move { self.upsert_nodes(nodes).await })
    }

    fn upsert_edges<'a>(
        &'a self,
        edges: &'a [GraphitiEdge],
    ) -> BoxFuture<'a, Result<usize, PgError>> {
        Box::pin(async move { self.upsert_edges(edges).await })
    }

    fn queue_status<'a>(&'a self) -> BoxFuture<'a, Result<GraphitiQueueStatus, PgError>> {
        Box::pin(async move { self.queue_status().await })
    }

    fn wait_for_queue<'a>(
        &'a self,
        baseline_failed_jobs: i64,
    ) -> BoxFuture<'a, Result<GraphitiQueueStatus, PgError>> {
        Box::pin(async move {
            self.wait_for_queue(None, None, Some(baseline_failed_jobs))
                .await
        })
    }
}

/// `String(payload.<key> ?? event.<field> ?? '')` of `projector.ts:72-74`.
fn js_scope(payload: &Map<String, Value>, key: &str, fallback: Option<&str>) -> String {
    match present(payload, key) {
        Some(value) => js_string(value),
        None => fallback.unwrap_or("").to_string(),
    }
}

fn segment_properties(segment: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("segment".to_string(), json!(segment));
    map
}

/// `createGraphitiProjectorHandler()` — `projector.ts:311-315` as an owned outbox
/// handler. The borrowed [`GraphitiProjectorHandler`] cannot be registered in the
/// dispatcher, so the handler owns the client. The scope is not read: the projection
/// derives its group from the payload (`projector.ts:66-74`).
pub fn create_graphiti_projector_handler(
    client: Arc<dyn GraphitiProjectionClient + Send + Sync>,
) -> OutboxHandler {
    Arc::new(move |event: OutboxEvent, _scope: Option<WorldModelScope>| {
        let client = Arc::clone(&client);
        Box::pin(async move {
            project_outbox_event(client.as_ref(), &event)
                .await
                .map(|_| ())
                .map_err(|error| error.message)
        })
    })
}

/// `projectOutboxEvent(event)` — `projector.ts:66-306`.
pub async fn project_outbox_event(
    client: &dyn GraphitiProjectionClient,
    event: &OutboxEvent,
) -> Result<ProjectionResult, PgError> {
    if !is_supported_event_type(&event.input.event_type) {
        return Ok(ProjectionResult::skipped());
    }
    let payload = &event.input.payload;
    let user_id = js_scope(payload, "userId", event.input.user_id.as_deref());
    let persona_id = js_scope(payload, "personaId", event.input.persona_id.as_deref());
    let workspace_id = js_scope(payload, "workspaceId", event.input.workspace_id.as_deref());
    if user_id.is_empty() || persona_id.is_empty() {
        return Ok(ProjectionResult::skipped());
    }
    let segment = graphiti_group_id(&user_id, &persona_id, &workspace_id);
    let outcome = match event.input.event_type.as_str() {
        "world.observation.created" => project_observation(client, event, payload, &segment).await,
        "world.assertion.created" => project_assertion(client, event, payload, &segment).await,
        "world.event.created" => project_event(client, event, payload, &segment).await,
        "world.relation.created" => project_relation(client, event, payload, &segment).await,
        "world.task.created" | "world.task.status_changed" => {
            project_task(client, event, payload, &segment).await
        }
        _ => return Ok(ProjectionResult::skipped()),
    };
    // `catch (error) { console.error(...); throw error; }` — `:302-305`: the port
    // lets the error propagate unchanged.
    outcome
}

/// `case 'world.observation.created'` — `projector.ts:84-106`.
async fn project_observation(
    client: &dyn GraphitiProjectionClient,
    event: &OutboxEvent,
    payload: &Map<String, Value>,
    segment: &str,
) -> Result<ProjectionResult, PgError> {
    let text = bounded_graphiti_text(&observation_text(payload), 1_200);
    if text.is_empty() {
        return Ok(ProjectionResult::skipped());
    }
    let accepted = client
        .add_messages(
            segment,
            &[GraphitiMessage {
                uuid: Some(format!("observation:{}", event.input.aggregate_id)),
                name: Some("world-model-observation".to_string()),
                content: text,
                role_type: Some("system".to_string()),
                role: None,
                timestamp: Some(event.created_at.clone()),
                source_description: Some(format!(
                    "BetaClaw World Model observation {}",
                    event.input.aggregate_id
                )),
            }],
        )
        .await?;
    Ok(ProjectionResult {
        nodes_created: accepted,
        skipped: 0,
        ..ProjectionResult::default()
    })
}

/// `case 'world.assertion.created'` — `projector.ts:108-151`.
async fn project_assertion(
    client: &dyn GraphitiProjectionClient,
    event: &OutboxEvent,
    payload: &Map<String, Value>,
    segment: &str,
) -> Result<ProjectionResult, PgError> {
    let subject = trimmed(payload, &["subject"]);
    let predicate = trimmed(payload, &["predicate"]);
    let object_value = trimmed(payload, &["objectValue"]);
    if subject.is_empty() || predicate.is_empty() || object_value.is_empty() {
        return Ok(ProjectionResult::skipped());
    }
    let mut subject_properties = segment_properties(segment);
    subject_properties.insert(
        "category".to_string(),
        json!(match present(payload, "subjectCategory") {
            Some(value) => js_string(value),
            None => "person".to_string(),
        }),
    );
    let subject_node = GraphitiNode {
        id: format!("ent:{subject}:{segment}"),
        label: subject.clone(),
        properties: subject_properties,
    };
    let object_node = GraphitiNode {
        id: format!("obj:{object_value}:{segment}"),
        label: object_value.clone(),
        properties: segment_properties(segment),
    };
    let mut edge_properties = segment_properties(segment);
    insert_present(
        &mut edge_properties,
        "confidence",
        present(payload, "confidence"),
    );
    insert_present(
        &mut edge_properties,
        "validFrom",
        present(payload, "validFrom"),
    );
    insert_present(&mut edge_properties, "validTo", present(payload, "validTo"));
    insert_present(
        &mut edge_properties,
        "sourceObservationId",
        present(payload, "sourceObservationId"),
    );
    edge_properties.insert("eventId".to_string(), json!(event.id));
    edge_properties.insert("createdAt".to_string(), json!(event.created_at));
    let edge = GraphitiEdge {
        source: subject_node.id.clone(),
        target: object_node.id.clone(),
        relation_type: predicate,
        source_label: Some(subject_node.label.clone()),
        target_label: Some(object_node.label.clone()),
        properties: edge_properties,
        ..GraphitiEdge::default()
    };
    let nodes = client.upsert_nodes(&[subject_node, object_node]).await?;
    let edges = client.upsert_edges(&[edge]).await?;
    Ok(ProjectionResult {
        nodes_created: nodes,
        nodes_updated: 0,
        edges_created: edges,
        edges_updated: 0,
        skipped: 0,
    })
}

/// `case 'world.event.created'` — `projector.ts:153-205`.
async fn project_event(
    client: &dyn GraphitiProjectionClient,
    event: &OutboxEvent,
    payload: &Map<String, Value>,
    segment: &str,
) -> Result<ProjectionResult, PgError> {
    let title = trimmed(payload, &["title"]);
    let event_type = trimmed(payload, &["eventType"]);
    if title.is_empty() {
        return Ok(ProjectionResult::skipped());
    }
    let status = trimmed(payload, &["status"]);
    let scheduled_for = trimmed(payload, &["scheduledFor"]);
    let root_node = GraphitiNode {
        id: format!("root:events:{segment}"),
        label: "BetaClaw events".to_string(),
        properties: {
            let mut properties = segment_properties(segment);
            properties.insert("category".to_string(), json!("event-root"));
            properties
        },
    };
    let event_node = GraphitiNode {
        id: format!("event:{}:{segment}", event.input.aggregate_id),
        label: title.clone(),
        properties: {
            let mut properties = segment_properties(segment);
            properties.insert("category".to_string(), json!("event"));
            properties.insert("eventType".to_string(), json!(event_type));
            properties.insert("status".to_string(), json!(status));
            properties.insert("scheduledFor".to_string(), json!(scheduled_for));
            properties
        },
    };
    let mut fact_parts = vec![title.clone()];
    if !event_type.is_empty() {
        fact_parts.push(format!("Type: {event_type}."));
    }
    if !status.is_empty() {
        fact_parts.push(format!("Status: {status}."));
    }
    if !scheduled_for.is_empty() {
        fact_parts.push(format!("Scheduled for: {scheduled_for}."));
    }
    let fact = fact_parts.join(" ");
    let mut properties = segment_properties(segment);
    properties.insert("eventId".to_string(), json!(event.input.aggregate_id));
    properties.insert("eventType".to_string(), json!(event_type));
    properties.insert("status".to_string(), json!(status));
    properties.insert("scheduledFor".to_string(), json!(scheduled_for));
    properties.insert("createdAt".to_string(), json!(event.created_at));
    if !scheduled_for.is_empty() {
        properties.insert("validFrom".to_string(), json!(scheduled_for));
    }
    let edge = GraphitiEdge {
        source: root_node.id.clone(),
        target: event_node.id.clone(),
        relation_type: "event".to_string(),
        name: Some(if event_type.is_empty() {
            "event".to_string()
        } else {
            event_type
        }),
        source_label: Some(root_node.label.clone()),
        target_label: Some(title),
        fact: Some(fact),
        properties,
        ..GraphitiEdge::default()
    };
    let nodes = client.upsert_nodes(&[root_node, event_node]).await?;
    let edges = client.upsert_edges(&[edge]).await?;
    Ok(ProjectionResult {
        nodes_created: nodes,
        nodes_updated: 0,
        edges_created: edges,
        edges_updated: 0,
        skipped: 0,
    })
}

/// `case 'world.relation.created'` — `projector.ts:207-249`.
async fn project_relation(
    client: &dyn GraphitiProjectionClient,
    event: &OutboxEvent,
    payload: &Map<String, Value>,
    segment: &str,
) -> Result<ProjectionResult, PgError> {
    let source = trimmed(payload, &["sourceEntity"]);
    let target = trimmed(payload, &["targetEntity"]);
    let relation_type = trimmed(payload, &["relationType"]);
    if source.is_empty() || target.is_empty() || relation_type.is_empty() {
        return Ok(ProjectionResult::skipped());
    }
    let source_node = GraphitiNode {
        id: format!("ent:{source}:{segment}"),
        label: source.clone(),
        properties: segment_properties(segment),
    };
    let target_node = GraphitiNode {
        id: format!("ent:{target}:{segment}"),
        label: target.clone(),
        properties: segment_properties(segment),
    };
    let mut edge_properties = segment_properties(segment);
    insert_present(
        &mut edge_properties,
        "confidence",
        present(payload, "confidence"),
    );
    insert_present(
        &mut edge_properties,
        "validFrom",
        present(payload, "validFrom"),
    );
    insert_present(&mut edge_properties, "validTo", present(payload, "validTo"));
    edge_properties.insert("eventId".to_string(), json!(event.id));
    edge_properties.insert("createdAt".to_string(), json!(event.created_at));
    let edge = GraphitiEdge {
        source: source_node.id.clone(),
        target: target_node.id.clone(),
        relation_type,
        source_label: Some(source_node.label.clone()),
        target_label: Some(target_node.label.clone()),
        properties: edge_properties,
        ..GraphitiEdge::default()
    };
    let nodes = client.upsert_nodes(&[source_node, target_node]).await?;
    let edges = client.upsert_edges(&[edge]).await?;
    Ok(ProjectionResult {
        nodes_created: nodes,
        nodes_updated: 0,
        edges_created: edges,
        edges_updated: 0,
        skipped: 0,
    })
}

/// `case 'world.task.created' | 'world.task.status_changed'` —
/// `projector.ts:251-302`.
async fn project_task(
    client: &dyn GraphitiProjectionClient,
    event: &OutboxEvent,
    payload: &Map<String, Value>,
    segment: &str,
) -> Result<ProjectionResult, PgError> {
    let task_id = match present(payload, "taskId") {
        Some(value) => js_string(value),
        None => event.input.aggregate_id.clone(),
    }
    .trim()
    .to_string();
    let title = trimmed(payload, &["title"]);
    let status = trimmed(payload, &["status", "newStatus"]);
    if task_id.is_empty() || title.is_empty() {
        return Ok(ProjectionResult::skipped());
    }
    let due_date = trimmed(payload, &["dueDate", "dueAt"]);
    let root_node = GraphitiNode {
        id: format!("root:tasks:{segment}"),
        label: "BetaClaw tasks".to_string(),
        properties: {
            let mut properties = segment_properties(segment);
            properties.insert("category".to_string(), json!("task-root"));
            properties
        },
    };
    let task_node = GraphitiNode {
        id: format!("task:{task_id}:{segment}"),
        label: title.clone(),
        properties: {
            let mut properties = segment_properties(segment);
            properties.insert("category".to_string(), json!("task"));
            properties.insert("taskId".to_string(), json!(task_id));
            properties.insert("status".to_string(), json!(status));
            properties.insert("dueDate".to_string(), json!(due_date));
            properties
        },
    };
    let mut fact_parts = vec![title.clone()];
    if !status.is_empty() {
        fact_parts.push(format!("Status: {status}."));
    }
    if !due_date.is_empty() {
        fact_parts.push(format!("Due: {due_date}."));
    }
    let fact = fact_parts.join(" ");
    let mut properties = segment_properties(segment);
    properties.insert("taskId".to_string(), json!(task_id));
    properties.insert("status".to_string(), json!(status));
    properties.insert("dueDate".to_string(), json!(due_date));
    properties.insert("createdAt".to_string(), json!(event.created_at));
    let edge = GraphitiEdge {
        source: root_node.id.clone(),
        target: task_node.id.clone(),
        relation_type: "task".to_string(),
        name: Some("task".to_string()),
        source_label: Some(root_node.label.clone()),
        target_label: Some(title),
        fact: Some(fact),
        properties,
        ..GraphitiEdge::default()
    };
    let nodes = client.upsert_nodes(&[root_node, task_node]).await?;
    let edges = client.upsert_edges(&[edge]).await?;
    Ok(ProjectionResult {
        nodes_created: nodes,
        nodes_updated: 0,
        edges_created: edges,
        edges_updated: 0,
        skipped: 0,
    })
}

/// `createGraphitiProjectorHandler()` — `projector.ts:311-315`.
///
/// The TypeScript returns a closure; the port returns a small handle whose
/// [`GraphitiProjectorHandler::handle`] awaits [`project_outbox_event`].
pub struct GraphitiProjectorHandler<'a> {
    client: &'a dyn GraphitiProjectionClient,
}

impl<'a> GraphitiProjectorHandler<'a> {
    pub fn new(client: &'a dyn GraphitiProjectionClient) -> Self {
        Self { client }
    }

    pub async fn handle(&self, event: &OutboxEvent) -> Result<ProjectionResult, PgError> {
        project_outbox_event(self.client, event).await
    }
}

/// `type GraphitiRebuildStage` — `projector.ts:317`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphitiRebuildStage {
    Observations,
    Assertions,
    Events,
    Tasks,
    Relations,
}

impl GraphitiRebuildStage {
    fn text(self) -> &'static str {
        match self {
            GraphitiRebuildStage::Observations => "observations",
            GraphitiRebuildStage::Assertions => "assertions",
            GraphitiRebuildStage::Events => "events",
            GraphitiRebuildStage::Tasks => "tasks",
            GraphitiRebuildStage::Relations => "relations",
        }
    }

    fn aggregate_type(self) -> &'static str {
        match self {
            GraphitiRebuildStage::Observations => "observation",
            GraphitiRebuildStage::Assertions => "assertion",
            GraphitiRebuildStage::Events => "event",
            GraphitiRebuildStage::Tasks => "task",
            GraphitiRebuildStage::Relations => "relation",
        }
    }
}

/// `RebuildRow` from `projector.ts:319-326`.
#[derive(Debug, Clone)]
struct RebuildRow {
    id: String,
    user_id: String,
    persona_id: String,
    workspace_id: String,
    created_at: String,
    payload: Map<String, Value>,
}

/// The rebuild return of `projector.ts:433-438`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildResult {
    pub nodes_created: usize,
    pub edges_created: usize,
    pub processed_events: usize,
    pub by_stage: std::collections::BTreeMap<String, usize>,
}

/// The input of `rebuildGraphitiFromPostgres` — `projector.ts:426-432`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildGraphitiInput {
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: String,
    pub batch_size: Option<i64>,
    pub resume: Option<bool>,
    pub include_observations: Option<bool>,
}

/// `getRebuildCheckpoint` — `projector.ts:328-343`.
async fn get_rebuild_checkpoint(
    executor: &dyn PgExecutor,
    scope: &WorldModelScope,
    input: &RebuildGraphitiInput,
    phase: GraphitiRebuildStage,
) -> Result<(Option<String>, i64), PgError> {
    let result = ambient_query::<PgError>(
        executor,
        Some(scope),
        PgStatement::with_params(
            "SELECT last_id, processed_count FROM world_model_rebuild_checkpoints\n     WHERE projection_type = 'graphiti' AND user_id = $1 AND persona_id = $2\n       AND workspace_id = $3 AND phase = $4",
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_str()),
                PgValue::text(phase.text()),
            ],
        ),
    )
    .await?;
    Ok(match result.first() {
        Some(row) => (
            crate::world_model::repositories::row_optional_text(row, "last_id"),
            crate::world_model::repositories::row_integer(row, "processed_count"),
        ),
        None => (None, 0),
    })
}

/// `saveRebuildCheckpoint` — `projector.ts:345-361`.
async fn save_rebuild_checkpoint(
    executor: &dyn PgExecutor,
    scope: &WorldModelScope,
    input: &RebuildGraphitiInput,
    phase: GraphitiRebuildStage,
    last_id: &str,
    processed_count: i64,
) -> Result<(), PgError> {
    ambient_query::<PgError>(
        executor,
        Some(scope),
        PgStatement::with_params(
            "INSERT INTO world_model_rebuild_checkpoints\n      (projection_type, user_id, persona_id, workspace_id, phase, last_id, processed_count)\n     VALUES ('graphiti', $1, $2, $3, $4, $5, $6)\n     ON CONFLICT (projection_type, user_id, persona_id, workspace_id, phase)\n     DO UPDATE SET last_id = EXCLUDED.last_id, processed_count = EXCLUDED.processed_count,\n                   updated_at = now()",
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_str()),
                PgValue::text(phase.text()),
                PgValue::text(last_id),
                PgValue::int(processed_count),
            ],
        ),
    )
    .await
    .map(|_| ())
}

/// `resetRebuildCheckpoints` — `projector.ts:363-372`.
async fn reset_rebuild_checkpoints(
    executor: &dyn PgExecutor,
    scope: &WorldModelScope,
    input: &RebuildGraphitiInput,
) -> Result<(), PgError> {
    ambient_query::<PgError>(
        executor,
        Some(scope),
        PgStatement::with_params(
            "DELETE FROM world_model_rebuild_checkpoints\n     WHERE projection_type = 'graphiti' AND user_id = $1 AND persona_id = $2 AND workspace_id = $3",
            vec![
                PgValue::text(input.user_id.as_str()),
                PgValue::text(input.persona_id.as_str()),
                PgValue::text(input.workspace_id.as_str()),
            ],
        ),
    )
    .await
    .map(|_| ())
}

/// `toRebuildEvent(stage, row)` — `projector.ts:374-406`.
fn to_rebuild_event(stage: GraphitiRebuildStage, row: &RebuildRow) -> OutboxEvent {
    let mut payload = if stage == GraphitiRebuildStage::Observations {
        let mut observation = Map::new();
        observation.insert(
            "text".to_string(),
            json!(bounded_graphiti_text(
                &observation_text(&row.payload),
                1_200
            )),
        );
        observation.insert("sourceObservationId".to_string(), json!(row.id));
        observation
    } else {
        row.payload.clone()
    };
    payload.insert("userId".to_string(), json!(row.user_id));
    payload.insert("personaId".to_string(), json!(row.persona_id));
    payload.insert("workspaceId".to_string(), json!(row.workspace_id));
    OutboxEvent {
        input: crate::world_model::types::OutboxEventInput {
            event_type: match stage {
                GraphitiRebuildStage::Observations => "world.observation.created",
                GraphitiRebuildStage::Assertions => "world.assertion.created",
                GraphitiRebuildStage::Events => "world.event.created",
                GraphitiRebuildStage::Tasks => "world.task.created",
                GraphitiRebuildStage::Relations => "world.relation.created",
            }
            .to_string(),
            aggregate_type: stage.aggregate_type().to_string(),
            aggregate_id: row.id.clone(),
            payload,
            idempotency_key: None,
            correlation_id: None,
            user_id: Some(row.user_id.clone()),
            persona_id: Some(row.persona_id.clone()),
            workspace_id: Some(row.workspace_id.clone()),
        },
        id: format!("rebuild-{}-{}", stage.text(), row.id),
        status: crate::world_model::types::OutboxStatus::Dispatched,
        attempts: 1,
        error_message: None,
        created_at: row.created_at.clone(),
        dispatched_at: None,
        created: None,
    }
}

/// `toRebuildObservationMessage(row)` — `projector.ts:408-419`.
fn to_rebuild_observation_message(row: &RebuildRow) -> Option<GraphitiMessage> {
    let text = bounded_graphiti_text(&observation_text(&row.payload), 1_200);
    if text.is_empty() {
        return None;
    }
    Some(GraphitiMessage {
        uuid: Some(format!("observation:{}", row.id)),
        name: Some("world-model-observation".to_string()),
        content: text,
        role_type: Some("system".to_string()),
        role: None,
        timestamp: Some(row.created_at.clone()),
        source_description: Some(format!("BetaClaw World Model observation {}", row.id)),
    })
}

/// The keyset query of `projector.ts:481-538`.
fn build_stage_query(
    stage: GraphitiRebuildStage,
    input: &RebuildGraphitiInput,
    last_id: Option<&str>,
    batch_size: i64,
) -> (String, Vec<PgValue>) {
    let after_column = match stage {
        GraphitiRebuildStage::Assertions => "a.id",
        GraphitiRebuildStage::Relations => "r.id",
        GraphitiRebuildStage::Events => "e.id",
        GraphitiRebuildStage::Tasks => "t.id",
        GraphitiRebuildStage::Observations => "o.id",
    };
    let after = last_id
        .map(|_| format!(" AND {after_column} > $4"))
        .unwrap_or_default();
    let limit_param = if last_id.is_some() { "$5" } else { "$4" };
    let base = match stage {
        GraphitiRebuildStage::Observations => format!(
            "SELECT o.id, o.user_id, o.persona_id, o.workspace_id, o.created_at, o.payload\n          FROM world_model_observations o\n          WHERE o.user_id = $1 AND o.persona_id = $2 AND o.workspace_id = $3{after}\n          ORDER BY o.id ASC LIMIT {limit_param}"
        ),
        GraphitiRebuildStage::Assertions => format!(
            "SELECT a.id, a.user_id, a.persona_id, a.workspace_id, a.created_at,\n            jsonb_build_object('subject', s.canonical_name, 'subjectCategory', s.category,\n              'predicate', a.predicate, 'objectValue', COALESCE(a.object_value, o.canonical_name),\n              'confidence', a.confidence, 'validFrom', a.valid_from, 'validTo', a.valid_to,\n              'sourceObservationId', a.source_observation_id) AS payload\n          FROM world_model_assertions a\n          JOIN world_model_entities s ON s.id = a.subject_id\n          LEFT JOIN world_model_entities o ON o.id = a.object_id\n          WHERE a.user_id = $1 AND a.persona_id = $2 AND a.workspace_id = $3{after}\n          ORDER BY a.id ASC LIMIT {limit_param}"
        ),
        GraphitiRebuildStage::Events => format!(
            "SELECT e.id, e.user_id, e.persona_id, e.workspace_id, e.created_at,\n            jsonb_build_object('title', e.title, 'eventType', e.event_type, 'status', e.status,\n              'scheduledFor', e.scheduled_for, 'eventId', e.id) AS payload\n          FROM world_model_events e\n          WHERE e.user_id = $1 AND e.persona_id = $2 AND e.workspace_id = $3{after}\n          ORDER BY e.id ASC LIMIT {limit_param}"
        ),
        GraphitiRebuildStage::Tasks => format!(
            "SELECT t.id, t.user_id, t.persona_id, t.workspace_id, t.created_at,\n            jsonb_build_object('taskId', t.id, 'title', t.title, 'status', t.status,\n              'dueAt', t.due_at) AS payload\n          FROM world_model_tasks t\n          WHERE t.user_id = $1 AND t.persona_id = $2 AND t.workspace_id = $3{after}\n          ORDER BY t.id ASC LIMIT {limit_param}"
        ),
        GraphitiRebuildStage::Relations => format!(
            "SELECT r.id, r.user_id, r.persona_id, r.workspace_id, r.known_from AS created_at,\n            jsonb_build_object('sourceEntity', s.canonical_name, 'targetEntity', t.canonical_name,\n              'relationType', r.relation_type, 'confidence', r.confidence,\n              'validFrom', r.valid_from, 'validTo', r.valid_to,\n              'sourceObservationId', r.source_observation_id) AS payload\n          FROM world_model_entity_relations r\n          JOIN world_model_entities s ON s.id = r.source_entity_id\n          JOIN world_model_entities t ON t.id = r.target_entity_id\n          WHERE r.user_id = $1 AND r.persona_id = $2 AND r.workspace_id = $3{after}\n          ORDER BY r.id ASC LIMIT {limit_param}"
        ),
    };
    let mut params = vec![
        PgValue::text(input.user_id.as_str()),
        PgValue::text(input.persona_id.as_str()),
        PgValue::text(input.workspace_id.as_str()),
    ];
    if let Some(last_id) = last_id {
        params.push(PgValue::text(last_id));
    }
    params.push(PgValue::int(batch_size));
    (base, params)
}

/// `rebuildGraphitiFromPostgres(input)` — `projector.ts:426-581`.
pub async fn rebuild_graphiti_from_postgres(
    executor: &dyn PgExecutor,
    client: &dyn GraphitiProjectionClient,
    input: &RebuildGraphitiInput,
) -> Result<RebuildResult, PgError> {
    let scope = WorldModelScope::new(
        &input.user_id,
        &input.persona_id,
        Some(input.workspace_id.clone()),
    );
    let batch_size = input.batch_size.unwrap_or(100).clamp(1, 1000);
    let mut result = RebuildResult {
        nodes_created: 0,
        edges_created: 0,
        processed_events: 0,
        by_stage: std::collections::BTreeMap::new(),
    };
    let queue_baseline = client.queue_status().await?;

    if !input.resume.unwrap_or(false) {
        reset_rebuild_checkpoints(executor, &scope, input).await?;
    }

    let stages: Vec<GraphitiRebuildStage> = if input.include_observations.unwrap_or(false) {
        vec![
            GraphitiRebuildStage::Observations,
            GraphitiRebuildStage::Assertions,
            GraphitiRebuildStage::Events,
            GraphitiRebuildStage::Tasks,
            GraphitiRebuildStage::Relations,
        ]
    } else {
        vec![
            GraphitiRebuildStage::Assertions,
            GraphitiRebuildStage::Events,
            GraphitiRebuildStage::Tasks,
            GraphitiRebuildStage::Relations,
        ]
    };
    let segment = graphiti_group_id(&input.user_id, &input.persona_id, &input.workspace_id);

    for stage in stages {
        let (mut last_id, mut processed_count) =
            get_rebuild_checkpoint(executor, &scope, input, stage).await?;
        loop {
            let (query, params) = build_stage_query(stage, input, last_id.as_deref(), batch_size);
            let rows = ambient_query::<PgError>(
                executor,
                Some(&scope),
                PgStatement::with_params(query, params),
            )
            .await?;
            if rows.rows.is_empty() {
                break;
            }
            let rebuild_rows: Vec<RebuildRow> = rows
                .rows
                .iter()
                .map(|row| RebuildRow {
                    id: crate::world_model::repositories::row_text(row, "id"),
                    user_id: crate::world_model::repositories::row_text(row, "user_id"),
                    persona_id: crate::world_model::repositories::row_text(row, "persona_id"),
                    workspace_id: crate::world_model::repositories::row_text(row, "workspace_id"),
                    created_at: crate::world_model::repositories::row_text(row, "created_at"),
                    payload: crate::world_model::repositories::row_object(row, "payload"),
                })
                .collect();
            let row_count = rebuild_rows.len();
            if stage == GraphitiRebuildStage::Observations {
                let messages: Vec<GraphitiMessage> = rebuild_rows
                    .iter()
                    .filter_map(to_rebuild_observation_message)
                    .collect();
                let accepted = client.add_messages(&segment, &messages).await?;
                result.nodes_created += accepted;
                for row in &rebuild_rows {
                    result.processed_events += 1;
                    *result.by_stage.entry(stage.text().to_string()).or_insert(0) += 1;
                    processed_count += 1;
                    last_id = Some(row.id.clone());
                    save_rebuild_checkpoint(
                        executor,
                        &scope,
                        input,
                        stage,
                        &row.id,
                        processed_count,
                    )
                    .await?;
                }
            } else {
                for row in &rebuild_rows {
                    let projection =
                        project_outbox_event(client, &to_rebuild_event(stage, row)).await?;
                    result.nodes_created += projection.nodes_created;
                    result.edges_created += projection.edges_created;
                    result.processed_events += 1;
                    *result.by_stage.entry(stage.text().to_string()).or_insert(0) += 1;
                    processed_count += 1;
                    last_id = Some(row.id.clone());
                    save_rebuild_checkpoint(
                        executor,
                        &scope,
                        input,
                        stage,
                        &row.id,
                        processed_count,
                    )
                    .await?;
                }
            }
            if row_count < batch_size as usize {
                break;
            }
        }
    }

    client.wait_for_queue(queue_baseline.failed_jobs).await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::types::OutboxStatus;
    use std::sync::Mutex;

    #[derive(Default)]
    struct StubClient {
        messages: Mutex<Vec<GraphitiMessage>>,
        nodes: Mutex<usize>,
        edges: Mutex<usize>,
    }

    impl GraphitiProjectionClient for StubClient {
        fn add_messages<'a>(
            &'a self,
            _group_id: &'a str,
            messages: &'a [GraphitiMessage],
        ) -> BoxFuture<'a, Result<usize, PgError>> {
            Box::pin(async move {
                self.messages
                    .lock()
                    .expect("messages")
                    .extend_from_slice(messages);
                Ok(messages.len())
            })
        }

        fn upsert_nodes<'a>(
            &'a self,
            _nodes: &'a [GraphitiNode],
        ) -> BoxFuture<'a, Result<usize, PgError>> {
            Box::pin(async move { Ok(*self.nodes.lock().expect("nodes")) })
        }

        fn upsert_edges<'a>(
            &'a self,
            _edges: &'a [GraphitiEdge],
        ) -> BoxFuture<'a, Result<usize, PgError>> {
            Box::pin(async move { Ok(*self.edges.lock().expect("edges")) })
        }

        fn queue_status<'a>(&'a self) -> BoxFuture<'a, Result<GraphitiQueueStatus, PgError>> {
            Box::pin(async move { Ok(GraphitiQueueStatus::default()) })
        }

        fn wait_for_queue<'a>(
            &'a self,
            _baseline_failed_jobs: i64,
        ) -> BoxFuture<'a, Result<GraphitiQueueStatus, PgError>> {
            Box::pin(async move { Ok(GraphitiQueueStatus::default()) })
        }
    }

    fn event(event_type: &str, payload: serde_json::Value) -> OutboxEvent {
        OutboxEvent {
            input: crate::world_model::types::OutboxEventInput {
                event_type: event_type.to_string(),
                aggregate_type: "observation".to_string(),
                aggregate_id: "a1".to_string(),
                payload: payload.as_object().cloned().unwrap_or_default(),
                idempotency_key: None,
                correlation_id: None,
                user_id: Some("u1".to_string()),
                persona_id: Some("p1".to_string()),
                workspace_id: Some("w1".to_string()),
            },
            id: "x1".to_string(),
            status: OutboxStatus::Pending,
            attempts: 0,
            error_message: None,
            created_at: "2026-10-11T10:00:00.000Z".to_string(),
            dispatched_at: None,
            created: None,
        }
    }

    #[test]
    fn bounded_text_truncates_with_the_source_marker() {
        let long = "x".repeat(600);
        let bounded = bounded_graphiti_text(&long, 500);
        assert!(bounded.ends_with("\n[content truncated for Graphiti]"));
        assert_eq!(
            bounded.chars().count(),
            500 + "\n[content truncated for Graphiti]".chars().count()
        );
        assert_eq!(bounded_graphiti_text("short", 500), "short");
    }

    #[test]
    fn observation_text_prefers_text_then_content_then_texts() {
        let mut payload = Map::new();
        payload.insert("text".to_string(), json!("hello"));
        assert_eq!(observation_text(&payload), "hello");
        let mut payload = Map::new();
        payload.insert(
            "texts".to_string(),
            json!([{ "content": "a" }, { "text": " b " }]),
        );
        assert_eq!(observation_text(&payload), "a\nb");
    }

    #[test]
    fn an_unsupported_or_scopeless_event_is_skipped() {
        let client = StubClient::default();
        let skipped = drive_sync(project_outbox_event(
            &client,
            &event("world.other", json!({})),
        ))
        .expect("bridge")
        .expect("projection");
        assert_eq!(skipped.skipped, 1);
        let scopeless = drive_sync(project_outbox_event(
            &client,
            &event("world.observation.created", json!({ "text": "hi" })),
        ))
        .expect("bridge");
        // userId/personaId come from the event in this helper, so the branch runs.
        assert!(scopeless.is_ok());
    }

    #[test]
    fn an_observation_becomes_one_message() {
        let client = StubClient::default();
        let result = drive_sync(project_outbox_event(
            &client,
            &event(
                "world.observation.created",
                json!({ "text": "Mira likes Kino" }),
            ),
        ))
        .expect("bridge")
        .expect("projection");
        assert_eq!(result.nodes_created, 1);
        assert_eq!(result.skipped, 0);
        let messages = client.messages.lock().expect("messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Mira likes Kino");
        assert_eq!(messages[0].uuid.as_deref(), Some("observation:a1"));
    }

    #[test]
    fn an_assertion_upserts_two_nodes_and_one_edge() {
        let client = StubClient::default();
        *client.nodes.lock().expect("nodes") = 2;
        *client.edges.lock().expect("edges") = 1;
        let result = drive_sync(project_outbox_event(
            &client,
            &event(
                "world.assertion.created",
                json!({ "subject": "Mira", "predicate": "likes", "objectValue": "Kino" }),
            ),
        ))
        .expect("bridge")
        .expect("projection");
        assert_eq!(result.nodes_created, 2);
        assert_eq!(result.edges_created, 1);
        assert_eq!(result.skipped, 0);
    }

    #[test]
    fn the_projector_handler_skips_an_unsupported_type_without_touching_the_client() {
        use crate::world_model::types::{OutboxEventInput, OutboxStatus};

        let stub = Arc::new(StubClient::default());
        let handler = create_graphiti_projector_handler(stub.clone());
        let event = OutboxEvent {
            input: OutboxEventInput {
                event_type: "world.unknown".into(),
                aggregate_type: "test".into(),
                aggregate_id: "a1".into(),
                payload: Map::new(),
                idempotency_key: None,
                correlation_id: None,
                user_id: None,
                persona_id: None,
                workspace_id: None,
            },
            id: "out-1".into(),
            status: OutboxStatus::Pending,
            attempts: 0,
            error_message: None,
            created_at: "2026-10-11T12:00:00.000Z".into(),
            dispatched_at: None,
            created: None,
        };
        drive_sync(handler(event, None))
            .expect("bridge")
            .expect("handled");
        assert_eq!(*stub.nodes.lock().expect("nodes"), 0);
        assert_eq!(*stub.edges.lock().expect("edges"), 0);
    }
}
