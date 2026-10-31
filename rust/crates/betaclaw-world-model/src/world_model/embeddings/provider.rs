//! Port of `src/server/world-model/embeddings/provider.ts:1-135` — the embedding
//! provider of the semantic recall branch and its in-flight de-duplication.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `provider.ts:4-8` (`EmbeddingProvider`) | [`EmbeddingProvider`] |
//! | `provider.ts:10` (`inFlightEmbeddings`) | [`IN_FLIGHT`] |
//! | `provider.ts:17-34` (`generateEmbeddingOnce`) | [`generate_embedding_once`] |
//! | `provider.ts:83-90` (`configuredEmbeddingUrl`) | [`configured_embedding_url`] |
//! | `provider.ts:92-135` (`getConfiguredEmbeddingProvider`) | [`configured_embedding_provider`] |
//! | `provider.ts:102-133` (the `fetch` of the env provider) | [`HttpEmbeddingProvider::generate_embedding`] |
//!
//! # Deviations
//!
//! 1. **The provider is a trait with accessors.** `provider.ts:5-6` are two
//!    properties; a Rust trait exposes them as [`EmbeddingProvider::model`] and
//!    [`EmbeddingProvider::model_version`]. The de-duplication key is built from
//!    exactly those two values and the text (`:21`).
//! 2. **The in-flight map holds a `Shared` future.** `:10` stores a `Promise` and
//!    `:23` returns the very same promise to a second caller. Rust stores
//!    `futures_util::future::Shared` of the boxed operation, so two callers
//!    awaiting the same key receive the same `Result`. The `finally` block
//!    (`:29-33`) becomes an unconditional removal after the await: the map entry
//!    can only be replaced after the running operation has left the map, so the
//!    `get(key) === operation` guard of the source cannot be violated.
//! 3. **`fetch` is the ported transport seam.** `betaclaw-core` owns no HTTP
//!    client (`model_hub/http.rs:233-236`); the env provider builds an
//!    `HttpRequest` whose deadline is `Math.max(1000, Number(
//!    EMBEDDING_TIMEOUT_MS) || 15_000)` (`:104-107`) and sends it through
//!    `fetch_with_timeout`.
//! 4. **The Model Hub branch is a callback.** `resolveModelHubEmbeddingProvider`
//!    (`:36-81`) reads `getModelHubService()`, which belongs to the Model Hub
//!    slice; the port takes `model_hub_fallback: Option<&dyn Fn() -> Option<Arc<dyn
//!    EmbeddingProvider>>>`, so the fallback chain of `:95` is intact without
//!    duplicating that slice's surface. The callback returning `None` is the
//!    `catch { return null }` of `:76-80`.
//! 5. **The environment is a map.** `:84-98` read `process.env`; the port takes
//!    `&HashMap<String, String>` like the rest of the slice, so a test is
//!    independent of the process.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use futures_util::future::Shared;
use futures_util::FutureExt;
use http::Method;
use serde_json::Value;

use crate::js::js_number_str;
use crate::model_hub::http::{fetch_with_timeout, HttpRequest, HttpTransport};
use crate::world_model::db::BoxFuture;

/// The failure of an embedding call — the `throw new Error(...)` of `:58`, `:71`,
/// `:123`, `:127`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct EmbeddingError {
    pub message: String,
}

impl EmbeddingError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// `EmbeddingProvider` from `provider.ts:4-8`.
pub trait EmbeddingProvider: Send + Sync {
    /// `provider.model` (`:5`).
    fn model(&self) -> &str;
    /// `provider.modelVersion` (`:6`).
    fn model_version(&self) -> &str;
    /// `provider.generateEmbedding(text)` (`:7`).
    fn generate_embedding<'a>(
        &'a self,
        text: &'a str,
    ) -> BoxFuture<'a, Result<Vec<f64>, EmbeddingError>>;
}

/// `provider.ts:21`.
fn in_flight_key(provider: &dyn EmbeddingProvider, text: &str) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        provider.model(),
        provider.model_version(),
        text
    )
}

/// The shared in-flight operation of one key.
type SharedEmbedding = Shared<BoxFuture<'static, Result<Vec<f64>, EmbeddingError>>>;

