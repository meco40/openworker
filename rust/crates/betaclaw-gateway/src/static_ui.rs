//! Static Next export with page authentication, conditional caching and compression.
use crate::state::{AppState, SharedState};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{
        header::{self, HeaderName},
        HeaderMap, Method, StatusCode,
    },
    response::{IntoResponse, Response},
    Json,
};
use std::{
    collections::hash_map::DefaultHasher,
    convert::Infallible,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};
use tower::{service_fn, Layer, ServiceExt};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiMode {
    Static,
    Proxy,
}
impl UiMode {
    pub fn parse(value: Option<&str>, index_exists: bool) -> Self {
        match value.map(str::trim) {
            Some("proxy") => Self::Proxy,
            Some("static") => Self::Static,
            _ => {
                if index_exists {
                    Self::Static
                } else {
                    Self::Proxy
                }
            }
        }
    }
    pub fn from_env(directory: &Path) -> Self {
        Self::parse(
            std::env::var("BETACLAW_UI_MODE").ok().as_deref(),
            directory.join("index.html").is_file(),
        )
    }
}
pub struct StaticUi {
    pub mode: UiMode,
    pub directory: PathBuf,
    files: ServeDir<tower_http::set_status::SetStatus<ServeFile>>,
}
impl StaticUi {
    pub fn new(mode: UiMode, directory: PathBuf) -> Self {
        let files =
            ServeDir::new(&directory).not_found_service(ServeFile::new(directory.join("404.html")));
        Self {
            mode,
            directory,
            files,
        }
    }
    pub fn from_env() -> Self {
        let directory = resolve_static_dir();
        Self::new(UiMode::from_env(&directory), directory)
    }
    async fn serve(&self, mut request: Request, demo: bool) -> Response {
        let path = request.uri().path().to_string();
        if path == "/login" {
            let target = if let Some(query) = request.uri().query() {
                format!("/login.html?{query}")
            } else {
                "/login.html".into()
            };
            *request.uri_mut() = target.parse().unwrap();
        }
        let requested_etag = request
            .headers()
            .get(header::IF_NONE_MATCH)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let files = self.files.clone();
        let service = service_fn(move |request| {
            let files = files.clone();
            let path = path.clone();
            let requested_etag = requested_etag.clone();
            async move {
                let raw = files
                    .oneshot(request)
                    .await
                    .unwrap_or_else(|never| match never {});
                let mut response = raw.map(Body::new);
                let cache = if path.starts_with("/_next/static/") {
                    "public, max-age=31536000, immutable"
                } else if path == "/"
                    || path == "/login"
                    || path.ends_with(".html")
                    || path.ends_with(".txt")
                {
                    "no-cache"
                } else {
                    "public, max-age=86400"
                };
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, cache.parse().unwrap());
                add_security_headers(response.headers_mut(), demo);
                if matches!(
                    response.status(),
                    StatusCode::OK | StatusCode::PARTIAL_CONTENT
                ) {
                    let mut hasher = DefaultHasher::new();
                    response
                        .headers()
                        .get(header::LAST_MODIFIED)
                        .map(|h| h.as_bytes())
                        .hash(&mut hasher);
                    let length = response
                        .headers()
                        .get(header::CONTENT_RANGE)
                        .and_then(|h| h.to_str().ok())
                        .and_then(|v| v.rsplit('/').next())
                        .or_else(|| {
                            response
                                .headers()
                                .get(header::CONTENT_LENGTH)
                                .and_then(|h| h.to_str().ok())
                        });
                    length.hash(&mut hasher);
                    let etag = format!("W/\"{:x}\"", hasher.finish());
                    response
                        .headers_mut()
                        .insert(header::ETAG, etag.parse().unwrap());
                    if requested_etag.as_deref().is_some_and(|value| {
                        value
                            .split(',')
                            .any(|v| v.trim() == etag || v.trim() == "*")
                    }) {
                        *response.status_mut() = StatusCode::NOT_MODIFIED;
                        response.headers_mut().remove(header::CONTENT_LENGTH);
                        response.headers_mut().remove(header::CONTENT_RANGE);
                        *response.body_mut() = Body::empty();
                    }
                }
                Ok::<_, Infallible>(response)
            }
        });
        CompressionLayer::new()
            .layer(service)
            .oneshot(request)
            .await
            .unwrap_or_else(|never| match never {})
            .map(Body::new)
    }
}
pub fn resolve_static_dir() -> PathBuf {
    std::env::var("UI_STATIC_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            if Path::new("out/index.html").is_file() {
                PathBuf::from("out")
            } else if Path::new("/app/out/index.html").is_file() {
                PathBuf::from("/app/out")
            } else {
                PathBuf::from("out")
            }
        })
}
pub fn add_security_headers(headers: &mut HeaderMap, demo_mode: bool) {
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    headers.insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    headers.insert(
        header::REFERRER_POLICY,
        "strict-origin-when-cross-origin".parse().unwrap(),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
            .parse()
            .unwrap(),
    );
    if demo_mode {
        headers.insert(
            HeaderName::from_static("x-demo-mode"),
            "true".parse().unwrap(),
        );
    }
}

