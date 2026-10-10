//! WebSocket upgrade and connection lifecycle.
//!
//! Ports the upgrade path in `server.ts:120-213` and the connection handler in
//! `src/server/gateway/connection-handler.ts`. Every rejection reason keeps its
//! original status line so the browser client's reconnect heuristics behave
//! identically.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;

use betaclaw_core::auth::jwe::decode_session_from_cookies;
use betaclaw_core::auth::policy::{
    constant_time_eq, is_cross_site_browser_request, should_allow_anonymous_local_principal,
    strip_bearer, AnonymousLocalPrincipalInput, BrowserRequestHeaders,
};
use betaclaw_core::auth::principal::get_principal_user_id;
use betaclaw_core::gateway::broadcast::broadcast_to_user;
use betaclaw_core::gateway::client::{ClientHandle, Outbound};
use betaclaw_core::gateway::events::{HELLO_OK, PRESENCE_UPDATE};
use betaclaw_core::gateway::protocol::{make_event, parse_frame, GatewayFrame};

use crate::auth_gate::parse_cookies;
use crate::gateway_methods::{
    build_registry, hello_ok_payload, invalid_frame, is_dispatchable, new_request_window,
    rate_limited, MethodRegistry,
};
use crate::state::SharedState;

/// Outbound channel depth. A deep queue only slows the slow-consumer detector,
/// which measures queued bytes rather than message count.
const OUTBOUND_QUEUE_DEPTH: usize = 256;

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub protocol: Option<String>,
}

/// Entry point registered at `GET /ws`.
pub async fn handler(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let browser = BrowserRequestHeaders {
        host: header_string(&headers, "host"),
        origin: header_string(&headers, "origin"),
        referer: header_string(&headers, "referer"),
        sec_fetch_site: header_string(&headers, "sec-fetch-site"),
    };

    // Cross-site WebSocket hijacking: a page on another origin must not be able
    // to open /ws with the user's cookies.
    if is_cross_site_browser_request(&browser) {
        return raw_status(StatusCode::FORBIDDEN);
    }

    if query.protocol.as_deref() != Some("v2") {
        return raw_status(StatusCode::BAD_REQUEST);
    }

    let Some(user_id) = resolve_ws_user(&state, peer, &headers, &browser) else {
        tracing::warn!("[gateway] WS auth failed — no valid session or local principal");
        return raw_status(StatusCode::UNAUTHORIZED);
    };

    if state.registry.get_user_connection_count(&user_id)
        >= state.config.websocket_max_connections_per_user
    {
        return raw_status(StatusCode::TOO_MANY_REQUESTS);
    }

    let max_payload = state.config.websocket_max_payload_bytes;
    upgrade
        .max_message_size(max_payload)
        .on_upgrade(move |socket| run_connection(socket, state, user_id))
}

fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// The upgrade path answers with a bare status line, as `server.ts` does,
/// instead of a body.
fn raw_status(status: StatusCode) -> Response {
    Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, "text/plain")
        .body(axum::body::Body::empty())
        .expect("static status response is valid")
}

fn resolve_ws_user(
    state: &SharedState,
    peer: SocketAddr,
    headers: &HeaderMap,
    browser: &BrowserRequestHeaders,
) -> Option<String> {
    let cookies = parse_cookies(headers);
    let cookie_names = state.config.session_cookie_names();

    if let Ok(session) = decode_session_from_cookies(
        cookies
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
        &cookie_names,
        &state.config.auth_secret,
        chrono::Utc::now().timestamp(),
    ) {
        return Some(session.user_id);
    }

    // Bearer authentication also works for WS, mirroring `getToken`, which reads
    // the Authorization header when no cookie is present.
    if let (Some(expected), Some(authorization)) = (
        state.config.mc_api_token.as_deref(),
        header_string(headers, "authorization"),
    ) {
        if let Some(provided) = strip_bearer(&authorization) {
            if constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
                return Some(get_principal_user_id());
            }
        }
    }

    let socket_loopback =
        betaclaw_core::auth::policy::is_loopback_address(Some(&peer.ip().to_string()));
    if should_allow_anonymous_local_principal(&AnonymousLocalPrincipalInput {
        require_auth: state.config.require_auth,
        mc_api_token_configured: state.config.mc_api_token.is_some(),
        socket_loopback,
        browser: browser.clone(),
    }) {
        return Some(get_principal_user_id());
    }

    None
}

