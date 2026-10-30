//! Router and reverse proxy.
//!
//! The gateway owns the public listener. Requests are handled in this order:
//!
//! 1. `GET /__rust/health` — infrastructure healthcheck only, never part of the
//!    `/api` contract.
//! 2. `/ws` — the WebSocket upgrade, handled natively.
//! 3. Migrated API routes — served in Rust.
//! 4. Everything else, including non-migrated `/api/*` — reverse-proxied to the
//!    Next.js UI process. HTTP upgrades (Next.js dev HMR) are tunnelled byte for
//!    byte instead.
//!
//! Step 4 is the temporary proxy. It disappears in slice S13, when the last
//! route has moved to Rust and Next.js only serves static UI assets.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{CONNECTION, UPGRADE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use bytes::Bytes;
use http_body_util::Empty;
use hyper_util::rt::TokioIo;

use betaclaw_core::auth::policy::CLIENT_LOOPBACK_HEADER;

use crate::auth_gate::auth_gate_middleware;
use crate::families::cutover::ProxyFallback;
use crate::routes;
use crate::state::SharedState;

/// Upstream hop-by-hop headers that must not be forwarded.
///
/// RFC 9110 section 7.6.1 lists connection-specific headers; forwarding them
/// corrupts the upstream connection.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Upper bound for a buffered proxied request body. Matches the WebSocket payload
/// ceiling so attachment uploads behave the same on both paths.
const PROXY_MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

pub fn build_router(state: SharedState) -> Router {
    // Fallback for families that are switched to the proxy. The cutover gate reads it
    // from the request.
    let proxy = ProxyFallback::new({
        let state = state.clone();
        move |request: Request| proxy_to_upstream(State(state.clone()), request)
    });
    let router = Router::new()
        // Infrastructure endpoint. Deliberately outside `/api` so it cannot be
        // confused with the public API contract.
        .route("/__rust/health", get(rust_health))
        .route("/ws", get(crate::ws::handler))
        // Migrated routes. The list is explicit so the migration surface is
        // reviewable at a glance; see docs/RUST_MIGRATION.md.
        .merge(routes::router())
        .fallback(crate::static_ui::static_fallback)
        // Family services and the cutover switch. The layers wrap every route merged
        // above, so they are attached after the merge.
        .layer(Extension(state.cutover.clone()))
        .layer(Extension(proxy))
        .layer(Extension(state.master.clone()))
        .layer(Extension(state.skills.clone()))
        .layer(Extension(state.stats.clone()))
        .layer(Extension(state.ops.clone()))
        .layer(Extension(state.tasks.clone()));
    let router = match state.channels.get() {
        Some(channels) => router.layer(Extension(channels.clone())),
        None => router,
    };
    router
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_gate_middleware,
        ))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

async fn rust_health(State(state): State<SharedState>) -> Response {
    let registry: Arc<_> = state.registry.clone();
    let connections = registry.connection_count();
    let payload = serde_json::json!({
        "ok": true,
        "service": "betaclaw-gateway",
        "upstream": state.config.upstream_origin,
        "activeWebsocketSessions": connections,
    });
    (StatusCode::OK, axum::Json(payload)).into_response()
}

