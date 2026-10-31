//! Port of `src/server/model-hub/Models/openai-codex/`.
//!
//! The Codex backend is **not** OpenAI-compatible: it speaks the Responses wire
//! format against `https://chatgpt.com/backend-api/codex/responses`, answers
//! with its own SSE event names, requires the `chatgpt-account-id` header taken
//! from the access-token JWT, and reports its rate limits twice — once in
//! response headers, once in a separate `/wham/usage` payload. The port is
//! therefore end to end, with no reuse of the shared OpenAI-compatible layer.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`constants`] | `constants.ts` |
//! | [`types`] | `types.ts` |
//! | [`utils`] | `utils/typeGuards.ts`, `utils/models.ts` |
//! | [`parsers`] | `parsers/` |
//! | [`mappers`] | `mappers/` |
//! | [`attachments`] | `attachments/attachmentHandler.ts` |
//! | [`client`] | `client/config.ts`, `client/dispatch.ts`, `client/usage.ts` |
//! | [`connectivity`] | `connectivity/testConnectivity.ts` |
//! | [`OpenAiCodexAdapter`] | `openai-codex/index.ts:6-23` |

pub mod attachments;
pub mod client;
pub mod connectivity;
pub mod constants;
pub mod mappers;
pub mod parsers;
pub mod types;
pub mod utils;

use crate::model_hub::http::{BoxFuture, HttpError};
use crate::model_hub::types::{
    ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse, ProviderExecutionContext,
};

use super::{ProviderAdapter, ProviderCall};

/// `id: 'openai-codex'` from `openai-codex/index.ts:7`.
pub const PROVIDER_ID: &str = "openai-codex";

/// `openAICodexProviderAdapter` from `openai-codex/index.ts:6-23`.
///
/// `fetchModels` is pure: the Codex backend exposes no model listing, so the
/// adapter merges the catalog's `defaultModels` with the static
/// [`constants::CODEX_MODEL_SEED`] and ignores `context.secret` entirely.
#[derive(Debug, Clone, Copy, Default)]
pub struct OpenAiCodexAdapter;