/// `inFlightEmbeddings` from `provider.ts:10`.
pub static IN_FLIGHT: LazyLock<Mutex<HashMap<String, SharedEmbedding>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// `generateEmbeddingOnce(provider, text)` — `provider.ts:17-34`.
pub async fn generate_embedding_once(
    provider: Arc<dyn EmbeddingProvider>,
    text: &str,
) -> Result<Vec<f64>, EmbeddingError> {
    let key = in_flight_key(provider.as_ref(), text);
    let operation = {
        let mut in_flight = IN_FLIGHT.lock().expect("in-flight mutex");
        match in_flight.get(&key) {
            Some(running) => running.clone(),
            None => {
                let text = text.to_string();
                let running: BoxFuture<'static, Result<Vec<f64>, EmbeddingError>> = {
                    let provider = Arc::clone(&provider);
                    Box::pin(async move { provider.generate_embedding(&text).await })
                };
                let shared = running.shared();
                in_flight.insert(key.clone(), shared.clone());
                shared
            }
        }
    };

    let result = operation.await;
    // `finally { if (inFlightEmbeddings.get(key) === operation) delete … }`.
    IN_FLIGHT.lock().expect("in-flight mutex").remove(&key);
    result
}

/// `configuredEmbeddingUrl()` — `provider.ts:83-90`.
pub fn configured_embedding_url(env: &HashMap<String, String>) -> Option<String> {
    let explicit = env
        .get("EMBEDDING_API_URL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if explicit.is_some() {
        return explicit;
    }
    let base = env
        .get("OPENAI_BASE_URL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(base) = base {
        // `${base.replace(/\/$/, '')}/embeddings` — `:87`.
        return Some(format!("{}/embeddings", base.trim_end_matches('/')));
    }
    if env
        .get("OPENAI_API_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return Some("https://api.openai.com/v1/embeddings".to_string());
    }
    None
}

/// `Math.max(1000, Number(process.env.EMBEDDING_TIMEOUT_MS) || 15_000)` —
/// `provider.ts:104-107`.
pub fn embedding_timeout_ms(env: &HashMap<String, String>) -> u64 {
    let configured = env
        .get("EMBEDDING_TIMEOUT_MS")
        .map(|value| js_number_str(value))
        .unwrap_or(f64::NAN);
    // `Number('')` is `0` and `Number('abc')` is `NaN`, both falsy for `||`.
    let effective = if configured == 0.0 || configured.is_nan() {
        15_000.0
    } else {
        configured
    };
    effective.max(1_000.0) as u64
}

/// The `fetch`-based provider of `provider.ts:99-134`.
pub struct HttpEmbeddingProvider {
    url: String,
    api_key: String,
    model: String,
    model_version: String,
    timeout_ms: u64,
    transport: Arc<dyn HttpTransport>,
}

impl HttpEmbeddingProvider {
    /// The object literal of `provider.ts:99-101`.
    pub fn new(
        url: impl Into<String>,
        api_key: impl Into<String>,
        model: impl Into<String>,
        model_version: impl Into<String>,
        timeout_ms: u64,
        transport: Arc<dyn HttpTransport>,
    ) -> Self {
        Self {
            url: url.into(),
            api_key: api_key.into(),
            model: model.into(),
            model_version: model_version.into(),
            timeout_ms,
            transport,
        }
    }

    /// The request of `provider.ts:109-117`, as the seam sees it.
    pub fn request_body(&self, text: &str) -> Value {
        serde_json::json!({ "model": self.model, "input": text })
    }
}

impl EmbeddingProvider for HttpEmbeddingProvider {
    fn model(&self) -> &str {
        &self.model
    }

    fn model_version(&self) -> &str {
        &self.model_version
    }

    /// `provider.ts:102-133`.
    fn generate_embedding<'a>(
        &'a self,
        text: &'a str,
    ) -> BoxFuture<'a, Result<Vec<f64>, EmbeddingError>> {
        Box::pin(async move {
            let authorization = format!("Bearer {}", self.api_key);
            let request = HttpRequest::new(Method::POST, self.url.clone())
                .header("authorization", &authorization)
                .header("content-type", "application/json")
                .json_body(&self.request_body(text))
                .timeout_ms(self.timeout_ms);
            let response = fetch_with_timeout(self.transport.as_ref(), request)
                .await
                .map_err(|error| EmbeddingError::new(error.to_string()))?;

            // `await response.json().catch(() => ({}))` — `:118`.
            let body: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
            if !response.status.is_success() {
                let message = body
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .filter(|message| !message.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        format!("embedding provider HTTP {}", response.status.as_u16())
                    });
                return Err(EmbeddingError::new(message));
            }

            // `body.data?.[0]?.embedding` — `:125`.
            let embedding = body
                .get("data")
                .and_then(Value::as_array)
                .and_then(|data| data.first())
                .and_then(|first| first.get("embedding"));
            match embedding {
                Some(Value::Array(values))
                    if values.iter().all(|value| value.as_f64().is_some()) =>
                {
                    Ok(values.iter().filter_map(Value::as_f64).collect())
                }
                _ => Err(EmbeddingError::new(
                    "embedding provider returned no numeric vector",
                )),
            }
        })
    }
}