/// Forwards the request to the Next.js UI process.
///
/// The loopback marker is always re-derived from the real TCP peer before the
/// request leaves this process. A client-supplied value is dropped, exactly as
/// `applyClientLoopbackMarker` does in `server.ts:110`.
pub(crate) async fn proxy_to_upstream(
    State(state): State<SharedState>,
    request: Request,
) -> Response {
    if is_upgrade_request(request.headers()) {
        return proxy_upgrade(&state, request).await;
    }

    let peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip());

    let (parts, body) = request.into_parts();
    let uri: Uri = parts.uri.clone();
    let upstream = build_upstream_uri(&state.config.upstream_origin, &uri);
    let upstream_text = upstream.to_string();

    let Ok(upstream_url) = upstream_text.parse::<reqwest::Url>() else {
        tracing::error!(upstream = %upstream_text, "Configured upstream origin is not a valid URL");
        return proxy_unavailable();
    };

    // reqwest must own the request body, and it cannot borrow axum's stream.
    // Buffering is acceptable because the not-yet-migrated surface is JSON
    // request bodies plus attachments; the ceiling matches the WebSocket payload
    // limit so uploads behave the same on both paths.
    let bytes = match axum::body::to_bytes(body, PROXY_MAX_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(error = %error, "Failed to buffer proxied request body");
            return proxy_unavailable();
        }
    };

    let mut forward_headers = reqwest::header::HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        forward_headers.append(name.clone(), value.clone());
    }
    // Drop any client-supplied marker, then re-derive it from the socket peer.
    // Absence of the header is how a non-loopback peer is signalled.
    forward_headers.remove(CLIENT_LOOPBACK_HEADER);
    if let Some(ip) = peer {
        if betaclaw_core::auth::policy::is_loopback_address(Some(&ip.to_string())) {
            forward_headers.insert(
                HeaderName::from_static(CLIENT_LOOPBACK_HEADER),
                HeaderValue::from_static("1"),
            );
        }
    }
    // The upstream must see the original authority, not the rewritten absolute
    // URI.
    if let Some(host) = authority_header(&uri) {
        forward_headers.insert(axum::http::header::HOST, host);
    }

    let builder = state
        .upstream
        .request(parts.method.clone(), upstream_url)
        .headers(forward_headers)
        .body(bytes);

    let upstream_response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(error = %error, upstream = %upstream_text, "Upstream request failed");
            return proxy_unavailable();
        }
    };

    let status = upstream_response.status();
    let mut builder = Response::builder().status(status);
    for (name, value) in upstream_response.headers().iter() {
        if is_hop_by_hop(name.as_str()) || name.as_str() == "content-length" {
            continue;
        }
        builder = builder.header(name.clone(), value.clone());
    }

    let bytes = match upstream_response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::error!(error = %error, "Failed to read upstream body");
            return proxy_unavailable();
        }
    };

    match builder.body(Body::from(bytes)) {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(error = %error, "Failed to build upstream response");
            proxy_unavailable()
        }
    }
}

/// Tunnels an HTTP upgrade (WebSocket, used by Next.js dev HMR) to the UI.
///
/// reqwest does not expose the upgraded socket, so this hop speaks hyper
/// directly. When both sides answer 101 the two sockets are piped byte for byte.
async fn proxy_upgrade(state: &SharedState, mut request: Request) -> Response {
    let peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip());

    let upstream = build_upstream_uri(&state.config.upstream_origin, request.uri());
    let Some(authority) = upstream.authority() else {
        return proxy_unavailable();
    };
    let port = authority.port_u16().unwrap_or(80);
    let Ok(stream) = tokio::net::TcpStream::connect((authority.host(), port)).await else {
        tracing::error!(upstream = %upstream, "Upgrade target is unreachable");
        return proxy_unavailable();
    };
    let Ok((mut sender, connection)) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
    else {
        return proxy_unavailable();
    };
    tokio::spawn(async move {
        if let Err(error) = connection.with_upgrades().await {
            tracing::debug!(error = %error, "Upgrade connection to the UI closed");
        }
    });

    // Same marker rule as the plain proxy path: client value dropped, re-derived
    // from the socket peer. Connection and Upgrade must stay, the handshake needs them.
    let mut headers = request.headers().clone();
    headers.remove(CLIENT_LOOPBACK_HEADER);
    if let Some(ip) = peer {
        if betaclaw_core::auth::policy::is_loopback_address(Some(&ip.to_string())) {
            headers.insert(
                HeaderName::from_static(CLIENT_LOOPBACK_HEADER),
                HeaderValue::from_static("1"),
            );
        }
    }
    let path = request
        .uri()
        .path_and_query()
        .cloned()
        .map(Uri::from)
        .unwrap_or_else(|| Uri::from_static("/"));
    let mut upstream_request = hyper::Request::new(Empty::<Bytes>::new());
    *upstream_request.method_mut() = request.method().clone();
    *upstream_request.uri_mut() = path;
    *upstream_request.headers_mut() = headers;

    let mut upstream_response = match sender.send_request(upstream_request).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(error = %error, upstream = %upstream, "Upgrade request to the UI failed");
            return proxy_unavailable();
        }
    };

    if upstream_response.status() != StatusCode::SWITCHING_PROTOCOLS {
        return relay_plain_response(upstream_response);
    }

    let upstream_upgrade = hyper::upgrade::on(&mut upstream_response);
    let client_upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        match tokio::try_join!(client_upgrade, upstream_upgrade) {
            Ok((client, upstream)) => {
                let mut client = TokioIo::new(client);
                let mut upstream = TokioIo::new(upstream);
                if let Err(error) = tokio::io::copy_bidirectional(&mut client, &mut upstream).await
                {
                    tracing::debug!(error = %error, "Tunnelled upgrade closed");
                }
            }
            Err(error) => tracing::warn!(error = %error, "Upgrade handshake failed"),
        }
    });

    let (parts, _) = upstream_response.into_parts();
    let mut response = Response::new(Body::empty());
    *response.status_mut() = parts.status;
    *response.headers_mut() = parts.headers;
    response
}

