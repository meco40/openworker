//! Authentication gate middleware.
//!
//! Ports the decision flow of `proxy.ts` and `withUserContext`. The middleware
//! never weakens a rule: a rejection short-circuits with the same status code
//! and body the TypeScript version produced.

use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use betaclaw_core::auth::jwe::decode_session_from_cookies;
use betaclaw_core::auth::policy::{evaluate_gate, BrowserRequestHeaders, CLIENT_LOOPBACK_HEADER};
use betaclaw_core::auth::user_context::{
    resolve_request_user_context, RequestAuthInput, UserContext,
};

use crate::state::SharedState;

/// Header carrying the resolved identity to the route handlers.
pub const USER_CONTEXT_HEADER: &str = "x-betaclaw-user-id";
/// Header marking a service-token caller.
pub const USER_SERVICE_HEADER: &str = "x-betaclaw-user-service";

/// Parses a `Cookie` header into name/value pairs.
///
/// Duplicate names are preserved because chunked session cookies rely on the
/// ordering, and `join_cookie_chunks` re-sorts them numerically.
pub fn parse_cookies(headers: &HeaderMap) -> Vec<(String, String)> {
    let Some(raw) = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
    else {
        return Vec::new();
    };
    raw.split(';')
        .filter_map(|pair| {
            let pair = pair.trim();
            if pair.is_empty() {
                return None;
            }
            let (name, value) = pair.split_once('=')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

fn browser_headers(headers: &HeaderMap) -> BrowserRequestHeaders {
    let get = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    BrowserRequestHeaders {
        host: get("host"),
        origin: get("origin"),
        referer: get("referer"),
        sec_fetch_site: get("sec-fetch-site"),
    }
}

fn query_param(uri: &axum::http::Uri, name: &str) -> Option<String> {
    let query = uri.query()?;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        if parts.next() == Some(name) {
            return parts.next().map(percent_decode);
        }
    }
    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        if bytes[index] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Replaces any inbound loopback marker with one derived from the socket peer. A
/// client-supplied value never survives, so only a loopback peer carries the marker.
fn set_client_loopback_marker(headers: &mut HeaderMap, socket_loopback: bool) {
    headers.remove(CLIENT_LOOPBACK_HEADER);
    if socket_loopback {
        headers.insert(
            CLIENT_LOOPBACK_HEADER,
            axum::http::HeaderValue::from_static("1"),
        );
    }
}

pub async fn auth_gate_middleware(
    State(state): State<SharedState>,
    request: Request,
    next: Next,
) -> Response {
    let peer_ip = request
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip().to_string());

    let (mut parts, body) = request.into_parts();
    // Identity headers are set below from the resolved context only. The gate
    // admits some requests without resolving an identity (demo mode with
    // `REQUIRE_AUTH`), so a client-supplied value must not survive to a handler.
    parts.headers.remove(USER_CONTEXT_HEADER);
    parts.headers.remove(USER_SERVICE_HEADER);
    let headers = parts.headers.clone();
    let method = parts.method.as_str().to_string();
    let uri = parts.uri.clone();
    let pathname = uri.path().to_string();

    // The marker is derived from the socket peer only. Any inbound value is
    // discarded, matching `applyClientLoopbackMarker` in `server.ts:110`.
    let socket_loopback = betaclaw_core::auth::policy::is_loopback_address(peer_ip.as_deref());
    set_client_loopback_marker(&mut parts.headers, socket_loopback);

    let cookies = parse_cookies(&headers);
    let cookie_names = state.config.session_cookie_names();
    let now_seconds = chrono::Utc::now().timestamp();

    let session_valid = decode_session_from_cookies(
        cookies
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
        &cookie_names,
        &state.config.auth_secret,
        now_seconds,
    )
    .is_ok();

    let browser = browser_headers(&headers);
    let outcome = evaluate_gate(
        &pathname,
        &method,
        &browser,
        socket_loopback,
        state.config.require_auth,
        state.config.demo_mode,
        state.config.mc_api_token.is_some(),
        state.config.mc_api_token.as_deref(),
        query_param(&uri, "token").as_deref(),
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok()),
        session_valid,
    );

    if let Some((status, body)) = outcome.decision.rejection() {
        let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut response = (code, body).into_response();
        response.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("application/json"),
        );
        return response;
    }

    let mut request = Request::from_parts(parts, body);

    if outcome.set_demo_mode_header {
        request
            .headers_mut()
            .insert("x-demo-mode", axum::http::HeaderValue::from_static("true"));
    }

    // Identity resolution runs only for paths the gate accepted. For proxied
    // paths it is unused, but computing it keeps the two auth paths identical.
    let auth_input = RequestAuthInput {
        cookies: &cookies,
        authorization: headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok()),
        internal_token_header: headers
            .get("x-mc-internal-token")
            .and_then(|value| value.to_str().ok()),
        session_cookie_names: &cookie_names,
        auth_secret: &state.config.auth_secret,
        mc_api_token: state.config.mc_api_token.as_deref(),
        internal_token: &state.config.internal_token,
        require_auth: state.config.require_auth,
        now_seconds,
    };

    match resolve_request_user_context(&auth_input) {
        Some(UserContext {
            user_id,
            authenticated,
            service,
        }) => {
            if authenticated || !state.config.require_auth {
                request.headers_mut().insert(
                    USER_CONTEXT_HEADER,
                    axum::http::HeaderValue::from_str(&user_id)
                        .unwrap_or(axum::http::HeaderValue::from_static("unknown")),
                );
                if service {
                    request.headers_mut().insert(
                        USER_SERVICE_HEADER,
                        axum::http::HeaderValue::from_static("1"),
                    );
                }
            }
        }
        None => {
            // Only reachable with REQUIRE_AUTH and no session. The gate admitted
            // the request anyway, as a public path or a demo-mode read. No
            // identity is attached, so handlers that need one answer 401.
        }
    }

    let mut response = next.run(request).await;
    if outcome.set_demo_mode_header {
        response
            .headers_mut()
            .insert("x-demo-mode", axum::http::HeaderValue::from_static("true"));
    }
    response
}