/// Runs one gateway connection.
///
/// The socket is split: the reader applies the rate limit and dispatches
/// methods, the writer drains the outbound queue used by broadcasts. Splitting
/// means a slow consumer can never block method dispatch.
async fn run_connection(socket: WebSocket, state: SharedState, user_id: String) {
    let connected_at = now_ms();
    let conn_id = format!(
        "ws-{connected_at}-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..6]
    );

    let (sender, receiver) = mpsc::channel::<Outbound>(OUTBOUND_QUEUE_DEPTH);
    let client = ClientHandle::new(&conn_id, &user_id, "v2", connected_at, sender);
    let methods: Arc<MethodRegistry> = Arc::new(build_registry());

    state.registry.register(client.clone());
    tracing::info!(conn_id = %conn_id, user_id = %user_id, "Client connected");

    // `hello-ok` must be an event frame, not a response: the client listens for
    // the event type. See `connection-handler.ts:39-45`.
    let hello = make_event(
        HELLO_OK,
        Some(hello_ok_payload(&methods, &state.registry)),
        None,
    );
    let _ = client.enqueue_text(hello.to_string());

    broadcast_presence(&state, &user_id, "online");

    let (mut sink, mut stream) = socket.split();

    let writer_client = client.clone();
    let writer = tokio::spawn(async move {
        let mut receiver = receiver;
        while let Some(message) = receiver.recv().await {
            let result = match message {
                Outbound::Text(text) => {
                    let len = text.len();
                    let sent = sink.send(Message::Text(text.into())).await;
                    if sent.is_ok() {
                        writer_client.note_flushed(len);
                    }
                    sent
                }
                Outbound::Ping(payload) => sink.send(Message::Ping(payload.into())).await,
                Outbound::Close(code, reason) => {
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    break;
                }
            };
            if let Err(error) = result {
                tracing::debug!(conn_id = %writer_client.conn_id, error = %error, "Write failed");
                break;
            }
        }
    });

    let mut request_window = new_request_window(now_ms());
    let mut close_reason: Option<(u16, String)> = None;

    while let Some(incoming) = stream.next().await {
        let text = match incoming {
            Ok(Message::Text(text)) => text.to_string(),
            // axum answers protocol-level pings itself; a received Pong is the
            // liveness signal the keepalive sweep relies on.
            Ok(Message::Pong(_)) => {
                client.set_alive(true);
                continue;
            }
            Ok(Message::Close(frame)) => {
                close_reason = Some(match frame {
                    Some(frame) => (frame.code, frame.reason.to_string()),
                    None => (1000, String::new()),
                });
                break;
            }
            Ok(Message::Ping(_) | Message::Binary(_)) => continue,
            Err(error) => {
                tracing::debug!(conn_id = %conn_id, error = %error, "Read failed");
                break;
            }
        };

        let Some(frame) = parse_frame(&text) else {
            let _ = client.enqueue_text(invalid_frame().to_string());
            continue;
        };
        if !is_dispatchable(&frame) {
            continue;
        }
        let GatewayFrame::Request(request) = frame else {
            continue;
        };

        if !request_window.record(now_ms(), state.config.gateway_max_requests_per_minute) {
            let _ = client.enqueue_text(rate_limited(&request.id).to_string());
            continue;
        }

        let response = methods.dispatch(
            &request.id,
            &request.method,
            &request.params,
            &client,
            &state,
        );
        if !client.enqueue_text(response.to_string()) {
            break;
        }
    }

    state.registry.unregister(&conn_id);
    broadcast_presence(&state, &user_id, "offline");
    tracing::info!(conn_id = %conn_id, ?close_reason, "Client disconnected");

    // Dropping the handle closes the outbound channel, which ends the writer.
    drop(client);
    let _ = writer.await;
}

fn broadcast_presence(state: &SharedState, user_id: &str, status: &str) {
    let connection_count = state.registry.get_user_connection_count(user_id);
    broadcast_to_user(
        &state.registry,
        user_id,
        PRESENCE_UPDATE,
        Some(serde_json::json!({
            "userId": user_id,
            "status": status,
            "connectionCount": connection_count,
        })),
    );
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Raw status lines, copied verbatim from `server.ts` so the wire contract stays
/// auditable. The upgrade path answers with a bare status line and no body.
pub mod rejection {
    pub const BAD_REQUEST: &str = "HTTP/1.1 400 Bad Request\r\n\r\n";
    pub const UNAUTHORIZED: &str = "HTTP/1.1 401 Unauthorized\r\n\r\n";
    pub const FORBIDDEN: &str = "HTTP/1.1 403 Forbidden\r\n\r\n";
    pub const NOT_FOUND: &str = "HTTP/1.1 404 Not Found\r\n\r\n";
    pub const TOO_MANY_CONNECTIONS: &str = "HTTP/1.1 429 Too Many Connections\r\n\r\n";
    pub const INTERNAL_ERROR: &str = "HTTP/1.1 500 Internal Server Error\r\n\r\n";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejection_lines_match_server_ts() {
        assert!(rejection::BAD_REQUEST.contains("400 Bad Request"));
        assert!(rejection::UNAUTHORIZED.contains("401 Unauthorized"));
        assert!(rejection::FORBIDDEN.contains("403 Forbidden"));
        assert!(rejection::NOT_FOUND.contains("404 Not Found"));
        assert!(rejection::TOO_MANY_CONNECTIONS.contains("429 Too Many Connections"));
        assert!(rejection::INTERNAL_ERROR.contains("500 Internal Server Error"));
        for line in [
            rejection::BAD_REQUEST,
            rejection::UNAUTHORIZED,
            rejection::FORBIDDEN,
            rejection::NOT_FOUND,
            rejection::TOO_MANY_CONNECTIONS,
            rejection::INTERNAL_ERROR,
        ] {
            assert!(
                line.ends_with("\r\n\r\n"),
                "line must terminate the response"
            );
        }
    }

    #[test]
    fn raw_status_uses_expected_codes() {
        assert_eq!(
            raw_status(StatusCode::UNAUTHORIZED).status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            raw_status(StatusCode::TOO_MANY_REQUESTS).status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            raw_status(StatusCode::FORBIDDEN).status(),
            StatusCode::FORBIDDEN
        );
    }
}