impl ProviderAdapter for OpenAiCodexAdapter {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    /// `fetchModels: async ({ provider }) => mergeUniqueModels(buildCodexSeedModels(provider.defaultModels), [])`
    /// (`index.ts:8-11`).
    fn fetch_models<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        _call: &'a ProviderCall<'_>,
    ) -> BoxFuture<'a, Result<Vec<FetchedModel>, HttpError>> {
        Box::pin(async move {
            let seed = utils::build_codex_seed_models(&context.provider.default_models);
            Ok(utils::merge_unique_models(seed, Vec::new()))
        })
    }

    /// `testConnectivity: ({ secret, provider }, options) => …` (`index.ts:12-17`).
    fn test_connectivity<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        model: Option<&'a str>,
    ) -> BoxFuture<'a, ConnectivityResult> {
        Box::pin(async move {
            connectivity::test_openai_codex_connectivity(
                call.transport,
                call.attachments,
                &context.secret,
                &context.provider.default_models,
                model,
            )
            .await
        })
    }

    /// `dispatchGateway: ({ secret }, request, options) => …` (`index.ts:18-22`).
    ///
    /// The adapter never fails: `dispatch_codex_responses` folds every error into
    /// an `ok: false` response, which is why the `Result` is always `Ok`.
    fn dispatch_gateway<'a>(
        &'a self,
        context: &'a ProviderExecutionContext,
        call: &'a ProviderCall<'_>,
        request: &'a GatewayRequest,
        options: &'a crate::model_hub::openai_compatible::DispatchOptions,
    ) -> BoxFuture<'a, Result<GatewayResponse, HttpError>> {
        Box::pin(async move {
            let callback = options.on_stream_delta.clone();
            let response = match callback {
                Some(callback) => {
                    let mut sink = move |delta: &str| callback(delta);
                    client::dispatch::dispatch_codex_responses(
                        call.transport,
                        call.attachments,
                        &context.secret,
                        request,
                        options.abort.clone(),
                        Some(&mut sink),
                    )
                    .await
                }
                None => {
                    client::dispatch::dispatch_codex_responses(
                        call.transport,
                        call.attachments,
                        &context.secret,
                        request,
                        options.abort.clone(),
                        None,
                    )
                    .await
                }
            };
            Ok(response)
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use http::{HeaderMap, HeaderValue, StatusCode};
    use serde_json::{json, Value};

    use super::*;
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::{HttpRequest, HttpResponse, HttpTransport};
    use crate::model_hub::openai_compatible::utils::{AttachmentStore, NOOP_ATTACHMENT_STORE};
    use crate::model_hub::openai_compatible::DispatchOptions;
    use crate::model_hub::provider_catalog::find_provider;
    use crate::model_hub::repository::encrypted_secret_input;
    use crate::model_hub::types::{
        GatewayMessage, GatewayMessageAttachment, ProviderAccountRecord, ProviderAuthMethod,
    };

    /// `buildCodexAccessToken` from `openai-codex-models.test.ts:6-15`.
    fn codex_access_token(account_id: &str) -> String {
        let mut auth = serde_json::Map::new();
        auth.insert(
            client::config::CODEX_AUTH_CLAIM_FIELD.to_string(),
            Value::from(account_id),
        );
        let mut payload = serde_json::Map::new();
        payload.insert(
            client::config::CODEX_AUTH_CLAIM_PATH.to_string(),
            Value::Object(auth),
        );
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(Value::Object(payload).to_string())
        )
    }

    /// Replays one scripted response per request and records every request.
    struct ScriptedTransport {
        responses: Mutex<VecDeque<HttpResponse>>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl ScriptedTransport {
        fn new(responses: Vec<HttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                seen: Mutex::new(Vec::new()),
            }
        }

        fn event_stream(body: &str) -> Self {
            Self::new(vec![HttpResponse::event_stream(body)])
        }

        fn requests(&self) -> Vec<HttpRequest> {
            self.seen.lock().expect("lock").clone()
        }
    }

    impl HttpTransport for ScriptedTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen.lock().expect("lock").push(request.clone());
            let response = self
                .responses
                .lock()
                .expect("lock")
                .pop_front()
                .expect("scripted response");
            Box::pin(async move { Ok(response) })
        }
    }

    /// An [`AttachmentStore`] over an in-memory path map.
    struct MapStore {
        files: std::collections::HashMap<String, Vec<u8>>,
    }

    impl MapStore {
        fn with_file(path: &str, bytes: &[u8]) -> Self {
            let mut files = std::collections::HashMap::new();
            files.insert(path.to_string(), bytes.to_vec());
            Self { files }
        }
    }

    impl AttachmentStore for MapStore {
        fn read(&self, attachment: &GatewayMessageAttachment) -> Result<Vec<u8>, String> {
            self.files
                .get(&attachment.storage_path)
                .cloned()
                .ok_or_else(|| "no such attachment".to_string())
        }
    }

    fn call<'a>(transport: &'a ScriptedTransport, env: &'a EnvOverrides) -> ProviderCall<'a> {
        ProviderCall {
            transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env,
        }
    }

    fn context(secret: &str) -> ProviderExecutionContext {
        ProviderExecutionContext {
            provider: find_provider(PROVIDER_ID)
                .expect("openai-codex is in the catalog")
                .clone(),
            account: ProviderAccountRecord {
                id: "acc-1".to_string(),
                provider_id: PROVIDER_ID.to_string(),
                label: "openai-codex".to_string(),
                auth_method: ProviderAuthMethod::Oauth,
                secret_masked: "****".to_string(),
                has_refresh_token: true,
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

    fn header(request: &HttpRequest, name: &str) -> String {
        request
            .headers
            .get(name)
            .map(|value| value.to_str().unwrap_or_default().to_string())
            .unwrap_or_default()
    }

    fn body_of(request: &HttpRequest) -> Value {
        serde_json::from_str(request.body.as_deref().expect("body")).expect("json body")
    }

    /// `openai-codex-models.test.ts:22-65`: the catalog list *is* the seed, and
    /// the result is the merged, deduplicated list.
    #[tokio::test]
    async fn fetch_models_returns_the_seed() {
        let transport = ScriptedTransport::new(Vec::new());
        let env = EnvOverrides::new();
        let context = context("token");
        let models = OpenAiCodexAdapter
            .fetch_models(&context, &call(&transport, &env))
            .await
            .expect("models");

        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, constants::CODEX_MODEL_SEED.to_vec());
        assert_eq!(models[0].provider, "openai-codex");
        assert!(transport.requests().is_empty(), "fetchModels is pure");
    }

    /// `openai-codex-models.test.ts:90-152`: the request goes to the ChatGPT
    /// backend with the Codex headers, the wire body carries the Responses
    /// fields — and never the caller's `temperature`.
    #[tokio::test]
    async fn dispatch_posts_to_the_chatgpt_backend_with_codex_headers() {
        let transport = ScriptedTransport::event_stream(concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",",
            "\"model\":\"gpt-5.3-codex\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1,",
            "\"total_tokens\":3}}}\n"
        ));
        let env = EnvOverrides::new();
        let token = codex_access_token("acct_dispatch");
        let context = context(&token);

        let mut request = GatewayRequest::new("gpt-5.3-codex", vec![GatewayMessage::user("ping")]);
        request.temperature = Some(0.7);

        let response = OpenAiCodexAdapter
            .dispatch_gateway(
                &context,
                &call(&transport, &env),
                &request,
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(response.ok, "{:?}", response.error);
        assert_eq!(response.text, "hello");
        assert_eq!(response.provider, "openai-codex");
        assert_eq!(response.model, "gpt-5.3-codex");

        let seen = transport.requests();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0].url,
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(seen[0].timeout_ms, constants::CODEX_REQUEST_TIMEOUT_MS);
        assert_eq!(header(&seen[0], "chatgpt-account-id"), "acct_dispatch");
        assert_eq!(header(&seen[0], "OpenAI-Beta"), "responses=experimental");
        assert_eq!(header(&seen[0], "Authorization"), format!("Bearer {token}"));
        assert_eq!(header(&seen[0], "Content-Type"), "application/json");
        assert_eq!(header(&seen[0], "Accept"), "text/event-stream");
        assert_eq!(header(&seen[0], "originator"), "pi");
        assert_eq!(header(&seen[0], "User-Agent"), "clawtest-model-hub");

        let body = body_of(&seen[0]);
        assert_eq!(body["model"], json!("gpt-5.3-codex"));
        assert_eq!(body["store"], json!(false));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
        assert_eq!(body["tool_choice"], json!("auto"));
        assert_eq!(body["parallel_tool_calls"], json!(true));
        assert_eq!(body["text"], json!({ "verbosity": "medium" }));
        assert_eq!(
            body["input"],
            json!([{ "role": "user", "content": [{ "type": "input_text", "text": "ping" }] }])
        );
        assert!(body.get("temperature").is_none());
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("reasoning").is_none(), "no reasoning_effort given");
        assert!(
            body["instructions"]
                .as_str()
                .is_some_and(|instructions| !instructions.is_empty()),
            "{:?}",
            body["instructions"]
        );
        assert_eq!(
            body["instructions"],
            json!("You are a helpful coding assistant.")
        );
    }

    /// `openai-codex-models.test.ts:202-280`: an image of the latest user
    /// message becomes an `input_image` part with a data URL, and an earlier
    /// one degrades to the placeholder text.
    #[tokio::test]
    async fn only_the_latest_user_message_reads_binary_attachments() {
        let transport = ScriptedTransport::event_stream(concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"gesehen\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",",
            "\"model\":\"gpt-5.3-codex\"}}\n"
        ));
        let env = EnvOverrides::new();
        let png = base64::engine::general_purpose::STANDARD
            .decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9N5R8AAAAASUVORK5CYII=",
            )
            .expect("png");
        let store = MapStore::with_file("pixel.png", &png);
        let token = codex_access_token("acct_dispatch");
        let context = context(&token);
        let call = ProviderCall {
            transport: &transport,
            attachments: &store,
            env: &env,
        };

        let attachment = |name: &str| GatewayMessageAttachment {
            name: name.to_string(),
            mime_type: "image/png".to_string(),
            size: png.len() as i64,
            storage_path: "pixel.png".to_string(),
            sha256: None,
        };
        let mut first = GatewayMessage::user("früher");
        first.attachments = Some(vec![attachment("old.png")]);
        let mut latest = GatewayMessage::user("Was siehst du?");
        latest.attachments = Some(vec![attachment("pixel.png")]);

        let request = GatewayRequest::new("gpt-5.3-codex", vec![first, latest]);
        let response = OpenAiCodexAdapter
            .dispatch_gateway(&context, &call, &request, &DispatchOptions::default())
            .await
            .expect("dispatch");
        assert!(response.ok, "{:?}", response.error);
        assert_eq!(response.text, "gesehen");

        let seen = transport.requests();
        let body = body_of(&seen[0]);
        let input = body["input"].as_array().expect("input");
        assert_eq!(input.len(), 2);

        // The earlier user message keeps the placeholder text.
        assert_eq!(
            input[0]["content"],
            json!([{
                "type": "input_text",
                "text": "früher"
            }, {
                "type": "input_text",
                "text": "[Attachment: old.png (image/png, 68 bytes)]"
            }])
        );

        // The latest one carries the image.
        let parts = input[1]["content"].as_array().expect("parts");
        assert_eq!(parts[0]["type"], json!("input_text"));
        assert_eq!(parts[1]["type"], json!("input_image"));
        assert!(
            parts[1]["image_url"]
                .as_str()
                .is_some_and(|url| url.starts_with("data:image/png;base64,")),
            "{:?}",
            parts[1]["image_url"]
        );
    }

    /// A secret without the JWT claim fails before any request is made, for the
    /// probe *and* for the usage call.
    #[tokio::test]
    async fn a_missing_claim_short_circuits_the_probe() {
        let transport = ScriptedTransport::new(Vec::new());
        let env = EnvOverrides::new();
        let context = context("header.e30.signature");

        let result = OpenAiCodexAdapter
            .test_connectivity(&context, &call(&transport, &env), None)
            .await;

        assert!(!result.ok);
        assert!(
            result.message.contains("chatgpt_account_id"),
            "{}",
            result.message
        );
        assert!(result.rate_limits.is_none());
        assert!(transport.requests().is_empty());
    }

    /// A non-2xx status becomes `{ ok: false }` with the parsed body message and
    /// the rate limits of the *failed* response (`dispatch.ts:57-68`).
    #[tokio::test]
    async fn a_failed_response_keeps_its_rate_limit_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::HeaderName::from_static("x-codex-ratelimit-limit-1h"),
            HeaderValue::from_static("100"),
        );
        headers.insert(
            http::HeaderName::from_static("x-codex-ratelimit-remaining-1h"),
            HeaderValue::from_static("40"),
        );
        let transport = ScriptedTransport::new(vec![HttpResponse::new(
            StatusCode::TOO_MANY_REQUESTS,
            headers,
            r#"{"error":{"message":"quota exhausted"}}"#,
        )]);
        let env = EnvOverrides::new();
        let token = codex_access_token("acct");

        let response = OpenAiCodexAdapter
            .dispatch_gateway(
                &context(&token),
                &call(&transport, &env),
                &GatewayRequest::new("gpt-5.3-codex", vec![GatewayMessage::user("ping")]),
                &DispatchOptions::default(),
            )
            .await
            .expect("dispatch");

        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("quota exhausted"));
        assert_eq!(response.model, "gpt-5.3-codex");
        assert_eq!(response.provider, "openai-codex");
        assert_eq!(response.text, "");
        let rate_limits = response.rate_limits.expect("rate limits");
        assert_eq!(rate_limits.windows.len(), 1);
        assert_eq!(rate_limits.windows[0].window, "1h");
        assert_eq!(rate_limits.windows[0].limit, Some(100.0));
        assert_eq!(rate_limits.windows[0].remaining, Some(40.0));
    }

    /// The adapter's `onStreamDelta` receives every delta in order.
    #[tokio::test]
    async fn the_adapter_streams_each_delta() {
        let transport = ScriptedTransport::event_stream(concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Ich\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\" bin\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-5.3-codex\"}}\n\n"
        ));
        let env = EnvOverrides::new();
        let token = codex_access_token("acct");

        let collected: std::sync::Arc<Mutex<Vec<String>>> = std::sync::Arc::default();
        let sink = {
            let collected = collected.clone();
            std::sync::Arc::new(move |delta: &str| {
                collected.lock().expect("lock").push(delta.to_string())
            }) as crate::model_hub::openai_compatible::StreamDeltaCallback
        };

        let response = OpenAiCodexAdapter
            .dispatch_gateway(
                &context(&token),
                &call(&transport, &env),
                &GatewayRequest::new("gpt-5.3-codex", vec![GatewayMessage::user("ping")]),
                &DispatchOptions::with_stream_delta(sink),
            )
            .await
            .expect("dispatch");

        assert!(response.ok);
        assert_eq!(response.text, "Ich bin");
        assert_eq!(*collected.lock().expect("lock"), vec!["Ich", " bin"]);
    }

    /// `connectivity/testConnectivity.ts:26-32`: the response headers and the
    /// `/wham/usage` snapshot are merged, and the probe model comes from
    /// `options.model`.
    #[tokio::test]
    async fn connectivity_merges_the_header_and_usage_rate_limits() {
        let mut probe_headers = HeaderMap::new();
        probe_headers.insert(
            http::HeaderName::from_static("x-codex-ratelimit-limit-5h"),
            HeaderValue::from_static("1000"),
        );
        probe_headers.insert(
            http::HeaderName::from_static("x-codex-ratelimit-remaining-5h"),
            HeaderValue::from_static("600"),
        );
        let transport = ScriptedTransport::new(vec![
            HttpResponse::new(
                StatusCode::OK,
                probe_headers,
                concat!(
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"pong\"}\n\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"model\":",
                    "\"gpt-5.6\"}}\n\n"
                ),
            ),
            HttpResponse::json(
                StatusCode::OK,
                &json!({
                    "rate_limit": {
                        "primary_window": { "used_percent": 25, "limit_window_seconds": 604800 },
                        "secondary_window": { "used_percent": 40, "limit_window_seconds": 86400 }
                    }
                }),
            ),
        ]);
        let env = EnvOverrides::new();
        let token = codex_access_token("acct");

        let result = OpenAiCodexAdapter
            .test_connectivity(&context(&token), &call(&transport, &env), Some("gpt-5.6"))
            .await;

        assert!(result.ok, "{}", result.message);
        assert_eq!(
            result.message,
            "OpenAI Codex connectivity verified (codex responses reachable with model gpt-5.6)."
        );

        let seen = transport.requests();
        assert_eq!(seen.len(), 2);
        assert_eq!(
            seen[0].url,
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(seen[1].url, "https://chatgpt.com/backend-api/wham/usage");
        assert_eq!(seen[1].method, http::Method::GET);
        assert_eq!(seen[1].timeout_ms, client::usage::CODEX_USAGE_TIMEOUT_MS);
        assert_eq!(header(&seen[1], "Accept"), "application/json");
        assert!(seen[1].body.is_none());

        // The probe is a `ping` for the requested model.
        let probe_body = body_of(&seen[0]);
        assert_eq!(probe_body["model"], json!("gpt-5.6"));
        assert_eq!(
            probe_body["input"],
            json!([{ "role": "user", "content": [{ "type": "input_text", "text": "ping" }] }])
        );

        let windows = result.rate_limits.expect("rate limits").windows;
        let labels: Vec<&str> = windows
            .iter()
            .map(|window| window.window.as_str())
            .collect();
        // Header windows first, then the usage-only ones.
        assert_eq!(labels, vec!["5h", "7d", "1d"]);
        assert_eq!(windows[0].limit, Some(1000.0));
        assert_eq!(windows[0].remaining, Some(600.0));
        assert_eq!(windows[0].used_percent, None);
        assert_eq!(windows[1].used_percent, Some(25.0));
        assert_eq!(windows[2].used_percent, Some(40.0));
    }

    /// `connectivity/testConnectivity.ts:35-39`: a failed probe keeps the prefix
    /// and reports the dispatch error.
    #[tokio::test]
    async fn connectivity_reports_a_probe_failure() {
        let transport = ScriptedTransport::new(vec![
            HttpResponse::text(StatusCode::UNAUTHORIZED, "token expired"),
            HttpResponse::text(StatusCode::UNAUTHORIZED, "token expired"),
        ]);
        let env = EnvOverrides::new();
        let token = codex_access_token("acct");

        let result = OpenAiCodexAdapter
            .test_connectivity(&context(&token), &call(&transport, &env), None)
            .await;

        assert!(!result.ok);
        assert_eq!(
            result.message,
            "OpenAI Codex connectivity failed: token expired"
        );
        assert!(result.rate_limits.is_none());
        // The probe model falls back to the first catalog model.
        let probe_body = body_of(&transport.requests()[0]);
        assert_eq!(probe_body["model"], json!("gpt-5.6"));
    }
}
