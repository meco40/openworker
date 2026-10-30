//! Port of `app/api/knowledge/graph/route.ts` (GET).
//!
//! The reads are the batch methods of the entity repository (`listEntities`,
//! `getAliasCountsByEntityIds`, `listRelationsByEntityIds`), which the TypeScript
//! takes when the repository offers them. Only these three reads are wired here.
//! The rest of `KnowledgeRepository` has no SQLite implementation in Rust yet, so
//! it is not part of this family.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use axum::extract::{Extension, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use betaclaw_core::knowledge::entity_graph::{EntityGraphFilter, EntityRelation};
use betaclaw_core::knowledge::repositories::EntityRepository;
use betaclaw_core::stats::util::now_iso;
use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::auth::Caller;
use super::params::{bounded_int, query_value};
use super::{error_response, Services};
use crate::auth_gate::unauthorized_response;
use crate::proxy::proxy_to_upstream;
use crate::state::SharedState;

const DEFAULT_NODE_LIMIT: i64 = 250;
const MAX_NODE_LIMIT: i64 = 500;
const DEFAULT_EDGE_LIMIT: i64 = 2_000;
const MAX_EDGE_LIMIT: i64 = 5_000;

/// The knowledge tables, on `KNOWLEDGE_DB_PATH || MESSAGES_DB_PATH`.
pub(super) struct KnowledgeStore {
    connection: Mutex<Connection>,
}