/// Passes a non-101 answer from the UI to the client, minus hop-by-hop headers.
fn relay_plain_response(response: hyper::Response<hyper::body::Incoming>) -> Response {
    let (mut parts, body) = response.into_parts();
    let mut headers = HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if !is_hop_by_hop(name.as_str()) {
            headers.append(name.clone(), value.clone());
        }
    }
    parts.headers = headers;
    Response::from_parts(parts, Body::new(body))
}

/// An upgrade needs both `Connection: upgrade` and an `Upgrade` header (RFC 9110 7.8).
fn is_upgrade_request(headers: &HeaderMap) -> bool {
    headers.contains_key(UPGRADE)
        && headers.get_all(CONNECTION).iter().any(|value| {
            value.to_str().is_ok_and(|text| {
                text.split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
        })
}

fn is_hop_by_hop(name: &str) -> bool {
    HOP_BY_HOP.contains(&name)
}

fn proxy_unavailable() -> Response {
    (
        StatusCode::BAD_GATEWAY,
        axum::Json(serde_json::json!({ "error": "Upstream UI service is unavailable" })),
    )
        .into_response()
}

/// Rebuilds the `Host` header from the original request target.
fn authority_header(uri: &Uri) -> Option<HeaderValue> {
    let host = uri.host()?;
    let value = match uri.port_u16() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    HeaderValue::from_str(&value).ok()
}

/// Builds the upstream absolute URI from the original request target.
///
/// Query strings must survive the hop; the UI depends on them for pagination
/// and OAuth callbacks. Trailing slashes are collapsed so a configured origin
/// like `http://host:3001/` does not produce a doubled separator.
fn build_upstream_uri(origin: &str, uri: &Uri) -> Uri {
    let base = origin.trim_end_matches('/');
    let path = uri.path();
    let normalized_path = if path.is_empty() { "/" } else { path };
    let query = uri
        .query()
        .map(|value| format!("?{value}"))
        .unwrap_or_default();
    let candidate = format!("{base}{normalized_path}{query}");
    candidate.parse().unwrap_or_else(|_| {
        format!("{base}/")
            .parse()
            .expect("configured upstream origin is a valid URI base")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_uri_preserves_path_and_query() {
        let uri: Uri = "/api/logs?limit=5&before=2024".parse().unwrap();
        let upstream = build_upstream_uri("http://127.0.0.1:3001", &uri);
        assert_eq!(upstream.path(), "/api/logs");
        assert_eq!(upstream.query(), Some("limit=5&before=2024"));
    }

    #[test]
    fn upstream_uri_handles_missing_query() {
        let uri: Uri = "/".parse().unwrap();
        let upstream = build_upstream_uri("http://127.0.0.1:3001/", &uri);
        assert_eq!(upstream.to_string(), "http://127.0.0.1:3001/");
    }

    #[test]
    fn upstream_uri_collapses_trailing_slash_on_origin() {
        let uri: Uri = "/login".parse().unwrap();
        // A configured origin with a trailing slash must not double the
        // separator, which would 404 every request.
        let with_slash = build_upstream_uri("http://127.0.0.1:3001/", &uri);
        let without_slash = build_upstream_uri("http://127.0.0.1:3001", &uri);
        assert_eq!(with_slash, without_slash);
        assert_eq!(with_slash.path(), "/login");
    }

    #[test]
    fn upstream_uri_defaults_to_root_for_empty_path() {
        let uri: Uri = "/".parse().unwrap();
        let upstream = build_upstream_uri("http://127.0.0.1:3001", &uri);
        assert!(upstream.path().starts_with('/'));
    }

    #[test]
    fn upgrade_needs_both_connection_token_and_upgrade_header() {
        let mut headers = HeaderMap::new();
        headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(CONNECTION, HeaderValue::from_static("keep-alive, Upgrade"));
        assert!(is_upgrade_request(&headers));

        headers.remove(CONNECTION);
        assert!(!is_upgrade_request(&headers));

        let plain = HeaderMap::new();
        assert!(!is_upgrade_request(&plain));
    }

    #[test]
    fn hop_by_hop_headers_are_listed() {
        assert!(HOP_BY_HOP.contains(&"transfer-encoding"));
        assert!(HOP_BY_HOP.contains(&"upgrade"));
        assert!(!HOP_BY_HOP.contains(&"content-type"));
    }
}
