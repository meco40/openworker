//! Ports `app/api/events/route.ts` (GET: the live feed, POST: a manual event) and
//! `app/api/events/stream/route.ts` (GET: the SSE stream).
//!
//! The feed and the manual event read and write the `events` table of the main
//! database, with `agents` and `tasks` joined for the names. The access rules are
//! those of `src/server/auth/workspaceAccess.ts`, in `auth.rs`. The stream fans
//! events out through [`super::sse`].

use std::collections::HashSet;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Extension, RawQuery, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use betaclaw_core::stats::util::{js_parse_int, js_truthy, now_iso};
use rusqlite::types::Value as SqlValue;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use super::auth::Caller;
use super::params::{non_empty, query_value};
use super::sse::{frame_stream, EventFilter, SseEvent};
use super::{MainStore, Services};
use crate::auth_gate::unauthorized_response;
use crate::proxy::proxy_to_upstream;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/api/events",
            get(list_events)
                .post(create_event)
                .fallback(proxy_to_upstream),
        )
        .route(
            "/api/events/stream",
            get(stream).fallback(proxy_to_upstream),
        )
}

/// `{ "error": message }`. The events routes answer without the `ok` key.
fn events_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// `GET /api/events?limit=&since=`: the live feed, newest first.
async fn list_events(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(caller) = Caller::from_request(&state, &headers) else {
        return unauthorized_response();
    };
    let query = query.as_deref();
    let raw_limit = non_empty(query_value(query, "limit")).unwrap_or_else(|| "50".to_string());
    // `parseInt` of a non-numeric limit gives NaN, which SQLite rejects as LIMIT NULL.
    let Some(limit) = js_parse_int(&raw_limit) else {
        return events_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch events");
    };
    let since = non_empty(query_value(query, "since"));
    match feed(&services.main, &caller, since.as_deref(), limit) {
        Ok(rows) => Json(Value::Array(rows)).into_response(),
        Err(error) => {
            tracing::error!(%error, "Failed to fetch events");
            events_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch events")
        }
    }
}

/// The events of the caller's workspaces, plus the events that belong to no
/// agent or task.
fn feed(
    main: &MainStore,
    caller: &Caller,
    since: Option<&str>,
    limit: i64,
) -> rusqlite::Result<Vec<Value>> {
    let workspaces = main.accessible_workspace_ids(caller)?;
    if workspaces.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; workspaces.len()].join(", ");
    let mut sql = format!(
        "SELECT e.id, e.type, e.agent_id, e.task_id, e.message, e.metadata, e.created_at,
                a.name AS agent_name, a.avatar_emoji AS agent_emoji, t.title AS task_title
         FROM events e
         LEFT JOIN agents a ON e.agent_id = a.id
         LEFT JOIN tasks t ON e.task_id = t.id
         WHERE (
           (e.task_id IS NULL AND e.agent_id IS NULL)
           OR t.workspace_id IN ({placeholders})
           OR a.workspace_id IN ({placeholders})
         )"
    );
    let mut params: Vec<SqlValue> = workspaces
        .iter()
        .chain(workspaces.iter())
        .map(|id| SqlValue::Text(id.clone()))
        .collect();
    if let Some(since) = since {
        sql.push_str(" AND e.created_at > ?");
        params.push(SqlValue::Text(since.to_string()));
    }
    sql.push_str(" ORDER BY e.created_at DESC LIMIT ?");
    params.push(SqlValue::Integer(limit));

    let connection = main.lock();
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(params), event_row)?;
    rows.collect()
}

/// One feed row. The column indexes follow the SELECT of [`feed`].
fn event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let text = |index: usize| row.get::<_, Option<String>>(index);
    let agent_id = text(2)?;
    let task_id = text(3)?;
    let agent_name = text(7)?;
    let agent_emoji = text(8)?;
    let task_title = text(9)?;

    let mut event = Map::new();
    event.insert("id".into(), json!(text(0)?));
    event.insert("type".into(), json!(text(1)?));
    event.insert("agent_id".into(), json!(agent_id));
    event.insert("task_id".into(), json!(task_id));
    event.insert("message".into(), json!(text(4)?));
    event.insert("metadata".into(), json!(text(5)?));
    event.insert("created_at".into(), json!(text(6)?));
    event.insert("agent_name".into(), json!(agent_name));
    event.insert("agent_emoji".into(), json!(agent_emoji));
    event.insert("task_title".into(), json!(task_title));
    if non_empty_ref(&agent_id) {
        event.insert(
            "agent".into(),
            json!({ "id": agent_id, "name": agent_name, "avatar_emoji": agent_emoji }),
        );
    }
    if non_empty_ref(&task_id) {
        event.insert("task".into(), json!({ "id": task_id, "title": task_title }));
    }
    Ok(Value::Object(event))
}