impl KnowledgeStore {
    pub(super) fn new(connection: Connection) -> Self {
        Self {
            connection: Mutex::new(connection),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

pub fn router() -> Router<SharedState> {
    Router::new().route(
        "/api/knowledge/graph",
        get(graph).fallback(proxy_to_upstream),
    )
}

/// `GET /api/knowledge/graph?personaId=&limit=&edgeLimit=`.
async fn graph(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(caller) = Caller::from_request(&state, &headers) else {
        return unauthorized_response();
    };
    let started = Instant::now();
    let query = query.as_deref();

    let persona_id = query_value(query, "personaId")
        .unwrap_or_default()
        .trim()
        .to_string();
    if persona_id.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "personaId is required.");
    }
    let Some(node_limit) = bounded_int(
        query_value(query, "limit").as_deref(),
        DEFAULT_NODE_LIMIT,
        1,
        MAX_NODE_LIMIT,
    ) else {
        return error_response(StatusCode::BAD_REQUEST, "limit must be a number.");
    };
    let Some(edge_limit) = bounded_int(
        query_value(query, "edgeLimit").as_deref(),
        DEFAULT_EDGE_LIMIT,
        1,
        MAX_EDGE_LIMIT,
    ) else {
        return error_response(StatusCode::BAD_REQUEST, "edgeLimit must be a number.");
    };

    let filter = EntityGraphFilter {
        user_id: caller.user_id.clone(),
        persona_id,
        category: None,
        owner: None,
    };
    let built = {
        let connection = services.knowledge.lock();
        build_graph(&connection, &filter, node_limit, edge_limit)
    };
    match built {
        Ok(graph) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            tracing::info!(
                event = "knowledge_graph_response",
                node_count = graph.nodes.len(),
                edge_count = graph.edges.len(),
                node_limit,
                edge_limit,
                node_truncated = graph.node_truncated,
                edge_truncated = graph.edge_truncated,
                duration_ms,
            );
            let node_count = graph.nodes.len();
            let edge_count = graph.edges.len();
            Json(json!({
                "ok": true,
                "graph": { "nodes": graph.nodes, "edges": graph.edges },
                "stats": {
                    "nodes": node_count,
                    "edges": edge_count,
                    "categories": graph.categories,
                    "truncated": graph.node_truncated || graph.edge_truncated,
                },
                "meta": { "durationMs": duration_ms, "generatedAt": now_iso() },
            }))
            .into_response()
        }
        Err(message) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

struct GraphParts {
    nodes: Vec<Value>,
    edges: Vec<Value>,
    categories: Map<String, Value>,
    node_truncated: bool,
    edge_truncated: bool,
}

/// The node and edge sets of the response. A relation is an edge only when both
/// ends are nodes and it does not point to itself. Relations that share an edge id
/// collapse into one, as the TypeScript `Map` does.
fn build_graph(
    connection: &Connection,
    filter: &EntityGraphFilter,
    node_limit: i64,
    edge_limit: i64,
) -> Result<GraphParts, String> {
    let repository = EntityRepository::new(connection);
    let probed = repository
        .list_entities(filter, Some(node_limit + 1))
        .map_err(|error| error.to_string())?;
    let node_truncated = probed.len() as i64 > node_limit;
    let entities: Vec<_> = probed.into_iter().take(node_limit as usize).collect();

    let ids: Vec<String> = entities.iter().map(|entity| entity.id.clone()).collect();
    let alias_counts = repository
        .get_alias_counts_by_entity_ids(&ids)
        .map_err(|error| error.to_string())?;
    let relations = repository
        .list_relations_by_entity_ids(&ids)
        .map_err(|error| error.to_string())?;

    let mut nodes = Vec::with_capacity(entities.len());
    let mut categories = Map::new();
    for entity in &entities {
        let category = entity.category.as_str();
        nodes.push(json!({
            "id": entity.id,
            "label": entity.canonical_name,
            "category": category,
            "owner": entity.owner.as_str(),
            "aliasCount": alias_counts.get(&entity.id).copied().unwrap_or(0),
        }));
        let count = categories
            .get(category)
            .and_then(Value::as_i64)
            .unwrap_or(0)
            + 1;
        categories.insert(category.to_string(), json!(count));
    }

    let deduped = dedupe_by_edge_id(relations);
    let node_ids: HashSet<&str> = entities.iter().map(|entity| entity.id.as_str()).collect();
    let scoped: Vec<&EntityRelation> = deduped
        .iter()
        .filter(|relation| {
            node_ids.contains(relation.source_entity_id.as_str())
                && node_ids.contains(relation.target_entity_id.as_str())
                && relation.source_entity_id != relation.target_entity_id
        })
        .collect();
    let edge_truncated = scoped.len() as i64 > edge_limit;
    let edges: Vec<Value> = scoped
        .iter()
        .take(edge_limit as usize)
        .map(|relation| {
            json!({
                "id": edge_id(relation),
                "source": relation.source_entity_id,
                "target": relation.target_entity_id,
                "relationType": relation.relation_type,
                "confidence": relation.confidence,
            })
        })
        .collect();

    Ok(GraphParts {
        nodes,
        edges,
        categories,
        node_truncated,
        edge_truncated,
    })
}

/// Keeps the first position of each edge id and the last value, as `Map.set` does.
fn dedupe_by_edge_id(relations: Vec<EntityRelation>) -> Vec<EntityRelation> {
    let mut position: HashMap<String, usize> = HashMap::new();
    let mut unique: Vec<EntityRelation> = Vec::new();
    for relation in relations {
        let key = edge_id(&relation);
        match position.get(&key) {
            Some(&index) => unique[index] = relation,
            None => {
                position.insert(key, unique.len());
                unique.push(relation);
            }
        }
    }
    unique
}

/// `normalizeEdgeId`: the trimmed relation id, else `source:type:target`.
fn edge_id(relation: &EntityRelation) -> String {
    let id = relation.id.trim();
    if id.is_empty() {
        format!(
            "{}:{}:{}",
            relation.source_entity_id, relation.relation_type, relation.target_entity_id
        )
    } else {
        id.to_string()
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Method;
    use betaclaw_core::knowledge::entity_graph::{EntityCategory, EntityOwner};
    use betaclaw_core::knowledge::repository::{
        AddEntityRelationInput, UpsertKnowledgeEntityInput,
    };

    use super::super::test_support::{app, assert_keys, send, services_in, state_in, Scratch};
    use super::*;

    const OWNER: &str = "user-1";
    const PERSONA: &str = "persona-1";

    fn seed(services: &Services) {
        let connection = services.knowledge.lock();
        let repository = EntityRepository::new(&connection);
        for (id, name) in [("e-anna", "Anna"), ("e-berlin", "Berlin")] {
            repository
                .upsert_entity(&UpsertKnowledgeEntityInput {
                    id: id.to_string(),
                    user_id: OWNER.to_string(),
                    persona_id: PERSONA.to_string(),
                    canonical_name: name.to_string(),
                    category: if id == "e-anna" {
                        EntityCategory::Person
                    } else {
                        EntityCategory::Place
                    },
                    owner: EntityOwner::Persona,
                    properties: Map::new(),
                })
                .expect("entity");
        }
        repository
            .add_relation(&AddEntityRelationInput {
                source_entity_id: "e-anna".to_string(),
                target_entity_id: "e-berlin".to_string(),
                relation_type: "lives_in".to_string(),
                properties: Map::new(),
                confidence: 0.9,
            })
            .expect("relation");
    }

    #[tokio::test]
    async fn graph_validates_the_query_and_requires_a_caller() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, false);
        let services = services_in(&scratch);
        let router = app(&state, &services);

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/knowledge/graph?personaId=p",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/knowledge/graph?personaId=%20",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "personaId is required.");

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/knowledge/graph?personaId=p&limit=many",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "limit must be a number.");

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/knowledge/graph?personaId=p&edgeLimit=x",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "edgeLimit must be a number.");
    }

    #[tokio::test]
    async fn graph_returns_the_persona_scoped_nodes_and_edges() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, false);
        let services = services_in(&scratch);
        let router = app(&state, &services);
        seed(&services);

        let (status, body) = send(
            &router,
            Method::GET,
            &format!("/api/knowledge/graph?personaId={PERSONA}"),
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["graph", "meta", "ok", "stats"]);
        assert_eq!(body["graph"]["nodes"].as_array().expect("nodes").len(), 2);
        let edge = &body["graph"]["edges"][0];
        assert_eq!(edge["relationType"], "lives_in");
        assert_eq!(edge["source"], "e-anna");
        assert_keys(
            edge,
            &["confidence", "id", "relationType", "source", "target"],
        );
        assert_eq!(body["stats"]["categories"]["person"], 1);
        assert_eq!(body["stats"]["categories"]["place"], 1);
        assert_eq!(body["stats"]["truncated"], false);

        let (status, body) = send(
            &router,
            Method::GET,
            "/api/knowledge/graph?personaId=someone-else",
            Some(OWNER),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["graph"]["nodes"].as_array().expect("nodes").len(), 0);
    }
}
