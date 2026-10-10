//! Router and reverse proxy.
//!
//! The gateway owns the public listener. Requests are handled in this order:
//!
//! 1. `GET /__rust/health` — infrastructure healthcheck only, never part of the
//!    `/api` contract.
//! 2. `/ws` — the WebSocket upgrade, handled natively.
//! 3. Migrated API routes — served in Rust.
//! 4. Everything else, including non-migrated `/api/*` — reverse-proxied to the
//!    Next.js UI process.
//!
//! Step 4 is the temporary proxy. It disappears in slice S13, when the last
//! route has moved to Rust and Next.js only serves static UI assets.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use betaclaw_core::auth::policy::CLIENT_LOOPBACK_HEADER;

use crate::auth_gate::auth_gate_middleware;
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
    Router::new()
        // Infrastructure endpoint. Deliberately outside `/api` so it cannot be
        // confused with the public API contract.
        .route("/__rust/health", get(rust_health))
        .route("/ws", get(crate::ws::handler))
        // Migrated routes. The list is explicit so the migration surface is
        // reviewable at a glance; see docs/RUST_MIGRATION.md.
        .merge(routes::router())
        .fallback(proxy_to_upstream)
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
    fn hop_by_hop_headers_are_listed() {
        assert!(HOP_BY_HOP.contains(&"transfer-encoding"));
        assert!(HOP_BY_HOP.contains(&"upgrade"));
        assert!(!HOP_BY_HOP.contains(&"content-type"));
    }
}
