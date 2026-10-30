//! Port of `src/server/stats/openRouterPricing.ts`.
//!
//! The list is fetched from `https://openrouter.ai/api/v1/models` through the
//! [`HttpTransport`] seam, with the timeout of `OPENROUTER_PRICING_FETCH_TIMEOUT_MS`.
//! [`OpenRouterPricing`] holds the cache and the fetch; the pure parts are
//! [`OpenRouterPricingCache`]. The TypeScript keeps one cache per process in a
//! global, the gateway owns this value instead.
//!
//! Divergence: the TTL and timeout settings are read once in
//! [`OpenRouterPricing::new`], not on every call as `process.env` is read in TypeScript.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};

use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use super::util::{js_parse_float, js_parse_int, now_ms};
use super::ModelPricing;
use crate::model_hub::http::{fetch_with_timeout, HttpRequest, HttpTransport};

pub const DEFAULT_TTL_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Tier {
    min_context_tokens: i64,
    prompt_price_per_token_usd: f64,
    completion_price_per_token_usd: f64,
    request_price_usd: f64,
}

/// `toNumber`: finite numbers and numeric prefixes of strings, otherwise 0.
fn to_number_or_zero(value: Option<&Value>) -> f64 {
    let parsed = match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => js_parse_float(text),
        _ => None,
    };
    parsed.filter(|number| number.is_finite()).unwrap_or(0.0)
}

/// `parseTier`: only objects describe a tier. `min_context` wins over
/// `minContext` unless it is null.
fn parse_tier(raw: &Value) -> Option<Tier> {
    let row = raw.as_object()?;
    let min_context = match row.get("min_context") {
        Some(value) if !value.is_null() => Some(value),
        _ => row.get("minContext"),
    };
    Some(Tier {
        min_context_tokens: to_number_or_zero(min_context).floor().max(0.0) as i64,
        prompt_price_per_token_usd: to_number_or_zero(row.get("prompt")).max(0.0),
        completion_price_per_token_usd: to_number_or_zero(row.get("completion")).max(0.0),
        request_price_usd: to_number_or_zero(row.get("request")).max(0.0),
    })
}

/// `parsePricing`: an array becomes its tiers sorted by context size, a single
/// object becomes one tier, anything else has no tiers.
fn parse_pricing(raw: Option<&Value>) -> Vec<Tier> {
    match raw {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut tiers: Vec<Tier> = items.iter().filter_map(parse_tier).collect();
            tiers.sort_by_key(|tier| tier.min_context_tokens);
            tiers
        }
        Some(other) => parse_tier(other).into_iter().collect(),
    }
}

/// The last tier whose threshold the prompt reaches, falling back to the first.
fn select_tier(tiers: &[Tier], prompt_tokens: i64) -> Option<Tier> {
    let first = *tiers.first()?;
    let normalized = prompt_tokens.max(0);
    let mut selected = first;
    for tier in tiers {
        if normalized >= tier.min_context_tokens {
            selected = *tier;
        } else {
            break;
        }
    }
    Some(selected)
}

#[derive(Debug, Default)]
pub struct OpenRouterPricingCache {
    fetched_at_ms: i64,
    models: HashMap<String, Vec<Tier>>,
}

impl OpenRouterPricingCache {
    /// `now - fetchedAt < ttl`.
    pub fn is_fresh(&self, now_ms: i64, ttl_ms: i64) -> bool {
        now_ms - self.fetched_at_ms < ttl_ms
    }

    /// The TypeScript refreshes when the cache is stale or empty.
    pub fn needs_refresh(&self, now_ms: i64, ttl_ms: i64) -> bool {
        !self.is_fresh(now_ms, ttl_ms) || self.models.is_empty()
    }

    /// Indexes every model under its `id` and `canonical_slug`. Returns `false`
    /// and keeps the old cache when the response yields no priced model.
    pub fn ingest_models_response(&mut self, response: &Value, now_ms: i64) -> bool {
        let mut next: HashMap<String, Vec<Tier>> = HashMap::new();
        let models = response
            .get("data")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        for model in models {
            let tiers = parse_pricing(model.get("pricing"));
            if tiers.is_empty() {
                continue;
            }
            for key in ["id", "canonical_slug"] {
                if let Some(name) = model
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                {
                    next.insert(name.to_string(), tiers.clone());
                }
            }
        }
        if next.is_empty() {
            return false;
        }
        self.models = next;
        self.fetched_at_ms = now_ms;
        true
    }

    /// Price of `model` for a prompt of `prompt_tokens`; `None` when unknown.
    pub fn lookup(&self, model: &str, prompt_tokens: i64) -> Option<ModelPricing> {
        let tiers = self.models.get(model)?;
        let tier = select_tier(tiers, prompt_tokens)?;
        Some(ModelPricing {
            prompt_price_per_token_usd: tier.prompt_price_per_token_usd,
            completion_price_per_token_usd: tier.completion_price_per_token_usd,
            request_price_usd: tier.request_price_usd,
        })
    }
}

