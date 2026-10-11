//! Replays the recorded Gemini traffic against the Rust adapter.
//!
//! `tests/fixtures/gemini/exchanges.json` is produced by
//! `pnpm run fixtures:gemini-traffic`, which drives the TypeScript adapter
//! (`@google/genai`) through every code path against canned, API-shaped
//! responses and records the requests it observes. That file is the oracle for
//! slice S4: the Rust adapter
//! ([`betaclaw_core::model_hub::providers::gemini::GeminiAdapter`]) must send the
//! same requests and parse the same responses.
//!
//! The comparison is deliberately split:
//!
//! - **URL, method and the contract headers** (`content-type`,
//!   `x-goog-api-key`) are asserted exactly. The recorder redacts the API key to
//!   `[REDACTED]`; the test substitutes the recorder's secret back in.
//! - **The JSON body** is compared semantically. Object key order is not a wire
//!   contract, and `serde_json` with `preserve_order` parses objects into a map
//!   whose equality ignores insertion order.
//!
//! No network is involved: a local transport plays back the recorded response.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use http::StatusCode;
use serde_json::{json, Value};

use betaclaw_core::model_hub::env::EnvOverrides;
use betaclaw_core::model_hub::http::{
    BoxFuture, HttpError, HttpRequest, HttpResponse, HttpTransport,
};
use betaclaw_core::model_hub::openai_compatible::{DispatchOptions, NOOP_ATTACHMENT_STORE};
use betaclaw_core::model_hub::provider_catalog::find_provider;
use betaclaw_core::model_hub::providers::gemini::GeminiAdapter;
use betaclaw_core::model_hub::providers::{ProviderAdapter, ProviderCall};
use betaclaw_core::model_hub::repository::encrypted_secret_input;
use betaclaw_core::model_hub::types::{
    GatewayMessage, GatewayRequest, GatewayRole, GatewayUsage, ProviderAccountRecord,
    ProviderAuthMethod, ProviderExecutionContext,
};

/// The secret the recorder used (`scripts/fixtures/record-gemini-traffic.mjs`).
const SECRET: &str = "parity-not-a-real-key";

/// A transport that plays back one recorded response and records the request.
struct FixtureTransport {
    response: HttpResponse,
    seen: Mutex<Vec<HttpRequest>>,
}

impl FixtureTransport {
    fn new(response: HttpResponse) -> Self {
        Self {
            response,
            seen: Mutex::new(Vec::new()),
        }
    }
}

impl HttpTransport for FixtureTransport {
    fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
        self.seen.lock().expect("lock").push(request.clone());
        let response = self.response.clone();
        Box::pin(async move { Ok(response) })
    }
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/gemini/exchanges.json")
}

fn fixture() -> Value {
    let raw = std::fs::read_to_string(fixture_path()).expect("read the recorded fixture");
    serde_json::from_str(&raw).expect("parse the recorded fixture")
}

/// An [`HttpResponse`] from an `exchange.response` entry. The recorder replies
/// with `Content-Type: application/json` for every exchange, so the JSON
/// constructor reproduces it.
fn recorded_response(response: &Value) -> HttpResponse {
    let status = StatusCode::from_u16(
        response["status"]
            .as_u64()
            .expect("the fixture pins every status") as u16,
    )
    .expect("valid status code");
    HttpResponse::json(status, &response["body"])
}

fn context(secret: &str) -> ProviderExecutionContext {
    ProviderExecutionContext {
        provider: find_provider("gemini")
            .expect("gemini is in the catalog")
            .clone(),
        account: ProviderAccountRecord {
            id: "acc-1".to_string(),
            provider_id: "gemini".to_string(),
            label: "gemini".to_string(),
            auth_method: ProviderAuthMethod::ApiKey,
            secret_masked: "****".to_string(),
            has_refresh_token: false,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            last_check_at: None,
            last_check_ok: None,
            last_check_message: None,
            encrypted_secret: encrypted_secret_input(
                "aes-256-gcm",
                "default",
                "iv",
                "cipher",
                "tag",
            ),
            encrypted_refresh_token: None,
        },
        secret: secret.to_string(),
    }
}

/// The `WEATHER_TOOL` of the recorder: an OpenAI-style function tool.
fn weather_tool() -> Value {
    json!([{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Current weather for a city",
            "parameters": {
                "type": "object",
                "properties": { "city": { "type": "string", "description": "City name" } },
                "required": ["city"]
            }
        }
    }])
}

