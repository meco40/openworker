//! End-to-end tests against a real listener.
//!
//! These boot the actual axum router on an ephemeral port and speak HTTP and
//! WebSocket to it, so the upgrade rules, the auth gate and the migrated routes
//! are verified through the same code path a browser uses.

use std::net::SocketAddr;

use axum::http::StatusCode;
use betaclaw_core::config::GatewayConfig;
use betaclaw_core::gateway_config::ConfigBackend;
use betaclaw_gateway::proxy::build_router;
use betaclaw_gateway::state::{AppState, GatewayRuntime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Removes the scratch directory holding the gateway config database on drop.
struct Scratch(std::path::PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Boots a gateway with in-memory log and message stores and returns its
/// address. The config database lives in a scratch directory, so the default
/// `.local/` of the crate is never written. Keep the returned guard alive for
/// the whole test.
async fn spawn_gateway(require_auth: bool) -> (SocketAddr, Scratch) {
    let scratch = Scratch(
        std::env::temp_dir().join(format!("betaclaw-gateway-http-{}", uuid::Uuid::new_v4())),
    );
    std::fs::create_dir_all(&scratch.0).expect("create scratch dir");

    let mut config = GatewayConfig::from_env().expect("test configuration resolves");
    config.logs_db_path = ":memory:".to_string();
    config.personas_db_path = ":memory:".to_string();
    config.messages_db_path = ":memory:".to_string();
    config.gateway_config_db_path = scratch
        .0
        .join("gateway-config.db")
        .to_string_lossy()
        .into_owned();
    config.gateway_config_backend = ConfigBackend::Db;
    config.gateway_config_path = scratch
        .0
        .join("betaclaw.json")
        .to_string_lossy()
        .into_owned();
    config.require_auth = require_auth;
    config.mc_api_token = None;
    config.demo_mode = false;
    // Bind an arbitrary free port; the tests only need a loopback peer.
    config.hostname = "127.0.0.1".to_string();
    config.port = 0;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let address = listener.local_addr().expect("local address");

    let state = std::sync::Arc::new(AppState::new(config).expect("state initialises"));
    let app = build_router(state);

    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });

    // Give the listener a moment to start accepting.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    (address, scratch)
}

async fn http_get(
    address: SocketAddr,
    path: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, String) {
    let mut stream = TcpStream::connect(address).await.expect("connect");
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write request");
    stream.flush().await.expect("flush");

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read response");
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .map(|code| StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    (status, body)
}

async fn http_post_json(address: SocketAddr, path: &str, body: &str) -> (StatusCode, String) {
    let mut stream = TcpStream::connect(address).await.expect("connect");
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write request");
    stream.flush().await.expect("flush");

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read response");
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .map(|code| StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    (status, body)
}

/// Performs a WebSocket handshake and returns the status code plus the first
/// text frame the server sends.
async fn ws_handshake(
    address: SocketAddr,
    path: &str,
    extra_headers: &[(&str, &str)],
) -> (u16, Option<String>) {
    let mut stream = TcpStream::connect(address).await.expect("connect");
    let key = betaclaw_gateway::test_support::ws_accept_key();
    let mut request = format!(
        "GET {path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
    );
    for (name, value) in extra_headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write handshake");
    stream.flush().await.expect("flush");

    // The 101 response and the first frame usually arrive in separate TCP
    // segments, so keep reading until a complete text frame is available.
    let mut raw: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 8192];
    let mut header_end: Option<usize> = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);

    loop {
        if tokio::time::Instant::now() > deadline {
            break;
        }
        match tokio::time::timeout(
            std::time::Duration::from_millis(250),
            stream.read(&mut chunk),
        )
        .await
        {
            Ok(Ok(0)) => break,
            Ok(Ok(read)) => raw.extend_from_slice(&chunk[..read]),
            Ok(Err(_)) => break,
            Err(_) => {
                if header_end.is_some() && !raw.is_empty() {
                    break;
                }
            }
        }

        if header_end.is_none() {
            let text = String::from_utf8_lossy(&raw);
            if let Some(index) = text.find("\r\n\r\n") {
                header_end = Some(index + 4);
            } else {
                continue;
            }
        }
        if !betaclaw_gateway::test_support::extract_first_text_frame(&raw[header_end.unwrap()..])
            .is_empty()
        {
            break;
        }
    }

    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);

    if status != 101 {
        return (status, None);
    }

    let header_end = header_end.expect("handshake terminator present");
    let payload = betaclaw_gateway::test_support::extract_first_text_frame(&raw[header_end..]);
    (status, Some(String::from_utf8_lossy(payload).into_owned()))
}