/// `https://openrouter.ai/api/v1/models`.
pub const MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
/// The fetch timeout when `OPENROUTER_PRICING_FETCH_TIMEOUT_MS` is unset.
pub const DEFAULT_FETCH_TIMEOUT_MS: u64 = 2_500;

/// A positive integer from the environment, as `Number.parseInt(...)` with `> 0`.
fn positive_env(name: &str) -> Option<i64> {
    std::env::var(name)
        .ok()
        .as_deref()
        .and_then(js_parse_int)
        .filter(|value| *value > 0)
}

/// The price cache and its fetch. Concurrent callers share one fetch: a caller
/// that waits for the gate while a fetch runs takes that fetch's result.
pub struct OpenRouterPricing {
    transport: Arc<dyn HttpTransport>,
    cache: StdMutex<OpenRouterPricingCache>,
    /// Serialises the fetches.
    refresh_gate: AsyncMutex<()>,
    /// Counts finished fetches. A caller that finds the count changed after it
    /// waited on the gate joins the fetch that finished meanwhile.
    finished_fetches: AtomicU64,
    ttl_ms: i64,
    timeout_ms: u64,
}

impl OpenRouterPricing {
    /// Reads `OPENROUTER_PRICING_CACHE_TTL_MS` and `OPENROUTER_PRICING_FETCH_TIMEOUT_MS`.
    pub fn new(transport: Arc<dyn HttpTransport>) -> Self {
        let ttl_ms = positive_env("OPENROUTER_PRICING_CACHE_TTL_MS").unwrap_or(DEFAULT_TTL_MS);
        let timeout_ms = positive_env("OPENROUTER_PRICING_FETCH_TIMEOUT_MS")
            .map_or(DEFAULT_FETCH_TIMEOUT_MS, |value| value as u64);
        Self::with_settings(transport, ttl_ms, timeout_ms)
    }

    pub fn with_settings(transport: Arc<dyn HttpTransport>, ttl_ms: i64, timeout_ms: u64) -> Self {
        Self {
            transport,
            cache: StdMutex::new(OpenRouterPricingCache::default()),
            refresh_gate: AsyncMutex::new(()),
            finished_fetches: AtomicU64::new(0),
            ttl_ms,
            timeout_ms,
        }
    }

    /// `getOpenRouterModelPricing`. Refreshes a stale or empty list first; a failed
    /// refresh keeps the list that was there.
    pub async fn model_pricing(
        &self,
        model: &str,
        prompt_tokens: i64,
        api_key: Option<&str>,
    ) -> Option<ModelPricing> {
        if self.needs_refresh() {
            self.refresh(api_key).await;
        }
        self.lock_cache().lookup(model, prompt_tokens)
    }