/// Convenience accessor for handlers that need the resolved identity.
pub fn user_id_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get(USER_CONTEXT_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// True when the socket peer was loopback. Used by the WebSocket upgrade, which
/// re-runs the same policy outside the HTTP middleware.
pub fn request_is_loopback(headers: &HeaderMap) -> bool {
    headers
        .get(CLIENT_LOOPBACK_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some("1")
}

/// Standard rejection used by handlers when identity is required but absent.
pub fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(serde_json::json!({ "ok": false, "error": "Unauthorized" })),
    )
        .into_response()
}

/// Shared handle type used by route modules.
pub type GateState = Arc<crate::state::AppState>;

#[cfg(test)]
mod tests {
    use super::*;

    use std::net::SocketAddr;
    use std::path::PathBuf;

    use axum::body::Body;
    use axum::routing::get;
    use axum::Router;
    use betaclaw_core::config::GatewayConfig;
    use betaclaw_core::gateway_config::ConfigBackend;
    use tower::ServiceExt;

    use crate::state::AppState;

    /// Removes a gate test's scratch directory when the test ends.
    struct GateScratch(PathBuf);

    impl Drop for GateScratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Every state migrates the same mission-control database, and overlapping
    /// migrations fail with "database is locked". Gate tests build one at a time.
    static GATE_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Gateway state whose stores live in a fresh scratch directory. The routes
    /// harness is private to `routes`, so the gate tests build their own.
    fn gate_state() -> (SharedState, GateScratch) {
        let _serial = GATE_STATE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!("betaclaw-auth-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        let scratch = GateScratch(dir);
        let path = |name: &str| scratch.0.join(name).to_string_lossy().into_owned();
        let mut config = GatewayConfig::from_env().expect("test configuration resolves");
        config.logs_db_path = ":memory:".to_string();
        config.gateway_config_db_path = path("gateway-config.db");
        config.gateway_config_backend = ConfigBackend::Db;
        config.gateway_config_path = path("betaclaw.json");
        config.personas_db_path = path("personas.db");
        config.personas_root_path = path("personas");
        config.messages_db_path = path("messages.db");
        let state = Arc::new(AppState::new(config).expect("state initialises"));
        (state, scratch)
    }

    /// Sends `GET /probe` from `peer` through the gate and reports how the handler
    /// saw the loopback marker. `/probe` is outside `/api/`, so the gate admits it.
    async fn probe_from(peer: &str, marker: Option<&str>) -> String {
        let (state, _scratch) = gate_state();
        let app = Router::new()
            .route(
                "/probe",
                get(|headers: HeaderMap| async move {
                    if request_is_loopback(&headers) {
                        "loopback"
                    } else {
                        "remote"
                    }
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth_gate_middleware,
            ))
            .with_state(state);
        let mut builder = axum::http::Request::builder().uri("/probe");
        if let Some(value) = marker {
            builder = builder.header(CLIENT_LOOPBACK_HEADER, value);
        }
        let mut request = builder.body(Body::empty()).expect("valid request");
        let addr: SocketAddr = format!("{peer}:4000").parse().expect("socket address");
        request.extensions_mut().insert(ConnectInfo(addr));
        let response = app.oneshot(request).await.expect("infallible service");
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .expect("read body");
        String::from_utf8(bytes.to_vec()).expect("utf-8 body")
    }

    #[tokio::test]
    async fn spoofed_marker_from_remote_peer_is_dropped() {
        assert_eq!(probe_from("192.168.1.10", Some("1")).await, "remote");
    }

    #[tokio::test]
    async fn loopback_peer_gets_marker_without_client_header() {
        assert_eq!(probe_from("127.0.0.1", None).await, "loopback");
    }

    #[tokio::test]
    async fn loopback_peer_marker_is_set_from_socket_over_client_value() {
        assert_eq!(probe_from("127.0.0.1", Some("0")).await, "loopback");
    }

    #[test]
    fn parses_cookie_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "next-auth.session-token=abc; other=1".parse().unwrap(),
        );
        let cookies = parse_cookies(&headers);
        assert_eq!(
            cookies[0],
            ("next-auth.session-token".to_string(), "abc".to_string())
        );
        assert_eq!(cookies[1], ("other".to_string(), "1".to_string()));
    }

    #[test]
    fn parses_chunked_cookies_in_order() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "next-auth.session-token.1=B; next-auth.session-token.0=A"
                .parse()
                .unwrap(),
        );
        let cookies = parse_cookies(&headers);
        let names: Vec<&str> = cookies.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            vec!["next-auth.session-token.1", "next-auth.session-token.0"]
        );
    }

    #[test]
    fn missing_cookie_header_yields_empty_list() {
        assert!(parse_cookies(&HeaderMap::new()).is_empty());
    }

    #[test]
    fn reads_query_parameter() {
        let uri: axum::http::Uri = "/api/events/stream?token=abc%20def&x=1".parse().unwrap();
        assert_eq!(query_param(&uri, "token").as_deref(), Some("abc def"));
        assert_eq!(query_param(&uri, "x").as_deref(), Some("1"));
        assert_eq!(query_param(&uri, "missing"), None);
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("plain"), "plain");
    }
}