/// `getConfiguredEmbeddingProvider()` — `provider.ts:92-135`.
pub fn configured_embedding_provider(
    env: &HashMap<String, String>,
    transport: Arc<dyn HttpTransport>,
    model_hub_fallback: Option<&dyn Fn() -> Option<Arc<dyn EmbeddingProvider>>>,
) -> Option<Arc<dyn EmbeddingProvider>> {
    let url = configured_embedding_url(env);
    // `(process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY)?.trim()`
    // — `:94`.
    let api_key = env
        .get("EMBEDDING_API_KEY")
        .or_else(|| env.get("OPENAI_API_KEY"))
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let (Some(url), false) = (url, api_key.is_empty()) else {
        return model_hub_fallback.and_then(|fallback| fallback());
    };

    // `process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-small'` — `:97`.
    let model = env
        .get("EMBEDDING_MODEL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "text-embedding-3-small".to_string());
    let model_version = env
        .get("EMBEDDING_MODEL_VERSION")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "1".to_string());

    Some(Arc::new(HttpEmbeddingProvider::new(
        url,
        api_key,
        model,
        model_version,
        embedding_timeout_ms(env),
        transport,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::http::{HttpError, HttpResponse};
    use crate::world_model::db::drive_sync;
    use http::{HeaderMap, StatusCode};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    /// A provider that counts its calls and yields the runtime once, so a second
    /// concurrent caller reaches the map while the first one is running.
    struct CountingProvider {
        calls: Arc<AtomicUsize>,
        result: Result<Vec<f64>, EmbeddingError>,
    }

    impl EmbeddingProvider for CountingProvider {
        fn model(&self) -> &str {
            "counting"
        }

        fn model_version(&self) -> &str {
            "1"
        }

        fn generate_embedding<'a>(
            &'a self,
            _text: &'a str,
        ) -> BoxFuture<'a, Result<Vec<f64>, EmbeddingError>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                self.result.clone()
            })
        }
    }

    #[derive(Default)]
    struct ScriptTransport {
        requests: Mutex<Vec<HttpRequest>>,
        responses: Mutex<VecDeque<HttpResponse>>,
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
                .unwrap_or_else(|| HttpResponse::new(StatusCode::OK, HeaderMap::new(), "{}"));
            Box::pin(async move { Ok(response) })
        }
    }

    #[test]
    fn two_concurrent_calls_for_the_same_key_share_one_provider_call() {
        let calls = Arc::new(AtomicUsize::new(0));
        let provider: Arc<dyn EmbeddingProvider> = Arc::new(CountingProvider {
            calls: Arc::clone(&calls),
            result: Ok(vec![1.0, 2.0]),
        });
        let first = generate_embedding_once(Arc::clone(&provider), "same text");
        let second = generate_embedding_once(Arc::clone(&provider), "same text");
        let (first, second) =
            drive_sync(async { futures_util::future::join(first, second).await }).expect("bridge");
        let first: Result<Vec<f64>, EmbeddingError> = first;
        let second: Result<Vec<f64>, EmbeddingError> = second;
        assert_eq!(first.expect("first"), vec![1.0, 2.0]);
        assert_eq!(second.expect("second"), vec![1.0, 2.0]);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "one provider call for both"
        );
        assert!(
            IN_FLIGHT.lock().expect("in-flight mutex").is_empty(),
            "the entry is removed after the call, so nothing is cached"
        );
    }

    #[test]
    fn a_failure_does_not_poison_the_next_call() {
        let calls = Arc::new(AtomicUsize::new(0));
        let failing: Arc<dyn EmbeddingProvider> = Arc::new(CountingProvider {
            calls: Arc::clone(&calls),
            result: Err(EmbeddingError::new("boom")),
        });
        let error = drive_sync(generate_embedding_once(Arc::clone(&failing), "text"))
            .expect("bridge")
            .expect_err("failure");
        assert_eq!(error.message, "boom");
        assert!(IN_FLIGHT.lock().expect("in-flight mutex").is_empty());

        let working: Arc<dyn EmbeddingProvider> = Arc::new(CountingProvider {
            calls: Arc::clone(&calls),
            result: Ok(vec![3.0]),
        });
        let value = drive_sync(generate_embedding_once(working, "text"))
            .expect("bridge")
            .expect("value");
        assert_eq!(value, vec![3.0]);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_url_follows_the_source_fallback_chain() {
        assert_eq!(
            configured_embedding_url(&env(&[("EMBEDDING_API_URL", " http://x/v1/embeddings ")])),
            Some("http://x/v1/embeddings".to_string())
        );
        assert_eq!(
            configured_embedding_url(&env(&[("OPENAI_BASE_URL", "http://x/v1/")])),
            Some("http://x/v1/embeddings".to_string())
        );
        assert_eq!(
            configured_embedding_url(&env(&[("OPENAI_API_KEY", "sk-test")])),
            Some("https://api.openai.com/v1/embeddings".to_string())
        );
        // An empty explicit URL is falsy and falls through to the base URL.
        assert_eq!(
            configured_embedding_url(&env(&[
                ("EMBEDDING_API_URL", "  "),
                ("OPENAI_BASE_URL", "http://y"),
            ])),
            Some("http://y/embeddings".to_string())
        );
        assert_eq!(configured_embedding_url(&env(&[])), None);
    }

    #[test]
    fn the_timeout_is_max_of_one_second_and_the_falling_back_fifteen() {
        assert_eq!(embedding_timeout_ms(&env(&[])), 15_000);
        assert_eq!(
            embedding_timeout_ms(&env(&[("EMBEDDING_TIMEOUT_MS", "")])),
            15_000
        );
        assert_eq!(
            embedding_timeout_ms(&env(&[("EMBEDDING_TIMEOUT_MS", "abc")])),
            15_000
        );
        assert_eq!(
            embedding_timeout_ms(&env(&[("EMBEDDING_TIMEOUT_MS", "500")])),
            1_000
        );
        assert_eq!(
            embedding_timeout_ms(&env(&[("EMBEDDING_TIMEOUT_MS", "30000")])),
            30_000
        );
    }

    #[test]
    fn without_a_url_or_key_the_model_hub_fallback_decides() {
        let transport = Arc::new(ScriptTransport::default());
        let fallback_calls = AtomicUsize::new(0);
        let fallback = || {
            fallback_calls.fetch_add(1, Ordering::SeqCst);
            None
        };
        assert!(
            configured_embedding_provider(&env(&[]), transport.clone(), Some(&fallback)).is_none()
        );
        assert_eq!(fallback_calls.load(Ordering::SeqCst), 1);
        // A URL without any key also takes the fallback (`:95`).
        assert!(configured_embedding_provider(
            &env(&[("OPENAI_BASE_URL", "http://x/v1")]),
            transport.clone(),
            Some(&fallback)
        )
        .is_none());
        assert_eq!(fallback_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_environment_provider_uses_the_default_model_and_version() {
        let transport = Arc::new(ScriptTransport::default());
        let provider = configured_embedding_provider(
            &env(&[
                ("EMBEDDING_API_URL", "http://x/v1/embeddings"),
                ("EMBEDDING_API_KEY", "k"),
            ]),
            transport,
            None,
        )
        .expect("provider");
        assert_eq!(provider.model(), "text-embedding-3-small");
        assert_eq!(provider.model_version(), "1");
    }

    #[test]
    fn the_http_provider_maps_the_error_message_and_rejects_invalid_vectors() {
        let transport = Arc::new(ScriptTransport::default());
        transport
            .responses
            .lock()
            .expect("responses")
            .push_back(HttpResponse::new(
                StatusCode::BAD_REQUEST,
                HeaderMap::new(),
                r#"{"error":{"message":"boom"}}"#,
            ));
        let provider = HttpEmbeddingProvider::new(
            "http://x/v1/embeddings",
            "k",
            "m",
            "1",
            1_000,
            transport.clone(),
        );
        let error = drive_sync(provider.generate_embedding("text"))
            .expect("bridge")
            .expect_err("error message");
        assert_eq!(error.message, "boom");
        let request = transport.requests.lock().expect("requests")[0].clone();
        assert_eq!(request.method, Method::POST);
        assert_eq!(request.url, "http://x/v1/embeddings");
        assert_eq!(request.timeout_ms, 1_000);
        assert_eq!(request.headers.get("authorization").unwrap(), "Bearer k");
        assert_eq!(
            serde_json::from_str::<Value>(request.body.as_deref().unwrap()).unwrap(),
            serde_json::json!({ "model": "m", "input": "text" })
        );

        // A 200 with a non-numeric vector is rejected with the source literal.
        transport
            .responses
            .lock()
            .expect("responses")
            .push_back(HttpResponse::new(
                StatusCode::OK,
                HeaderMap::new(),
                r#"{"data":[{"embedding":["x"]}]}"#,
            ));
        let error = drive_sync(provider.generate_embedding("text"))
            .expect("bridge")
            .expect_err("invalid vector");
        assert_eq!(
            error.message,
            "embedding provider returned no numeric vector"
        );

        transport
            .responses
            .lock()
            .expect("responses")
            .push_back(HttpResponse::new(
                StatusCode::OK,
                HeaderMap::new(),
                r#"{"data":[{"embedding":[0.5,1]}]}"#,
            ));
        let vector = drive_sync(provider.generate_embedding("text"))
            .expect("bridge")
            .expect("vector");
        assert_eq!(vector, vec![0.5, 1.0]);
    }
}