fn non_empty_ref(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|text| !text.is_empty())
}

/// The body of `POST /api/events`.
struct NewEvent {
    event_type: Value,
    message: Value,
    agent_id: Option<String>,
    task_id: Option<String>,
    metadata: Option<Value>,
}

/// `POST /api/events`. Body: `{ type, message, agent_id?, task_id?, metadata? }`.
async fn create_event(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(caller) = Caller::from_request(&state, &headers) else {
        return unauthorized_response();
    };
    let body: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return events_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create event"),
    };
    // `body.type` on `null` throws in the TypeScript, which answers 500.
    if body.is_null() {
        return events_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to create event");
    }
    if !js_truthy(body.get("type")) || !js_truthy(body.get("message")) {
        return events_error(StatusCode::BAD_REQUEST, "Type and message are required");
    }
    let input = NewEvent {
        event_type: body["type"].clone(),
        message: body["message"].clone(),
        agent_id: body
            .get("agent_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        task_id: body
            .get("task_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        metadata: body
            .get("metadata")
            .cloned()
            .filter(|value| js_truthy(Some(value))),
    };
    match insert_event(&services.main, &caller, &input) {
        Ok(created) => (StatusCode::CREATED, Json(created)).into_response(),
        Err((status, message)) => events_error(status, message),
    }
}

type EventFailure = (StatusCode, &'static str);

/// The checks of the TypeScript route, in its order, then the insert. A failed
/// write answers 500, the message the TypeScript route gives.
fn insert_event(
    main: &MainStore,
    caller: &Caller,
    input: &NewEvent,
) -> Result<Value, EventFailure> {
    let internal: EventFailure = (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create event");
    let agent = input.agent_id.as_deref().filter(|value| !value.is_empty());
    let task = input.task_id.as_deref().filter(|value| !value.is_empty());

    if let Some(agent) = agent {
        if !main.can_access_agent(caller, agent).map_err(|_| internal)? {
            return Err((StatusCode::NOT_FOUND, "Agent not found"));
        }
    }
    if let Some(task) = task {
        if !main.can_access_task(caller, task).map_err(|_| internal)? {
            return Err((StatusCode::NOT_FOUND, "Task not found"));
        }
    }
    if let (Some(agent), Some(task)) = (agent, task) {
        let agent_workspace = main.workspace_of_agent(agent).map_err(|_| internal)?;
        let task_workspace = main.workspace_of_task(task).map_err(|_| internal)?;
        if agent_workspace.is_none() || agent_workspace != task_workspace {
            return Err((StatusCode::BAD_REQUEST, "Agent and task workspace mismatch"));
        }
    }

    let event_type = sql_scalar(&input.event_type).ok_or(internal)?;
    let message = sql_scalar(&input.message).ok_or(internal)?;
    let metadata = match &input.metadata {
        Some(value) => Some(serde_json::to_string(value).map_err(|_| internal)?),
        None => None,
    };
    let id = Uuid::new_v4().to_string();
    let created_at = now_iso();
    main.lock()
        .execute(
            "INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                id,
                event_type,
                input.agent_id,
                input.task_id,
                message,
                metadata,
                created_at
            ],
        )
        .map_err(|_| internal)?;

    Ok(json!({
        "id": id,
        "type": input.event_type,
        "message": input.message,
        "created_at": created_at,
    }))
}

/// A JSON scalar as better-sqlite3 binds it: strings and numbers. Other values make
/// the TypeScript insert throw, which answers 500.
fn sql_scalar(value: &Value) -> Option<SqlValue> {
    match value {
        Value::String(text) => Some(SqlValue::Text(text.clone())),
        Value::Number(number) => Some(match number.as_i64() {
            Some(integer) => SqlValue::Integer(integer),
            None => SqlValue::Real(number.as_f64()?),
        }),
        _ => None,
    }
}

/// `GET /api/events/stream`: the SSE feed of the events the caller may see. The
/// workspace set is fixed at connect time, as in the TypeScript.
async fn stream(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    let Some(caller) = Caller::from_request(&state, &headers) else {
        return unauthorized_response();
    };
    let visible: HashSet<String> = match services.main.accessible_workspace_ids(&caller) {
        Ok(ids) => ids.into_iter().collect(),
        Err(error) => {
            tracing::error!(%error, "Failed to load workspaces for the event stream");
            return events_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch events");
        }
    };
    let main = Arc::clone(&services.main);
    let filter: EventFilter =
        Box::new(move |event: &SseEvent| event_visible(event, &visible, &main));
    let subscription = Arc::clone(&services.events).subscribe(Some(filter));
    let keep_alive = services.events.keep_alive();

    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header(header::CONNECTION, "keep-alive")
        .header("x-accel-buffering", "no")
        .header("x-sse-mode", "single-node-in-memory")
        .body(Body::from_stream(frame_stream(subscription, keep_alive)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// `isVisible` of the stream route. The payload's workspace wins, then its task,
/// then its agent. An event with none of them is hidden.
fn event_visible(event: &SseEvent, visible: &HashSet<String>, main: &MainStore) -> bool {
    let payload = event.payload.as_object();
    let text = |key: &str| {
        payload
            .and_then(|fields| fields.get(key))
            .and_then(Value::as_str)
    };
    if let Some(workspace) = text("workspace_id").filter(|value| !value.is_empty()) {
        return visible.contains(workspace);
    }
    // A string `taskId` is used even when it is empty, as the TypeScript ternary does.
    if let Some(task) = text("taskId")
        .or_else(|| text("task_id"))
        .filter(|value| !value.is_empty())
    {
        return main
            .workspace_of_task(task)
            .ok()
            .flatten()
            .is_some_and(|workspace| visible.contains(&workspace));
    }
    if let Some(agent) = text("agentId")
        .or_else(|| text("agent_id"))
        .filter(|value| !value.is_empty())
    {
        return main
            .workspace_of_agent(agent)
            .ok()
            .flatten()
            .is_some_and(|workspace| visible.contains(&workspace));
    }
    // ponytail: a failed lookup hides the event rather than failing the broadcast.
    false
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::http::Method;
    use http_body_util::BodyExt;

    use super::super::test_support::{
        app, assert_keys, send, send_raw, services_in, state_in, Scratch,
    };
    use super::*;

    const USER: &str = "user-1";

    /// Two workspaces, the caller's membership in one, an agent and a task in each,
    /// and one event per workspace plus a global one. Event times are ordered
    /// `mine` < `other` < `global`.
    fn seed(services: &Services) {
        services
            .main
            .lock()
            .execute_batch(
                "INSERT INTO workspaces (id, name, slug) VALUES
                   ('ws-mine', 'Mine', 'mine'), ('ws-other', 'Other', 'other');
                 INSERT INTO workspace_members (workspace_id, user_id, role)
                   VALUES ('ws-mine', 'user-1', 'member');
                 INSERT INTO agents (id, name, role, workspace_id) VALUES
                   ('a-mine', 'Mine agent', 'worker', 'ws-mine'),
                   ('a-other', 'Other agent', 'worker', 'ws-other');
                 INSERT INTO tasks (id, title, workspace_id) VALUES
                   ('t-mine', 'Mine task', 'ws-mine'),
                   ('t-other', 'Other task', 'ws-other');
                 INSERT INTO events (id, type, agent_id, task_id, message, created_at) VALUES
                   ('e-mine', 'task_updated', 'a-mine', 't-mine', 'mine', '2026-10-10T10:00:00.000Z'),
                   ('e-other', 'task_updated', 'a-other', 't-other', 'other', '2026-10-10T10:01:00.000Z'),
                   ('e-global', 'system', NULL, NULL, 'global', '2026-10-10T10:02:00.000Z');",
            )
            .expect("seed workspaces, agents, tasks and events");
    }

    async fn read_frame(body: &mut Body) -> String {
        let frame = tokio::time::timeout(Duration::from_secs(2), body.frame())
            .await
            .expect("frame within 2s")
            .expect("stream still open")
            .expect("no body error");
        let data = frame.into_data().expect("a data frame");
        String::from_utf8(data.to_vec()).expect("utf-8 frame")
    }

    /// The next `data:` frame, skipping keep-alive comments.
    async fn next_data(body: &mut Body) -> String {
        loop {
            let frame = read_frame(body).await;
            if !frame.starts_with(": keep-alive") {
                return frame;
            }
        }
    }

    #[tokio::test]
    async fn feed_requires_a_caller_and_shows_only_visible_events() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, true);
        let services = services_in(&scratch);
        seed(&services);
        let router = app(&state, &services);

        let (status, body) = send(&router, Method::GET, "/api/events", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);

        let (status, body) = send(&router, Method::GET, "/api/events", Some(USER), None).await;
        assert_eq!(status, StatusCode::OK);
        let rows = body.as_array().expect("an array of events");
        let messages: Vec<&str> = rows
            .iter()
            .map(|row| row["message"].as_str().expect("message"))
            .collect();
        assert_eq!(messages, vec!["global", "mine"]);
        assert_eq!(rows[1]["agent"]["name"], "Mine agent");
        assert_eq!(rows[1]["task"]["title"], "Mine task");
        assert_keys(
            &rows[0],
            &[
                "agent_emoji",
                "agent_id",
                "agent_name",
                "created_at",
                "id",
                "message",
                "metadata",
                "task_id",
                "task_title",
                "type",
            ],
        );
    }

    #[tokio::test]
    async fn create_checks_access_then_inserts_the_event() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, true);
        let services = services_in(&scratch);
        seed(&services);
        let router = app(&state, &services);

        let (status, body) = send(
            &router,
            Method::POST,
            "/api/events",
            Some(USER),
            Some(r#"{"message":"x"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Type and message are required");

        let (status, body) = send(
            &router,
            Method::POST,
            "/api/events",
            Some(USER),
            Some(r#"{"type":"note","message":"x","agent_id":"a-other"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Agent not found");

        let (status, body) = send(
            &router,
            Method::POST,
            "/api/events",
            Some(USER),
            Some(r#"{"type":"note","message":"x","agent_id":"a-mine","task_id":"t-other"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Task not found");

        let (status, body) = send(
            &router,
            Method::POST,
            "/api/events",
            Some(USER),
            Some(r#"{"type":"note","message":"hello","agent_id":"a-mine","task_id":"t-mine","metadata":{"k":1}}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_keys(&body, &["created_at", "id", "message", "type"]);
        assert_eq!(body["message"], "hello");

        let (status, body) =
            send(&router, Method::POST, "/api/events", Some(USER), Some("{")).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_keys(&body, &["error"]);

        let (_, feed) = send(
            &router,
            Method::GET,
            "/api/events?limit=10",
            Some(USER),
            None,
        )
        .await;
        let messages: Vec<&str> = feed
            .as_array()
            .expect("array")
            .iter()
            .map(|row| row["message"].as_str().expect("message"))
            .collect();
        assert!(messages.contains(&"hello"), "the new event is in the feed");
    }

    #[tokio::test]
    async fn stream_requires_a_caller_and_sends_the_connect_frames() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, true);
        let services = services_in(&scratch);
        seed(&services);
        let router = app(&state, &services);

        let (status, body) = send(&router, Method::GET, "/api/events/stream", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);

        let response = send_raw(&router, Method::GET, "/api/events/stream", Some(USER), None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        assert_eq!(
            response.headers()["cache-control"],
            "no-cache, no-transform"
        );
        assert_eq!(response.headers()["x-sse-mode"], "single-node-in-memory");
        let mut body = response.into_body();
        assert_eq!(read_frame(&mut body).await, ": connected\n\n");
        let connected = read_frame(&mut body).await;
        assert!(
            connected.starts_with(
                "data: {\"type\":\"sse_connected\",\"payload\":{\"mode\":\"single-node-in-memory\""
            ),
            "{connected}"
        );
    }

    #[tokio::test]
    async fn stream_delivers_only_the_events_the_caller_may_see() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, true);
        let services = services_in(&scratch);
        seed(&services);
        let router = app(&state, &services);
        let response = send_raw(&router, Method::GET, "/api/events/stream", Some(USER), None).await;
        let mut body = response.into_body();
        read_frame(&mut body).await;
        read_frame(&mut body).await;

        services.events.broadcast(&SseEvent {
            event_type: "task_updated".into(),
            payload: json!({ "workspace_id": "ws-other", "n": 1 }),
        });
        services.events.broadcast(&SseEvent {
            event_type: "task_updated".into(),
            payload: json!({ "taskId": "t-other", "n": 2 }),
        });
        services.events.broadcast(&SseEvent {
            event_type: "system".into(),
            payload: json!({ "n": 3 }),
        });
        services.events.broadcast(&SseEvent {
            event_type: "task_updated".into(),
            payload: json!({ "taskId": "t-mine", "n": 4 }),
        });

        assert_eq!(
            next_data(&mut body).await,
            "data: {\"type\":\"task_updated\",\"payload\":{\"taskId\":\"t-mine\",\"n\":4}}\n\n"
        );
    }

    #[tokio::test]
    async fn stream_interleaves_keep_alive_comments() {
        let scratch = Scratch::new();
        let state = state_in(&scratch, false);
        let services = services_in(&scratch);
        let router = app(&state, &services);
        let response = send_raw(&router, Method::GET, "/api/events/stream", Some(USER), None).await;
        let mut body = response.into_body();
        read_frame(&mut body).await;
        read_frame(&mut body).await;

        assert_eq!(read_frame(&mut body).await, ": keep-alive\n\n");
    }
}