/// Drives the adapter call the scenario recorded, asserting the adapter-level
/// results that `driveAdapter()` in the recorder also asserts.
async fn drive(scenario: &str, transport: &FixtureTransport) {
    let env = EnvOverrides::new();
    let call = ProviderCall {
        transport,
        attachments: &NOOP_ATTACHMENT_STORE,
        env: &env,
    };
    let adapter = GeminiAdapter;

    match scenario {
        "fetchModels ok" => {
            let models = adapter
                .fetch_models(&context(SECRET), &call)
                .await
                .expect("fetchModels");
            let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
            assert_eq!(ids, vec!["gemini-2.5-flash", "gemini-2.5-pro"]);
            assert_eq!(models[0].name, "Gemini 2.5 Flash");
            assert_eq!(models[0].context_window, Some(1_048_576.0));
        }
        "fetchModels 401" => {
            let models = adapter
                .fetch_models(&context(SECRET), &call)
                .await
                .expect("a 401 is not an error");
            assert!(models.is_empty(), "{models:?}");
        }
        "testConnectivity ping" => {
            let result = adapter
                .test_connectivity(&context(SECRET), &call, None)
                .await;
            assert!(result.ok, "{}", result.message);
            assert_eq!(result.message, "Gemini connectivity verified.");
        }
        "dispatchGateway text" => {
            let mut request = GatewayRequest::new(
                "gemini-2.5-flash",
                vec![
                    GatewayMessage::new(GatewayRole::System, "You are a test."),
                    GatewayMessage::user("Say pong"),
                ],
            );
            request.max_tokens = Some(64);
            request.temperature = Some(0.5);
            let response = adapter
                .dispatch_gateway(
                    &context(SECRET),
                    &call,
                    &request,
                    &DispatchOptions::default(),
                )
                .await
                .expect("dispatchGateway");

            assert!(response.ok);
            assert_eq!(response.text, "pong");
            assert_eq!(response.model, "gemini-2.5-flash");
            assert_eq!(response.provider, "gemini");
            assert_eq!(
                response.usage,
                Some(GatewayUsage {
                    prompt_tokens: 3,
                    completion_tokens: 1,
                    total_tokens: 4,
                })
            );
            assert!(response.function_calls.is_none());
        }
        "dispatchGateway function call" => {
            let mut request = GatewayRequest::new(
                "gemini-2.5-flash",
                vec![GatewayMessage::user("Wetter in Berlin?")],
            );
            request.tools = weather_tool().as_array().cloned();
            let response = adapter
                .dispatch_gateway(
                    &context(SECRET),
                    &call,
                    &request,
                    &DispatchOptions::default(),
                )
                .await
                .expect("dispatchGateway");

            assert!(response.ok);
            let calls = response.function_calls.expect("function calls");
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].name, "get_weather");
            assert_eq!(calls[0].args, Some(json!({ "city": "Berlin" })));
        }
        other => panic!("unhandled recorded scenario: {other}"),
    }
}

/// Asserts the request the adapter sent against the recorded one.
fn assert_request(scenario: &str, expected: &Value, actual: &HttpRequest) {
    assert_eq!(
        actual.method.as_str(),
        expected["method"].as_str().expect("recorded method"),
        "{scenario}: HTTP method"
    );

    // The recorder redacts the key to `[REDACTED]`; the adapter sends the real one.
    let expected_url = expected["url"]
        .as_str()
        .expect("recorded url")
        .replace("[REDACTED]", SECRET);
    assert_eq!(actual.url, expected_url, "{scenario}: URL");

    for (name, value) in expected["headers"].as_object().expect("recorded headers") {
        let expected_value = value
            .as_str()
            .expect("recorded header value")
            .replace("[REDACTED]", SECRET);
        let actual_value = actual
            .headers
            .get(name.as_str())
            .unwrap_or_else(|| panic!("{scenario}: missing header {name}"))
            .to_str()
            .expect("ascii header value");
        assert_eq!(actual_value, expected_value, "{scenario}: header {name}");
    }

    match &expected["body"] {
        Value::Null => assert!(
            actual.body.is_none(),
            "{scenario}: no body expected, got {:?}",
            actual.body
        ),
        expected_body => {
            let raw = actual
                .body
                .as_deref()
                .unwrap_or_else(|| panic!("{scenario}: missing body"));
            let actual_body: Value = serde_json::from_str(raw).expect("body is JSON");
            assert_eq!(
                &actual_body, expected_body,
                "{scenario}: semantic body mismatch"
            );
        }
    }
}

/// Every recorded exchange replays against the Rust adapter and produces the
/// same request.
#[tokio::test]
async fn every_recorded_exchange_replays_against_the_rust_adapter() {
    let fixture = fixture();
    let exchanges = fixture["exchanges"].as_array().expect("exchanges array");
    assert_eq!(
        exchanges.len(),
        5,
        "the recorder writes five exchanges; regenerate the fixture when this changes"
    );

    for exchange in exchanges {
        let scenario = exchange["scenario"].as_str().expect("scenario");
        let transport = FixtureTransport::new(recorded_response(&exchange["response"]));
        drive(scenario, &transport).await;

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen.len(), 1, "{scenario}: exactly one HTTP call");
        assert_request(scenario, &exchange["request"], &seen[0]);
    }
}