pub fn is_authenticated(state: &AppState, headers: &HeaderMap) -> bool {
    let cookies = crate::auth_gate::parse_cookies(headers);
    let use_secure = betaclaw_core::auth::use_secure_cookies(&state.config.nextauth_url);
    let session_name = betaclaw_core::auth::session_cookie_name(use_secure);
    let candidate_names = vec![session_name.to_string()];
    let now = chrono::Utc::now().timestamp();
    betaclaw_core::auth::decode_session_from_cookies(
        cookies.iter().map(|(n, v)| (n.as_str(), v.as_str())),
        &candidate_names,
        &state.config.auth_secret,
        now,
    )
    .is_ok()
}

pub fn is_rsc_request(headers: &HeaderMap, uri: &axum::http::Uri) -> bool {
    headers.get("rsc").is_some_and(|v| v == "1")
        || headers.contains_key("next-router-prefetch")
        || uri
            .query()
            .is_some_and(|query| query.split('&').any(|p| p.starts_with("_rsc=")))
}
pub async fn static_fallback(State(state): State<SharedState>, request: Request) -> Response {
    let path = request.uri().path();
    let is_page = matches!(*request.method(), Method::GET | Method::HEAD);
    if is_page
        && path == "/"
        && state.config.require_auth
        && !is_authenticated(&state, request.headers())
    {
        let mut response = if is_rsc_request(request.headers(), request.uri()) {
            (StatusCode::UNAUTHORIZED, "Unauthorized").into_response()
        } else {
            (
                StatusCode::FOUND,
                [(header::LOCATION, "/login?callbackUrl=%2F")],
            )
                .into_response()
        };
        add_security_headers(response.headers_mut(), state.config.demo_mode);
        return response;
    }
    if is_page && path == "/login" && is_authenticated(&state, request.headers()) {
        let mut response = (StatusCode::FOUND, [(header::LOCATION, "/")]).into_response();
        add_security_headers(response.headers_mut(), state.config.demo_mode);
        return response;
    }
    if state.ui.mode == UiMode::Proxy {
        let demo = state.config.demo_mode;
        let mut response = crate::proxy::proxy_to_upstream(State(state), request).await;
        add_security_headers(response.headers_mut(), demo);
        return response;
    }
    if path.starts_with("/api/") {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"ok":false,"error":"Not Found"})),
        )
            .into_response();
    }
    state.ui.serve(request, state.config.demo_mode).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn page_gate_matrix_is_identical_in_static_and_proxy_modes() {
        let root = std::env::temp_dir().join(format!("page-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.html"), "index").unwrap();
        std::fs::write(root.join("login.html"), "login").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().fallback(|| async { "upstream" }),
            )
            .await
            .unwrap();
        });
        for mode in [UiMode::Static, UiMode::Proxy] {
            for require_auth in [false, true] {
                for authenticated in [false, true] {
                    let mut config = betaclaw_core::config::GatewayConfig::from_env().unwrap();
                    config.auth_secret = "matrix-secret".into();
                    config.nextauth_url = "http://localhost:3000".into();
                    config.require_auth = require_auth;
                    config.messages_db_path = ":memory:".into();
                    config.personas_db_path = ":memory:".into();
                    config.logs_db_path = ":memory:".into();
                    config.auth_db_path = ":memory:".into();
                    config.upstream_origin = upstream.clone();
                    let mut state = AppState::new(config).unwrap();
                    state.ui = StaticUi::new(mode, root.clone());
                    let state = std::sync::Arc::new(state);
                    let token=betaclaw_core::auth::encode_session_token("matrix-secret",&serde_json::json!({"sub":"user","id":"user","exp":chrono::Utc::now().timestamp()+3600}).to_string()).unwrap();
                    for path in ["/", "/login"] {
                        let mut request = Request::builder().uri(path);
                        if authenticated {
                            request = request
                                .header(header::COOKIE, format!("next-auth.session-token={token}"));
                        }
                        let response = static_fallback(
                            State(state.clone()),
                            request.body(Body::empty()).unwrap(),
                        )
                        .await;
                        let redirect = path == "/" && require_auth && !authenticated
                            || path == "/login" && authenticated;
                        assert_eq!(
                            response.status(),
                            if redirect {
                                StatusCode::FOUND
                            } else {
                                StatusCode::OK
                            },
                            "{mode:?} auth={require_auth} session={authenticated} path={path}"
                        );
                        assert_eq!(
                            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                            "nosniff"
                        );
                    }
                    if mode == UiMode::Static {
                        let response = static_fallback(
                            State(state.clone()),
                            Request::builder()
                                .uri("/api/not-registered")
                                .body(Body::empty())
                                .unwrap(),
                        )
                        .await;
                        assert_eq!(response.status(), StatusCode::NOT_FOUND);
                        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
                    }
                }
            }
        }
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn mode_is_a_pure_startup_decision() {
        assert_eq!(UiMode::parse(Some("proxy"), true), UiMode::Proxy);
        assert_eq!(UiMode::parse(Some("static"), false), UiMode::Static);
        assert_eq!(UiMode::parse(None, true), UiMode::Static);
        assert_eq!(UiMode::parse(None, false), UiMode::Proxy);
    }
    #[tokio::test]
    async fn streams_ranges_decodes_paths_caches_and_compresses() {
        let root = std::env::temp_dir().join(format!("static-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("_next/static")).unwrap();
        std::fs::write(root.join("index.html"), "0123456789").unwrap();
        std::fs::write(root.join("[asset].txt"), "encoded").unwrap();
        std::fs::write(
            root.join("_next/static/large.js"),
            "const name='example';\n".repeat(2000),
        )
        .unwrap();
        let ui = StaticUi::new(UiMode::Static, root.clone());
        let get = |uri: &str| Request::builder().uri(uri).body(Body::empty()).unwrap();
        let range = ui
            .serve(
                Request::builder()
                    .uri("/")
                    .header(header::RANGE, "bytes=0-3")
                    .body(Body::empty())
                    .unwrap(),
                false,
            )
            .await;
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            axum::body::to_bytes(range.into_body(), 100).await.unwrap(),
            "0123"
        );
        let full = ui.serve(get("/"), false).await;
        let etag = full.headers()[header::ETAG].clone();
        assert_eq!(
            ui.serve(
                Request::builder()
                    .uri("/")
                    .header(header::IF_NONE_MATCH, etag)
                    .body(Body::empty())
                    .unwrap(),
                false
            )
            .await
            .status(),
            StatusCode::NOT_MODIFIED
        );
        assert_eq!(
            ui.serve(get("/%5Basset%5D.txt"), false).await.status(),
            StatusCode::OK
        );
        let compressed = ui
            .serve(
                Request::builder()
                    .uri("/_next/static/large.js")
                    .header(header::ACCEPT_ENCODING, "gzip")
                    .body(Body::empty())
                    .unwrap(),
                false,
            )
            .await;
        assert_eq!(compressed.headers()[header::CONTENT_ENCODING], "gzip");
        assert_eq!(
            compressed.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        let head = ui
            .serve(
                Request::builder()
                    .method(Method::HEAD)
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
                false,
            )
            .await;
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "10");
        assert!(axum::body::to_bytes(head.into_body(), 100)
            .await
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
