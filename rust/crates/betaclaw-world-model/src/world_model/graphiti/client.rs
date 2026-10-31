//! Port of the retrieval-facing Graphiti REST client in `graphiti/client.ts`.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use http::Method;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::model_hub::http::{fetch_with_timeout, HttpRequest, HttpTransport};
use crate::world_model::db::PgError;
use crate::world_model::retrieval::index::{GraphitiFact, GraphitiRecall, GraphitiRecallRequest};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_MAX_RETRIES: usize = 3;
const CIRCUIT_RESET: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphitiClientConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub timeout_ms: u64,
    pub max_retries: usize,
    pub search_candidates: usize,
    pub search_results: usize,
    pub query_variants: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphitiNode {
    pub id: String,
    pub label: String,
    pub properties: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct GraphitiEdge {
    pub uuid: Option<String>,
    pub source: String,
    pub target: String,
    pub relation_type: String,
    pub source_label: Option<String>,
    pub target_label: Option<String>,
    pub name: Option<String>,
    pub fact: Option<String>,
    pub properties: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GraphitiMessage {
    pub uuid: Option<String>,
    pub name: Option<String>,
    pub content: String,
    pub role_type: Option<String>,
    pub role: Option<String>,
    pub timestamp: Option<String>,
    pub source_description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphitiHealthStatus {
    pub reachable: bool,
    pub latency_ms: u128,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GraphitiQueueStatus {
    pub pending_jobs: i64,
    pub active_jobs: i64,
    pub completed_jobs: i64,
    pub failed_jobs: i64,
    pub workers: i64,
}

impl GraphitiClientConfig {
    pub fn from_env() -> Self {
        let value = |key: &str| std::env::var(key).ok();
        let number = |key: &str, fallback: f64| {
            value(key)
                .map(|raw| crate::js::js_number_str(&raw))
                .filter(|n| *n != 0.0 && n.is_finite())
                .unwrap_or(fallback)
        };
        Self {
            base_url: value("GRAPHITI_BASE_URL")
                .unwrap_or_else(|| "http://localhost:8001".into())
                .trim_end_matches('/')
                .to_string(),
            api_key: value("GRAPHITI_API_KEY").filter(|key| !key.is_empty()),
            timeout_ms: number("GRAPHITI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS as f64).max(0.0) as u64,
            max_retries: number("GRAPHITI_MAX_RETRIES", DEFAULT_MAX_RETRIES as f64).max(1.0)
                as usize,
            search_candidates: number("GRAPHITI_SEARCH_CANDIDATES", 20.0).clamp(5.0, 100.0)
                as usize,
            search_results: number("GRAPHITI_SEARCH_RESULTS", 5.0).clamp(1.0, 50.0) as usize,
            query_variants: number("GRAPHITI_QUERY_VARIANTS", 3.0).clamp(1.0, 5.0) as usize,
        }
    }
}

#[derive(Debug, Default)]
struct CircuitState {
    opened_at: Option<Instant>,
}

fn circuit() -> &'static Mutex<CircuitState> {
    static CIRCUIT: OnceLock<Mutex<CircuitState>> = OnceLock::new();
    CIRCUIT.get_or_init(|| Mutex::new(CircuitState::default()))
}

pub fn reset_graphiti_circuit() {
    circuit().lock().expect("Graphiti circuit mutex").opened_at = None;
}

fn check_circuit() -> Result<(), PgError> {
    let mut state = circuit().lock().expect("Graphiti circuit mutex");
    if let Some(opened_at) = state.opened_at {
        if opened_at.elapsed() > CIRCUIT_RESET {
            state.opened_at = None;
        } else {
            return Err(PgError::new("[world-model:graphiti] circuit breaker open"));
        }
    }
    Ok(())
}

fn trip_circuit() {
    circuit().lock().expect("Graphiti circuit mutex").opened_at = Some(Instant::now());
}

/// `graphitiGroupId` — `graphiti/client.ts:113-116`.
pub fn graphiti_group_id(user_id: &str, persona_id: &str, workspace_id: &str) -> String {
    let canonical_scope = format!("{user_id}\0{persona_id}\0{workspace_id}");
    let digest = Sha256::digest(canonical_scope.as_bytes());
    let mut prefix = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        use std::fmt::Write;
        let _ = write!(prefix, "{byte:02x}");
    }
    format!("betaclaw-{prefix}")
}

pub struct GraphitiRestClient {
    config: GraphitiClientConfig,
    transport: Arc<dyn HttpTransport>,
}

impl GraphitiRestClient {
    pub fn new(mut config: GraphitiClientConfig, transport: Arc<dyn HttpTransport>) -> Self {
        config.base_url = config.base_url.trim_end_matches('/').to_string();
        config.max_retries = config.max_retries.max(1);
        Self { config, transport }
    }

    pub fn from_env(transport: Arc<dyn HttpTransport>) -> Self {
        Self::new(GraphitiClientConfig::from_env(), transport)
    }

    /// `searchGraphitiFacts` — `graphiti/client.ts:228-270`.
    pub async fn search(
        &self,
        group_id: &str,
        query: &str,
        max_facts: usize,
    ) -> Result<Vec<GraphitiFact>, PgError> {
        if group_id.is_empty() || query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let limit = max_facts.clamp(1, 100);
        let body = self
            .request_with_retries(
                "Graphiti fact search",
                Method::POST,
                "/search",
                Some(json!({ "group_ids": [group_id], "query": query, "max_facts": limit })),
            )
            .await?;
        let facts = if body.is_array() {
            body.as_array()
        } else {
            body.get("facts").and_then(Value::as_array)
        };
        Ok(facts
            .into_iter()
            .flatten()
            .filter_map(graphiti_fact)
            .collect())
    }

    async fn request_once(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, PgError> {
        let mut request = HttpRequest::new(method, format!("{}{}", self.config.base_url, path))
            .header("content-type", "application/json")
            .timeout_ms(self.config.timeout_ms);
        if let Some(body) = body {
            request = request.json_body(body);
        }
        if let Some(api_key) = &self.config.api_key {
            request = request.header("authorization", &format!("Bearer {api_key}"));
        }
        let response = fetch_with_timeout(self.transport.as_ref(), request)
            .await
            .map_err(|error| PgError::new(error.to_string()))?;
        if !response.status.is_success() {
            return Err(PgError::new(format!(
                "Graphiti request failed: HTTP {}{}",
                response.status.as_u16(),
                if response.status_text.is_empty() {
                    String::new()
                } else {
                    format!(" {}", response.status_text)
                }
            )));
        }
        Ok(serde_json::from_str(&response.body).unwrap_or_else(|_| json!({})))
    }

    async fn request_with_retries(
        &self,
        label: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, PgError> {
        check_circuit()?;
        let mut last_error = String::new();
        for attempt in 1..=self.config.max_retries {
            match self.request_once(method.clone(), path, body.as_ref()).await {
                Ok(value) => {
                    reset_graphiti_circuit();
                    return Ok(value);
                }
                Err(error) => {
                    last_error = error.message;
                    if attempt < self.config.max_retries {
                        tokio::time::sleep(Duration::from_millis(250 * attempt as u64)).await;
                    }
                }
            }
        }
        trip_circuit();
        Err(PgError::new(format!(
            "{label} failed after {} attempts: {last_error}",
            self.config.max_retries
        )))
    }

    /// `addGraphitiMessages` — `graphiti/client.ts:207-225`.
    pub async fn add_messages(
        &self,
        group_id: &str,
        messages: &[GraphitiMessage],
    ) -> Result<usize, PgError> {
        if group_id.is_empty() || messages.is_empty() {
            return Ok(0);
        }
        let mut seen = HashSet::new();
        let messages = messages.iter().filter(|message| {
            let key = message.uuid.as_deref().filter(|id| !id.is_empty()).map(|id| format!("uuid:{id}"))
                .unwrap_or_else(|| format!("content:{}\0{}\0{}", message.name.as_deref().unwrap_or(""), message.content, message.timestamp.as_deref().unwrap_or("")));
            seen.insert(key)
        }).map(|message| {
            let mut value = json!({
                "uuid": message.uuid,
                "name": message.name.as_deref().unwrap_or(""),
                "content": message.content,
                "role_type": message.role_type.as_deref().unwrap_or("system"),
                "role": message.role,
                "timestamp": message.timestamp.as_deref().unwrap_or(""),
                "source_description": message.source_description.as_deref().unwrap_or("BetaClaw World Model"),
            });
            if message.uuid.as_deref().filter(|id| !id.is_empty()).is_none() { value.as_object_mut().expect("object").remove("uuid"); }
            if message.timestamp.is_none() { value["timestamp"] = json!(now_iso()); }
            value
        }).collect::<Vec<_>>();
        if messages.is_empty() {
            return Ok(0);
        }
        let accepted = messages.len();
        self.request_with_retries(
            "Graphiti message ingestion",
            Method::POST,
            "/messages",
            Some(json!({"group_id":group_id,"messages":messages})),
        )
        .await?;
        Ok(accepted)
    }

    /// `checkGraphitiHealth` — `graphiti/client.ts:273-289`.
    pub async fn health(&self) -> GraphitiHealthStatus {
        let started = Instant::now();
        let result = check_circuit().map(|_| ());
        let result = match result {
            Ok(()) => self
                .request_once(Method::GET, "/healthcheck", None)
                .await
                .map(|_| ()),
            Err(error) => Err(error),
        };
        if result.is_ok() {
            reset_graphiti_circuit();
        }
        GraphitiHealthStatus {
            reachable: result.is_ok(),
            latency_ms: started.elapsed().as_millis(),
            error: result.err().map(|error| error.message),
        }
    }

    /// `getGraphitiQueueStatus` — `graphiti/client.ts:291-309`.
    pub async fn queue_status(&self) -> Result<GraphitiQueueStatus, PgError> {
        let body = self
            .request_with_retries("Graphiti queue status", Method::GET, "/queue-status", None)
            .await?;
        let number = |key: &str| body.get(key).map(js_number).unwrap_or(0.0) as i64;
        Ok(GraphitiQueueStatus {
            pending_jobs: number("pending_jobs"),
            active_jobs: number("active_jobs"),
            completed_jobs: number("completed_jobs"),
            failed_jobs: number("failed_jobs"),
            workers: number("workers"),
        })
    }

    /// `waitForGraphitiQueue` — `graphiti/client.ts:311-339`.
    pub async fn wait_for_queue(
        &self,
        timeout_ms: Option<u64>,
        poll_ms: Option<u64>,
        baseline_failed_jobs: Option<i64>,
    ) -> Result<GraphitiQueueStatus, PgError> {
        let timeout = timeout_ms
            .map(|value| value as f64)
            .or_else(|| {
                std::env::var("GRAPHITI_QUEUE_DRAIN_TIMEOUT_MS")
                    .ok()
                    .map(|value| crate::js::js_number_str(&value))
            })
            .filter(|value| *value != 0.0 && !value.is_nan())
            .unwrap_or(600_000.0)
            .max(10_000.0);
        let timeout_ms = timeout as u64;
        let poll_ms = poll_ms.unwrap_or(1_000).max(250);
        let started = Instant::now();
        let initial = self.queue_status().await?;
        let baseline = baseline_failed_jobs.unwrap_or(initial.failed_jobs);
        while started.elapsed() <= Duration::from_millis(timeout_ms) {
            let status = self.queue_status().await?;
            if status.pending_jobs == 0 && status.active_jobs == 0 {
                if status.failed_jobs > baseline {
                    return Err(PgError::new(format!(
                        "Graphiti queue drained with {} failed job(s).",
                        status.failed_jobs - baseline
                    )));
                }
                return Ok(status);
            }
            tokio::time::sleep(Duration::from_millis(poll_ms)).await;
        }
        Err(PgError::new(format!(
            "Graphiti queue did not drain within {timeout_ms}ms."
        )))
    }

    /// `upsertGraphitiNodes` — `graphiti/client.ts:342-363`.
    pub async fn upsert_nodes(&self, nodes: &[GraphitiNode]) -> Result<usize, PgError> {
        for node in nodes {
            let summary = node
                .properties
                .get("summary")
                .filter(|value| !value.is_null())
                .or_else(|| node.properties.get("text"))
                .filter(|value| !value.is_null())
                .map(js_string)
                .unwrap_or_else(|| node.label.clone());
            let group_id = node
                .properties
                .get("segment")
                .filter(|value| !value.is_null())
                .map(js_string)
                .unwrap_or_else(|| "betaclaw".into());
            self.request_with_retries(
                &format!("Graphiti node {}", node.id),
                Method::POST,
                "/entity-node",
                Some(
                    json!({"uuid":node.id,"group_id":group_id,"name":node.label,"summary":summary}),
                ),
            )
            .await?;
        }
        Ok(nodes.len())
    }

    /// `upsertGraphitiEdges` — `graphiti/client.ts:379-418`.
    pub async fn upsert_edges(&self, edges: &[GraphitiEdge]) -> Result<usize, PgError> {
        let mut count = 0;
        for edge in edges {
            let group = edge
                .properties
                .get("segment")
                .filter(|value| !value.is_null())
                .map(js_string)
                .unwrap_or_default();
            if group.is_empty() {
                continue;
            }
            let uuid = edge.uuid.clone().unwrap_or_else(|| {
                format!(
                    "edge:{}",
                    graphiti_hex_prefix(
                        &Sha256::digest(
                            format!("{}\0{}\0{}", edge.source, edge.relation_type, edge.target)
                                .as_bytes()
                        ),
                        32
                    )
                )
            });
            let fact = relation_episode_content(edge);
            let mut attributes = edge.properties.clone();
            for key in ["segment", "validFrom", "validTo", "createdAt"] {
                attributes.remove(key);
            }
            let mut payload = json!({"uuid":uuid,"group_id":group,"source_node_uuid":edge.source,"target_node_uuid":edge.target,"name":edge.name.as_deref().unwrap_or(&edge.relation_type),"fact":fact,"created_at":edge.properties.get("createdAt").filter(|value| !value.is_null()).map(js_string).filter(|s|!s.trim().is_empty()).unwrap_or_else(now_iso),"attributes":attributes});
            if let Some(value) = edge
                .properties
                .get("validFrom")
                .filter(|value| !value.is_null())
                .map(js_string)
                .filter(|s| !s.trim().is_empty())
            {
                payload["valid_at"] = json!(value);
            }
            if let Some(value) = edge
                .properties
                .get("validTo")
                .filter(|value| !value.is_null())
                .map(js_string)
                .filter(|s| !s.trim().is_empty())
            {
                payload["invalid_at"] = json!(value);
            }
            self.request_with_retries(
                &format!("Graphiti edge {uuid}"),
                Method::POST,
                "/entity-edge",
                Some(payload),
            )
            .await?;
            count += 1;
        }
        Ok(count)
    }

    /// `clearGraphitiScope` — `graphiti/client.ts:472-483`.
    pub async fn clear_scope(
        &self,
        user_id: &str,
        persona_id: &str,
        workspace_id: &str,
    ) -> Result<(), PgError> {
        let group = graphiti_group_id(user_id, persona_id, workspace_id);
        self.request_with_retries(
            &format!("Graphiti group {group} deletion"),
            Method::DELETE,
            &format!("/group/{}", encode_component(&group)),
            None,
        )
        .await?;
        Ok(())
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn graphiti_hex_prefix(bytes: &[u8], digits: usize) -> String {
    let mut output = String::with_capacity(digits);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
        if output.len() >= digits {
            output.truncate(digits);
            break;
        }
    }
    output
}

fn encode_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::Array(values) => values
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(v) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(v) => v.as_f64().unwrap_or(f64::NAN),
        Value::String(v) => crate::js::js_number_str(v),
        _ => f64::NAN,
    }
}

fn relation_episode_content(edge: &GraphitiEdge) -> String {
    if let Some(fact) = edge.fact.as_deref().filter(|fact| !fact.trim().is_empty()) {
        return fact.trim().into();
    }
    let source = edge
        .source_label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&edge.source);
    let target = edge
        .target_label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&edge.target);
    let mut humanized = String::new();
    for character in edge.relation_type.trim().chars() {
        if character.is_uppercase() && humanized.chars().last().is_some_and(char::is_lowercase) {
            humanized.push(' ');
        }
        humanized.push(if character == '_' || character == '-' {
            ' '
        } else {
            character
        });
    }
    let relation = humanized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let phrase = if relation.starts_with("responsible ") {
        format!("is {relation}")
    } else if [
        "is ", "has ", "can ", "works ", "lives ", "located ", "likes ", "knows ", "manages ",
        "uses ", "prefers ",
    ]
    .iter()
    .any(|prefix| relation.starts_with(prefix))
    {
        relation
    } else {
        format!("has relation \"{relation}\" to")
    };
    let metadata = edge
        .properties
        .iter()
        .filter(|(key, value)| {
            ![
                "segment",
                "sourceObservationId",
                "eventId",
                "createdAt",
                "validFrom",
                "validTo",
            ]
            .contains(&key.as_str())
                && !value.is_null()
                && **value != json!("")
        })
        .map(|(key, value)| format!("{key}={}", js_string(value)))
        .collect::<Vec<_>>()
        .join("; ");
    format!(
        "\"{source}\" {phrase} \"{target}\".{}",
        if metadata.is_empty() {
            String::new()
        } else {
            format!(" Structured metadata: {metadata}.")
        }
    )
}

fn optional_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn graphiti_fact(value: &Value) -> Option<GraphitiFact> {
    if !value.is_object() {
        return None;
    }
    let fact = js_string(
        value
            .get("fact")
            .filter(|fact| !fact.is_null())
            .unwrap_or(&Value::String(String::new())),
    )
    .trim()
    .to_string();
    if fact.is_empty() {
        return None;
    }
    Some(GraphitiFact {
        uuid: optional_field(value, "uuid"),
        name: optional_field(value, "name"),
        fact,
        valid_at: optional_field(value, "valid_at"),
        invalid_at: optional_field(value, "invalid_at"),
        source_node_uuid: optional_field(value, "source_node_uuid"),
        target_node_uuid: optional_field(value, "target_node_uuid"),
    })
}

impl GraphitiRecall for GraphitiRestClient {
    fn group_id(&self, user_id: &str, persona_id: &str, workspace_id: &str) -> String {
        graphiti_group_id(user_id, persona_id, workspace_id)
    }

    fn search_with_rerank<'a>(
        &'a self,
        group_id: &'a str,
        request: GraphitiRecallRequest<'a>,
        max_results: i64,
    ) -> crate::world_model::db::BoxFuture<'a, Result<Vec<GraphitiFact>, PgError>> {
        Box::pin(async move {
            let max_results = max_results.clamp(1, 50) as usize;
            let candidates = self.config.search_candidates;
            let variants = super::retrieval::build_query_variants(
                request.text,
                request.terms,
                self.config.query_variants,
            );
            let mut facts = Vec::new();
            for query in variants {
                facts.extend(self.search(group_id, &query, candidates).await?);
            }
            Ok(
                super::retrieval::rank_facts(request.text, request.terms, facts)
                    .into_iter()
                    .filter(|ranked| {
                        ranked.score >= if ranked.focus_matches >= 2 { 0.3 } else { 0.45 }
                    })
                    .take(max_results)
                    .map(|ranked| ranked.fact)
                    .collect(),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::http::{BoxFuture, HttpError, HttpResponse};
    use http::StatusCode;
    use std::collections::VecDeque;

    #[derive(Default)]
    struct ScriptTransport {
        responses: Mutex<VecDeque<Result<HttpResponse, HttpError>>>,
        requests: Mutex<Vec<HttpRequest>>,
    }

    impl HttpTransport for ScriptTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.requests.lock().expect("requests").push(request);
            let response = self
                .responses
                .lock()
                .expect("responses")
                .pop_front()
                .unwrap_or_else(|| Err(HttpError::Transport("no response".into())));
            Box::pin(async move { response })
        }
    }

    #[tokio::test]
    async fn search_posts_scoped_payload_and_maps_the_fact_shape() {
        reset_graphiti_circuit();
        let transport = Arc::new(ScriptTransport::default());
        transport.responses.lock().expect("responses").push_back(Ok(HttpResponse::json(
            StatusCode::OK,
            &json!({"facts":[{"uuid":"f1","name":"Mira","fact":"  Mira geht ins Kino  ","valid_at":"2026-10-11T10:00:00Z","source_node_uuid":"n1"},{"fact":" "},null]}),
        )));
        let client = GraphitiRestClient::new(
            GraphitiClientConfig {
                base_url: "http://graphiti:8001/".into(),
                api_key: Some("secret".into()),
                timeout_ms: 1000,
                max_retries: 1,
                search_candidates: 20,
                search_results: 5,
                query_variants: 3,
            },
            transport.clone(),
        );
        let facts = client.search("group-1", "Kino", 250).await.expect("search");
        assert_eq!(
            facts,
            vec![GraphitiFact {
                uuid: Some("f1".into()),
                name: Some("Mira".into()),
                fact: "Mira geht ins Kino".into(),
                valid_at: Some("2026-10-11T10:00:00Z".into()),
                invalid_at: None,
                source_node_uuid: Some("n1".into()),
                target_node_uuid: None,
            }]
        );
        let requests = transport.requests.lock().expect("requests");
        assert_eq!(requests[0].url, "http://graphiti:8001/search");
        assert_eq!(
            requests[0].headers.get("authorization").unwrap(),
            "Bearer secret"
        );
        assert_eq!(
            serde_json::from_str::<Value>(requests[0].body.as_deref().unwrap()).unwrap(),
            json!({"group_ids":["group-1"],"query":"Kino","max_facts":100})
        );
    }

    #[test]
    fn group_ids_are_deterministic_and_include_the_workspace_scope() {
        let first = graphiti_group_id("u", "p", "w");
        assert_eq!(first, graphiti_group_id("u", "p", "w"));
        assert!(first.starts_with("betaclaw-") && first.len() == 41);
        assert_ne!(first, graphiti_group_id("u", "p", ""));
    }

    #[tokio::test]
    async fn writes_deduplicate_messages_and_map_nodes_and_edges() {
        reset_graphiti_circuit();
        let transport = Arc::new(ScriptTransport::default());
        for _ in 0..3 {
            transport
                .responses
                .lock()
                .expect("responses")
                .push_back(Ok(HttpResponse::json(
                    StatusCode::OK,
                    &json!({"success":true}),
                )));
        }
        let client = GraphitiRestClient::new(
            GraphitiClientConfig {
                base_url: "http://graphiti:8001".into(),
                api_key: None,
                timeout_ms: 1000,
                max_retries: 1,
                search_candidates: 20,
                search_results: 5,
                query_variants: 3,
            },
            transport.clone(),
        );
        let message = GraphitiMessage {
            uuid: Some("m1".into()),
            content: "Hallo".into(),
            ..GraphitiMessage::default()
        };
        assert_eq!(
            client
                .add_messages("g1", &[message.clone(), message])
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            client
                .upsert_nodes(&[GraphitiNode {
                    id: "n1".into(),
                    label: "Mira".into(),
                    properties: [
                        ("segment".into(), json!("g1")),
                        ("summary".into(), json!("Kundin"))
                    ]
                    .into_iter()
                    .collect(),
                }])
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            client
                .upsert_edges(&[GraphitiEdge {
                    source: "n1".into(),
                    target: "n2".into(),
                    relation_type: "knows".into(),
                    source_label: Some("Mira".into()),
                    target_label: Some("Kai".into()),
                    properties: [
                        ("segment".into(), json!("g1")),
                        ("confidence".into(), json!(0.9))
                    ]
                    .into_iter()
                    .collect(),
                    ..GraphitiEdge::default()
                }])
                .await
                .unwrap(),
            1
        );

        let requests = transport.requests.lock().expect("requests");
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].url, "http://graphiti:8001/messages");
        assert_eq!(
            serde_json::from_str::<Value>(requests[0].body.as_deref().unwrap()).unwrap()
                ["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(requests[1].url, "http://graphiti:8001/entity-node");
        assert_eq!(
            serde_json::from_str::<Value>(requests[1].body.as_deref().unwrap()).unwrap()["summary"],
            "Kundin"
        );
        assert_eq!(requests[2].url, "http://graphiti:8001/entity-edge");
        let edge = serde_json::from_str::<Value>(requests[2].body.as_deref().unwrap()).unwrap();
        assert_eq!(
            edge["fact"],
            "\"Mira\" has relation \"knows\" to \"Kai\". Structured metadata: confidence=0.9."
        );
        assert_eq!(edge["attributes"]["confidence"], 0.9);
    }

    #[tokio::test]
    async fn health_and_queue_status_match_the_rest_endpoints() {
        reset_graphiti_circuit();
        let transport = Arc::new(ScriptTransport::default());
        transport.responses.lock().expect("responses").extend([
            Ok(HttpResponse::json(StatusCode::OK, &json!({"status":"ok"}))),
            Ok(HttpResponse::json(
                StatusCode::OK,
                &json!({
                    "pending_jobs": 2, "active_jobs": 1, "completed_jobs": 4,
                    "failed_jobs": 3, "workers": 2
                }),
            )),
        ]);
        let client = GraphitiRestClient::new(
            GraphitiClientConfig {
                base_url: "http://graphiti:8001".into(),
                api_key: None,
                timeout_ms: 1000,
                max_retries: 1,
                search_candidates: 20,
                search_results: 5,
                query_variants: 3,
            },
            transport.clone(),
        );
        assert!(client.health().await.reachable);
        assert_eq!(
            client.queue_status().await.unwrap(),
            GraphitiQueueStatus {
                pending_jobs: 2,
                active_jobs: 1,
                completed_jobs: 4,
                failed_jobs: 3,
                workers: 2,
            }
        );
        let requests = transport.requests.lock().expect("requests");
        assert_eq!(requests[0].url, "http://graphiti:8001/healthcheck");
        assert_eq!(requests[1].url, "http://graphiti:8001/queue-status");
    }
}