#[tokio::test]
async fn health_endpoint_reports_service_state() {
    let (address, _scratch) = spawn_gateway(false).await;
    let (status, body) = http_get(address, "/__rust/health", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_str(&body).expect("json body");
    assert_eq!(value["ok"], true);
    assert_eq!(value["service"], "betaclaw-gateway");
    assert_eq!(value["activeWebsocketSessions"], 0);
}

#[tokio::test]
async fn logs_ingest_list_and_clear_round_trip() {
    let (address, _scratch) = spawn_gateway(false).await;

    let (status, body) = http_post_json(
        address,
        "/api/logs/ingest",
        r#"{"type":"SYS","message":"login failed for user"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_str(&body).expect("json body");
    assert_eq!(value["ok"], true);
    // "failed" escalates the level to error, matching logFromSystemEvent.
    assert_eq!(value["entry"]["level"], "error");
    assert_eq!(value["entry"]["source"], "SYS");
    assert_eq!(value["entry"]["category"], "system");

    let (status, body) = http_get(address, "/api/logs?limit=5", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_str(&body).expect("json body");
    assert_eq!(value["total"], 1);
    assert_eq!(value["page"]["returned"], 1);
    assert_eq!(value["page"]["hasMore"], false);
    assert!(value["page"]["nextCursor"].is_string());

    let (status, body) = http_get(address, "/api/logs?sources", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_str(&body).expect("json body");
    assert_eq!(value["sources"][0], "SYS");

    let (status, body) = http_post_json(address, "/api/logs/ingest", r#"{"type":"SYS"}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("type and message are required"));

    let (status, body) = http_get(address, "/api/logs", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let _: serde_json::Value = serde_json::from_str(&body).expect("json body");

    // DELETE clears and reports the deleted count.
    let mut stream = TcpStream::connect(address).await.expect("connect");
    stream
        .write_all(b"DELETE /api/logs HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .expect("write");
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.expect("read");
    let text = String::from_utf8_lossy(&response).into_owned();
    assert!(text.starts_with("HTTP/1.1 200"));
    assert!(text.contains(r#""deleted":1"#));
}

#[tokio::test]
async fn security_routes_answer() {
    let (address, _scratch) = spawn_gateway(false).await;

    // The snapshot is spread into the top level, matching
    // `NextResponse.json({ ok: true, ...snapshot })`. The frontend reads
    // `checks` and `generatedAt` directly from the root object.
    let (status, body) = http_get(address, "/api/security/status", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_str(&body).expect("json body");
    assert_eq!(value["ok"], true);
    assert!(
        value.get("snapshot").is_none(),
        "status must not nest the snapshot under a `snapshot` key"
    );
    assert_eq!(value["checks"].as_array().unwrap().len(), 4);
    assert_eq!(value["channels"].as_array().unwrap().len(), 5);
    assert!(value.get("generatedAt").is_some());
    assert!(value.get("summary").is_some());

    let (status, body) = http_get(address, "/api/security/policy-explain", &[]).await;
    assert_eq!(status, StatusCode::OK);
    let value: serde_json::Value = serde_json::from_str(&body).expect("json body");
    assert_eq!(value["ok"], true);
    assert!(
        value.get("snapshot").is_none(),
        "policy-explain must not nest the snapshot under a `snapshot` key"
    );
    assert_eq!(value["runtime"]["mode"], "main-chat-only");
    assert!(value["channels"].get("webchatEnabled").is_some());
    assert!(value.get("revision").is_some());
    assert!(value.get("source").is_some());
}

#[tokio::test]
async fn public_prefixes_skip_authentication() {
    let (address, _scratch) = spawn_gateway(true).await;
    // REQUIRE_AUTH is on, but the scheduler health probe is public.
    let (status, _) = http_get(address, "/api/health/scheduler", &[]).await;
    assert_ne!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn websocket_upgrade_rules_match_the_typescript_server() {
    let (address, _scratch) = spawn_gateway(false).await;

    // Missing protocol parameter.
    let (status, _) = ws_handshake(address, "/ws", &[]).await;
    assert_eq!(status, 400, "missing protocol must be rejected with 400");

    // Wrong protocol version.
    let (status, _) = ws_handshake(address, "/ws?protocol=v1", &[]).await;
    assert_eq!(status, 400, "unknown protocol must be rejected with 400");

    // Cross-site WebSocket hijacking.
    let (status, _) = ws_handshake(
        address,
        "/ws?protocol=v2",
        &[("Origin", "https://evil.example.com")],
    )
    .await;
    assert_eq!(status, 403, "cross-site upgrade must be rejected with 403");
}

#[tokio::test]
async fn websocket_handshake_yields_hello_ok() {
    let (address, _scratch) = spawn_gateway(false).await;
    let (status, frame) = ws_handshake(address, "/ws?protocol=v2", &[]).await;
    assert_eq!(status, 101, "loopback client must complete the handshake");

    let frame = frame.expect("hello-ok frame");
    let value: serde_json::Value = serde_json::from_str(&frame).expect("json frame");
    assert_eq!(value["type"], "event");
    assert_eq!(value["event"], "hello-ok");
    assert_eq!(value["payload"]["server"]["version"], "1.0.0");
    assert_eq!(value["payload"]["events"].as_array().unwrap().len(), 29);
    assert_eq!(value["payload"]["methods"].as_array().unwrap().len(), 8);
    // The method list must be sorted so the payload is byte-stable.
    let methods: Vec<String> = value["payload"]["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect();
    let mut sorted = methods.clone();
    sorted.sort();
    assert_eq!(methods, sorted);
}

#[tokio::test]
async fn bind_rejects_production_without_auth() {
    // A production configuration without REQUIRE_AUTH must refuse to bind.
    let mut config = GatewayConfig::from_env().expect("config resolves");
    config.logs_db_path = ":memory:".to_string();
    config.hostname = "127.0.0.1".to_string();
    config.port = 0;
    config.require_auth = false;
    config.auth_secret = "smoke-secret".to_string();
    std::env::set_var("NODE_ENV", "production");

    let result = GatewayRuntime::bind(config).await;
    std::env::set_var("NODE_ENV", "test");

    assert!(
        result.is_err(),
        "production start-up must fail without REQUIRE_AUTH"
    );
}