    fn lock_cache(&self) -> MutexGuard<'_, OpenRouterPricingCache> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn needs_refresh(&self) -> bool {
        self.lock_cache().needs_refresh(now_ms(), self.ttl_ms)
    }

    /// `refreshCache`.
    async fn refresh(&self, api_key: Option<&str>) {
        let seen = self.finished_fetches.load(Ordering::SeqCst);
        let _turn = self.refresh_gate.lock().await;
        if self.finished_fetches.load(Ordering::SeqCst) != seen {
            return;
        }
        if let Some(models) = self.fetch_models(api_key).await {
            self.lock_cache().ingest_models_response(&models, now_ms());
        }
        self.finished_fetches.fetch_add(1, Ordering::SeqCst);
    }

    /// The request of `refreshCache`. `None` for a transport error, a non-2xx
    /// status or a body that is not JSON; the TypeScript ignores all three.
    async fn fetch_models(&self, api_key: Option<&str>) -> Option<Value> {
        let mut request = HttpRequest::get(MODELS_URL).timeout_ms(self.timeout_ms);
        if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
            request = request.header("authorization", &format!("Bearer {key}"));
        }
        let response = fetch_with_timeout(self.transport.as_ref(), request)
            .await
            .ok()?;
        if !response.is_ok() {
            return None;
        }
        serde_json::from_str(&response.body).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::http::{BoxFuture, HttpError, HttpResponse};
    use http::{HeaderMap, StatusCode};
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;

    /// Answers every request with one fixed response and records the calls.
    struct StubModels {
        status: StatusCode,
        body: String,
        calls: AtomicUsize,
        authorization: StdMutex<Option<String>>,
    }

    impl StubModels {
        fn new(status: StatusCode, body: &Value) -> Arc<Self> {
            Arc::new(Self {
                status,
                body: body.to_string(),
                calls: AtomicUsize::new(0),
                authorization: StdMutex::new(None),
            })
        }
    }

    impl HttpTransport for StubModels {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.authorization.lock().expect("lock") = request
                .headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let response = HttpResponse::new(self.status, HeaderMap::new(), self.body.clone());
            Box::pin(async move {
                // A real request does not answer within the first poll.
                tokio::task::yield_now().await;
                Ok(response)
            })
        }
    }

    #[tokio::test]
    async fn a_fetch_fills_the_cache_once_and_sends_the_key() {
        let stub = StubModels::new(StatusCode::OK, &response());
        let pricing = OpenRouterPricing::with_settings(stub.clone(), DEFAULT_TTL_MS, 2_500);
        let small = pricing
            .model_pricing("openai/gpt-4o", 1_000, Some("sk-test"))
            .await
            .expect("priced");
        assert!((small.prompt_price_per_token_usd - 0.000002).abs() < 1e-12);
        assert!(pricing
            .model_pricing("openai/gpt-4o", 200_000, None)
            .await
            .is_some());
        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            stub.authorization.lock().expect("lock").as_deref(),
            Some("Bearer sk-test")
        );

        let blank = StubModels::new(StatusCode::OK, &response());
        let pricing = OpenRouterPricing::with_settings(blank.clone(), DEFAULT_TTL_MS, 2_500);
        assert!(pricing
            .model_pricing("openai/gpt-4o", 0, Some("   "))
            .await
            .is_some());
        assert_eq!(*blank.authorization.lock().expect("lock"), None);
    }

    #[tokio::test]
    async fn a_failed_fetch_leaves_the_cache_empty_and_is_retried() {
        let stub = StubModels::new(StatusCode::INTERNAL_SERVER_ERROR, &response());
        let pricing = OpenRouterPricing::with_settings(stub.clone(), DEFAULT_TTL_MS, 2_500);
        assert!(pricing
            .model_pricing("openai/gpt-4o", 0, None)
            .await
            .is_none());
        assert!(pricing
            .model_pricing("openai/gpt-4o", 0, None)
            .await
            .is_none());
        assert_eq!(stub.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn callers_that_wait_for_a_running_fetch_share_it() {
        let stub = StubModels::new(StatusCode::OK, &response());
        let pricing = OpenRouterPricing::with_settings(stub.clone(), DEFAULT_TTL_MS, 2_500);
        let (first, second) = futures_util::future::join(
            pricing.model_pricing("openai/gpt-4o", 0, None),
            pricing.model_pricing("openai/gpt-4o", 0, None),
        )
        .await;
        assert!(first.is_some() && second.is_some());
        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
    }

    fn response() -> Value {
        json!({
            "data": [
                {
                    "id": "openai/gpt-4o",
                    "canonical_slug": "openai/gpt-4o-2024",
                    "pricing": [
                        { "min_context": 128000, "prompt": "0.000005", "completion": "0.000015", "request": "0" },
                        { "minContext": 0, "prompt": "0.000002", "completion": "0.000008", "request": 0 }
                    ]
                },
                { "id": "no/pricing" },
                { "id": "bad/pricing", "pricing": 5 }
            ]
        })
    }

    #[test]
    fn selects_the_tier_by_prompt_size_after_sorting() {
        let mut cache = OpenRouterPricingCache::default();
        assert!(cache.ingest_models_response(&response(), 1_000));
        let small = cache.lookup("openai/gpt-4o", 1_000).expect("priced");
        assert!((small.prompt_price_per_token_usd - 0.000002).abs() < 1e-12);
        let large = cache.lookup("openai/gpt-4o", 200_000).expect("priced");
        assert!((large.prompt_price_per_token_usd - 0.000005).abs() < 1e-12);
    }

    #[test]
    fn indexes_the_canonical_slug_and_skips_unpriced_models() {
        let mut cache = OpenRouterPricingCache::default();
        cache.ingest_models_response(&response(), 1_000);
        assert!(cache.lookup("openai/gpt-4o-2024", 0).is_some());
        assert!(cache.lookup("no/pricing", 0).is_none());
        assert!(cache.lookup("bad/pricing", 0).is_none());
    }

    #[test]
    fn an_empty_response_keeps_the_previous_cache() {
        let mut cache = OpenRouterPricingCache::default();
        cache.ingest_models_response(&response(), 1_000);
        assert!(!cache.ingest_models_response(&json!({ "data": [] }), 2_000));
        assert!(cache.lookup("openai/gpt-4o", 0).is_some());
        assert!(cache.is_fresh(1_500, DEFAULT_TTL_MS));
        assert!(!cache.is_fresh(1_000 + DEFAULT_TTL_MS, DEFAULT_TTL_MS));
    }

    #[test]
    fn an_unfilled_cache_always_needs_a_refresh() {
        let cache = OpenRouterPricingCache::default();
        assert!(cache.needs_refresh(0, DEFAULT_TTL_MS));
    }
}
