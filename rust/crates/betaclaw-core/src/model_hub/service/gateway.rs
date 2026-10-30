//! Port of `src/server/model-hub/gateway.ts` (`dispatchGatewayRequest`) plus the
//! observer seam that replaces its `src/server/stats` imports.
//!
//! ## Why an observer
//!
//! `gateway.ts:12-25` imports six modules from `src/server/stats` (817 LOC):
//! `tokenUsageRepository`, `promptDispatchRepository`,
//! `promptDispatchDiagnostics`, `openRouterPricing`, `xaiPricing` and
//! `promptAudit`. Porting them here would make the Model Hub slice depend on
//! slice S12, and S12 depends on S4 through S9 — an import cycle that no
//! `mod` graph can express. The seam is therefore a trait the gateway injects:
//!
//! ```text
//! gateway.ts                       dispatch_gateway_request
//!   getTokenUsageRepository()  →     deps.observer.on_usage(...)
//!   promptDispatchRepository   →     deps.observer.on_prompt_dispatch(...)
//! ```
//!
//! ## Fire-and-forget semantics, preserved exactly
//!
//! In TypeScript both blocks are wrapped in `try { … } catch { }` and the
//! comments say so explicitly: *"Silently ignore — stats must never break AI
//! dispatch"* (`gateway.ts:103`, `gateway.ts:188`). The port keeps three
//! properties:
//!
//! 1. `on_usage` is only called when `result.ok && result.usage`
//!    (`gateway.ts:93`) — a failed dispatch records no token usage.
//! 2. `on_prompt_dispatch` is called for every result, success or failure
//!    (`gateway.ts:108`), which is how the golden test
//!    `gateway-prompt-logging.test.ts:148` gets an `error` row.
//! 3. A returning `Err` from either method is discarded, never propagated, and
//!    never turns into a dispatch failure.
//!
//! ## What the observer receives
//!
//! The redaction, token estimation, injection detection and pricing that
//! `promptAudit.ts`, `promptDispatchDiagnostics.ts`, `openRouterPricing.ts` and
//! `xaiPricing.ts` perform all live in S12, so the port passes the raw
//! ingredients (the request, the audit context, the decrypted secret) and lets
//! the implementation decide. That is what keeps `betaclaw-core` free of the
//! stats dependency while leaving the observable behaviour in one place.

use std::time::Instant;

use crate::model_hub::crypto::decrypt_secret;
use crate::model_hub::openai_compatible::{dispatch_openai_compatible_chat, DispatchOptions};
use crate::model_hub::provider_catalog::find_provider;
use crate::model_hub::providers::{get_provider_adapter, ProviderCall};
use crate::model_hub::types::{
    GatewayAuditKind, GatewayRequest, GatewayResponse, ProviderAccountRecord, ProviderAuthMethod,
    ProviderCatalogEntry, ProviderEndpointType, ProviderExecutionContext,
};

use super::types::DispatchWithFallbackOptions;
use super::ServiceDependencies;

/// Failure of a statistics side effect. Never reaches the dispatch result.
#[derive(Debug, thiserror::Error)]
#[error("dispatch observer failed: {0}")]
pub struct ObserverError(String);

impl ObserverError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// The statistics eye of the gateway: `getTokenUsageRepository()` plus the
/// prompt-dispatch repository of `gateway.ts:12-25`.
pub trait DispatchObserver: Send + Sync {
    /// `getTokenUsageRepository().recordUsage(providerId, modelName, prompt,
    /// completion, total)` from `gateway.ts:95-101`.
    fn on_usage(&self, usage: &TokenUsageRecord) -> Result<(), ObserverError>;

    /// The whole prompt-dispatch block from `gateway.ts:108-188`.
    fn on_prompt_dispatch(&self, event: &PromptDispatchEvent<'_>) -> Result<(), ObserverError>;
}

/// `recordUsage`'s five arguments (`gateway.ts:95`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenUsageRecord {
    pub provider_id: String,
    pub model_name: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

/// Which of the two token counts in `gateway.ts:112-116` was used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenCountSource {
    /// `typeof result.usage?.prompt_tokens === 'number'`.
    Exact,
    /// `estimatePromptTokens(redactedRequest)`.
    Estimated,
}

impl TokenCountSource {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenCountSource::Exact => "exact",
            TokenCountSource::Estimated => "estimated",
        }
    }
}

/// `status: result.ok ? 'success' : 'error'` (`gateway.ts:166`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchStatus {
    Success,
    Error,
}

impl DispatchStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DispatchStatus::Success => "success",
            DispatchStatus::Error => "error",
        }
    }
}

/// Everything the prompt-dispatch block of `gateway.ts:108-188` needs.
///
/// The lifetimes exist because the TypeScript block reads the request and the
/// secret in place; the observer is free to copy what it persists.
#[derive(Debug)]
pub struct PromptDispatchEvent<'a> {
    pub account: &'a ProviderAccountRecord,
    /// `findProvider(account.providerId)` — the resolved catalog entry.
    pub provider: &'a ProviderCatalogEntry,
    /// The decrypted account secret. `getOpenRouterModelPricing` and
    /// `getXaiModelPricing` need it to look up model prices (`gateway.ts:123`,
    /// `gateway.ts:133`).
    pub secret: &'a str,
    pub request: &'a GatewayRequest,
    pub result: &'a GatewayResponse,
    pub prompt_tokens: i64,
    pub prompt_tokens_source: TokenCountSource,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub status: DispatchStatus,
    /// `request.auditContext?.kind || 'api_gateway'` (`gateway.ts:161`).
    pub dispatch_kind: GatewayAuditKind,
    /// `latencyMs` — wall-clock span around the provider call (`gateway.ts:90`).
    pub latency_ms: u128,
}

/// The default observer: both hooks are no-ops.
///
/// This is what makes `betaclaw-core` usable without the stats slice, and it is
/// also the safe answer for every caller that does not have a repository
/// handy — the TypeScript code has the same "no singleton yet" state before the
/// first request initialises them.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopObserver;

impl DispatchObserver for NoopObserver {
    fn on_usage(&self, _usage: &TokenUsageRecord) -> Result<(), ObserverError> {
        Ok(())
    }

    fn on_prompt_dispatch(&self, _event: &PromptDispatchEvent<'_>) -> Result<(), ObserverError> {
        Ok(())
    }
}

/// The `else` arm of `gateway.ts:80-88`: a provider without an adapter and
/// without an OpenAI-compatible `apiBaseUrl` is reported by its display name.
///
/// S4 closed the last adapter gap, so no catalog entry reaches this arm any
/// more; it stays as the guard for a future entry whose adapter is missing.
/// That is exactly the case in which `getProviderAdapter` (`registry.ts:36-38`)
/// returns `undefined` and the arm fires in TypeScript.
fn adapter_missing_response(
    provider: &ProviderCatalogEntry,
    request: &GatewayRequest,
) -> GatewayResponse {
    GatewayResponse::failure(
        request.model.clone(),
        provider.id.clone(),
        format!("No gateway adapter for provider: {}", provider.name),
    )
}

/// `dispatchGatewayRequest(account, encryptionKey, request, options)` from
/// `gateway.ts:35-191`.
///
/// The two collaborators TypeScript reaches for implicitly — the global `fetch`
/// behind every adapter and `process.env` — arrive through [`ServiceDependencies`].
pub async fn dispatch_gateway_request(
    account: &ProviderAccountRecord,
    encryption_key: &str,
    request: &GatewayRequest,
    options: Option<&DispatchWithFallbackOptions>,
    dependencies: &ServiceDependencies<'_>,
) -> Result<GatewayResponse, super::ServiceError> {
    let provider = find_provider(&account.provider_id);
    let Some(provider) = provider else {
        return Ok(GatewayResponse::failure(
            request.model.clone(),
            account.provider_id.clone(),
            format!("Unknown provider: {}", account.provider_id),
        ));
    };

    // `decryptSecret` throws on a malformed payload, and TypeScript lets that
    // escape `dispatchGatewayRequest`; the port surfaces it the same way.
    let secret = decrypt_secret(&account.encrypted_secret_payload(), encryption_key)?;
    if account.auth_method != ProviderAuthMethod::None && secret.trim().is_empty() {
        return Ok(GatewayResponse::failure(
            request.model.clone(),
            provider.id.clone(),
            "Account secret is missing or empty.",
        ));
    }

    let call = ProviderCall {
        transport: dependencies.transport,
        attachments: dependencies.attachments,
        env: dependencies.env,
    };
    let dispatch_options = DispatchOptions {
        extra_headers: Vec::new(),
        abort: options.and_then(|options| options.abort.clone()),
        on_stream_delta: options.and_then(|options| options.on_stream_delta.clone()),
    };

    let dispatch_start = Instant::now();

    let result = match get_provider_adapter(&provider.id) {
        Some(adapter) => {
            let context = ProviderExecutionContext {
                provider: provider.clone(),
                account: account.clone(),
                secret: secret.clone(),
            };
            adapter
                .dispatch_gateway(&context, &call, request, &dispatch_options)
                .await?
        }
        // `provider.apiBaseUrl` — the fallback that keeps every provider without
        // an own adapter (including `ollama` and the native ones) reachable.
        // The shared OpenAI-compatible layer is only a fallback for providers
        // whose wire format actually IS OpenAI's. A provider catalogued with a
        // native endpoint type needs its own adapter: sending its request down
        // the OpenAI-compatible path produces a body the provider rejects, and
        // the failure surfaces as a confusing transport error instead of "not
        // implemented yet". Those are reported the same way as a missing
        // `api_base_url`.
        //
        // S4 closed the last adapter gap, so no catalog entry reaches this arm
        // any more (`providers::registry_and_catalog_agree` proves that all
        // fifteen ids resolve); it stays as the guard for a future entry whose
        // adapter is missing.
        None => {
            let is_openai_compatible = matches!(
                provider.endpoint_type,
                ProviderEndpointType::OpenAiCompatible
                    | ProviderEndpointType::OpenAiCompatibleUnderscore
                    | ProviderEndpointType::OpenAiNative
                    | ProviderEndpointType::MistralNative
            );
            match (is_openai_compatible, provider.api_base_url.as_deref()) {
                (true, Some(base_url)) => {
                    dispatch_openai_compatible_chat(
                        dependencies.transport,
                        dependencies.attachments,
                        base_url,
                        &secret,
                        &provider.id,
                        request,
                        &dispatch_options,
                    )
                    .await?
                }
                _ => adapter_missing_response(provider, request),
            }
        }
    };

    // `const latencyMs = Date.now() - dispatchStart`.
    let latency_ms = dispatch_start.elapsed().as_millis();

    record_token_usage(dependencies.observer, account, &result);
    record_prompt_dispatch(
        dependencies.observer,
        account,
        provider,
        &secret,
        request,
        &result,
        latency_ms,
    );

    Ok(result)
}

/// `if (result.ok && result.usage)` — `gateway.ts:93`.
fn record_token_usage(
    observer: &dyn DispatchObserver,
    account: &ProviderAccountRecord,
    result: &GatewayResponse,
) {
    if !result.ok {
        return;
    }
    let Some(usage) = result.usage else {
        return;
    };
    // `catch { }` — statistics must never break AI dispatch.
    let _ = observer.on_usage(&TokenUsageRecord {
        provider_id: account.provider_id.clone(),
        model_name: result.model.clone(),
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
    });
}

/// The prompt-dispatch block, `gateway.ts:108-188`.
///
/// The `try` starts before `markPromptDispatchAttempt()` and ends after
/// `markPromptDispatchInsert(entry.createdAt)`, so the diagnostics markers of
/// `promptDispatchDiagnostics.ts` belong to the observer as well; the essential
/// part for parity is that nothing here can fail the dispatch.
fn record_prompt_dispatch(
    observer: &dyn DispatchObserver,
    account: &ProviderAccountRecord,
    provider: &ProviderCatalogEntry,
    secret: &str,
    request: &GatewayRequest,
    result: &GatewayResponse,
    latency_ms: u128,
) {
    // `typeof result.usage?.prompt_tokens === 'number' ? … : estimatePromptTokens(…)`.
    let (prompt_tokens, prompt_tokens_source) = match result.usage {
        Some(usage) => (usage.prompt_tokens, TokenCountSource::Exact),
        None => (0, TokenCountSource::Estimated),
    };
    let completion_tokens = result.usage.map_or(0, |usage| usage.completion_tokens);
    let total_tokens = result
        .usage
        .map_or(prompt_tokens + completion_tokens, |usage| {
            usage.total_tokens
        });

    let _ = observer.on_prompt_dispatch(&PromptDispatchEvent {
        account,
        provider,
        secret,
        request,
        result,
        prompt_tokens,
        prompt_tokens_source,
        completion_tokens,
        total_tokens,
        status: if result.ok {
            DispatchStatus::Success
        } else {
            DispatchStatus::Error
        },
        dispatch_kind: request
            .audit_context
            .as_ref()
            .map(|context| context.kind)
            .unwrap_or(GatewayAuditKind::ApiGateway),
        latency_ms,
    });
}

#[cfg(test)]
mod tests {
    use crate::model_hub::http::HttpTransport;
    use std::sync::Mutex;

    use http::{HeaderMap, StatusCode};

    use super::*;
    use crate::model_hub::http::{BoxFuture, HttpError, HttpResponse};
    use crate::model_hub::service::test_doubles::{
        no_attachments, RecordingObserver, StubTransport,
    };
    use crate::model_hub::tests::StubAttachmentStore;
    use crate::model_hub::types::{GatewayMessage, GatewayUsage};

    const KEY: &str = "test-only-encryption-key-32bytes";

    /// A transport that answers every chat request with one canned body.
    fn ok_transport() -> StubTransport {
        StubTransport::json(
            StatusCode::OK,
            &serde_json::json!({
                "choices": [{ "message": { "content": "hi" } }],
                "usage": { "prompt_tokens": 11, "completion_tokens": 2, "total_tokens": 13 },
            }),
        )
    }

    fn request() -> GatewayRequest {
        GatewayRequest::new("gpt-4.1", vec![GatewayMessage::user("hello")])
    }

    fn account(provider_id: &str) -> ProviderAccountRecord {
        let encrypted =
            crate::model_hub::crypto::encrypt_secret_with_iv("sk-test", KEY, "default", &[9u8; 12])
                .expect("encrypt");
        ProviderAccountRecord {
            id: format!("acc-{provider_id}"),
            provider_id: provider_id.to_string(),
            label: provider_id.to_string(),
            auth_method: ProviderAuthMethod::ApiKey,
            secret_masked: "****".to_string(),
            has_refresh_token: false,
            created_at: String::new(),
            updated_at: String::new(),
            last_check_at: None,
            last_check_ok: None,
            last_check_message: None,
            encrypted_secret: crate::model_hub::types::EncryptedSecretPayloadJson::from_payload(
                &encrypted,
            ),
            encrypted_refresh_token: None,
        }
    }

    fn dependencies<'a>(transport: &'a StubTransport) -> ServiceDependencies<'a> {
        ServiceDependencies::for_test(transport, no_attachments())
    }

    /// `findProvider` miss: the response names the unknown provider and echoes
    /// the requested model.
    #[tokio::test]
    async fn an_unknown_provider_is_reported_with_the_account_id() {
        let transport = StubTransport::default();
        let deps = dependencies(&transport);
        let account = account("no-such-provider");

        let response = dispatch_gateway_request(&account, KEY, &request(), None, &deps)
            .await
            .expect("no transport failure");

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("Unknown provider: no-such-provider")
        );
        assert_eq!(response.provider, "no-such-provider");
        assert_eq!(response.model, "gpt-4.1");
        assert_eq!(transport.request_count(), 0);
    }

    /// `account.authMethod !== 'none' && !secret?.trim()`.
    #[tokio::test]
    async fn an_empty_secret_is_reported_before_any_request() {
        let transport = StubTransport::default();
        let deps = dependencies(&transport);
        let mut account = account("openai");
        account.auth_method = ProviderAuthMethod::ApiKey;
        account.encrypted_secret =
            crate::model_hub::crypto::encrypt_secret_with_iv("   ", KEY, "default", &[9u8; 12])
                .map(|payload| {
                    crate::model_hub::types::EncryptedSecretPayloadJson::from_payload(&payload)
                })
                .expect("encrypt");

        let response = dispatch_gateway_request(&account, KEY, &request(), None, &deps)
            .await
            .expect("no transport failure");

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("Account secret is missing or empty.")
        );
        assert_eq!(transport.request_count(), 0);
    }

    /// `authMethod === 'none'` bypasses the secret check, which is what keeps
    /// `ollama` and `lmstudio` usable without a key.
    #[tokio::test]
    async fn a_none_auth_method_keeps_an_empty_secret() {
        let transport = ok_transport();
        let deps = dependencies(&transport);
        let mut account = account("openai");
        account.auth_method = ProviderAuthMethod::None;
        account.encrypted_secret =
            crate::model_hub::crypto::encrypt_secret_with_iv("", KEY, "default", &[9u8; 12])
                .map(|payload| {
                    crate::model_hub::types::EncryptedSecretPayloadJson::from_payload(&payload)
                })
                .expect("encrypt");

        let response = dispatch_gateway_request(&account, KEY, &request(), None, &deps)
            .await
            .expect("no transport failure");

        assert!(response.ok, "{response:?}");
    }

    /// The `else` arm of `gateway.ts:80-88` names the provider's display name.
    ///
    /// S4 closed the last adapter gap, so `dispatch_gateway_request` cannot reach
    /// the arm any more — every catalog id resolves, which
    /// `providers::registry_and_catalog_agree` proves. The arm stays as the guard
    /// for a future catalog entry whose adapter is missing, so its response shape
    /// is pinned with the literal shape of such an entry.
    #[test]
    fn a_provider_without_adapter_and_base_url_is_reported() {
        let provider = ProviderCatalogEntry {
            id: "unported".to_string(),
            name: "Unported".to_string(),
            icon: "unported".to_string(),
            auth_methods: vec![ProviderAuthMethod::ApiKey],
            endpoint_type: ProviderEndpointType::CohereNative,
            capabilities: vec![],
            default_models: vec![],
            oauth_configured: None,
            api_base_url: None,
            docs_url: None,
        };

        let response = adapter_missing_response(&provider, &request());

        assert!(!response.ok);
        assert_eq!(
            response.error.as_deref(),
            Some("No gateway adapter for provider: Unported")
        );
        assert_eq!(response.provider, "unported");
        assert_eq!(response.model, "gpt-4.1");
    }

    /// The adapter path is taken for a ported provider, and the shared
    /// OpenAI-compatible URL and body are what actually leave the process.
    #[tokio::test]
    async fn an_adapter_provider_dispatches_through_the_shared_layer() {
        let transport = ok_transport();
        let deps = dependencies(&transport);
        let account = account("openai");

        let response = dispatch_gateway_request(&account, KEY, &request(), None, &deps)
            .await
            .expect("no transport failure");

        assert!(response.ok);
        assert_eq!(response.text, "hi");
        assert_eq!(
            response.usage,
            Some(GatewayUsage {
                prompt_tokens: 11,
                completion_tokens: 2,
                total_tokens: 13
            })
        );
        assert_eq!(
            transport.recorded()[0].url,
            "https://api.openai.com/v1/chat/completions"
        );
    }

    /// A successful dispatch reports usage to the observer once.
    #[tokio::test]
    async fn a_successful_dispatch_reports_usage_once() {
        let transport = ok_transport();
        let observer = RecordingObserver::succeeding();
        let deps =
            ServiceDependencies::for_test(&transport, no_attachments()).with_observer(&observer);

        let response = dispatch_gateway_request(&account("openai"), KEY, &request(), None, &deps)
            .await
            .expect("no transport failure");

        assert!(response.ok);
        assert_eq!(observer.usages().len(), 1);
        assert_eq!(observer.usages()[0].prompt_tokens, 11);
        assert_eq!(observer.usages()[0].model_name, "gpt-4.1");
        assert_eq!(observer.prompt_dispatches().len(), 1);
        assert_eq!(
            observer.prompt_dispatches()[0].status,
            DispatchStatus::Success
        );
        assert_eq!(
            observer.prompt_dispatches()[0].prompt_tokens_source,
            TokenCountSource::Exact
        );
    }

    /// `gateway.ts:93`: a failed dispatch records no token usage, but it still
    /// records a prompt dispatch — that is how the golden test
    /// `gateway-prompt-logging.test.ts:148` gets its `error` row.
    #[tokio::test]
    async fn a_failed_dispatch_reports_a_prompt_dispatch_without_usage() {
        let transport = StubTransport::json(
            StatusCode::TOO_MANY_REQUESTS,
            &serde_json::json!({ "error": "slow down" }),
        );
        let observer = RecordingObserver::succeeding();
        let deps =
            ServiceDependencies::for_test(&transport, no_attachments()).with_observer(&observer);

        let response = dispatch_gateway_request(&account("openai"), KEY, &request(), None, &deps)
            .await
            .expect("no transport failure");

        assert!(!response.ok);
        assert_eq!(observer.usages().len(), 0);
        assert_eq!(observer.prompt_dispatches().len(), 1);
        assert_eq!(
            observer.prompt_dispatches()[0].status,
            DispatchStatus::Error
        );
        assert_eq!(
            observer.prompt_dispatches()[0].dispatch_kind,
            GatewayAuditKind::ApiGateway
        );
    }

    /// A transport-level failure escapes as an error in TypeScript too, where
    /// the rejected promise leaves `dispatchGatewayRequest`.
    #[tokio::test]
    async fn a_transport_failure_escapes_as_an_error() {
        struct Dead;
        impl HttpTransport for Dead {
            fn send<'a>(
                &'a self,
                _request: crate::model_hub::http::HttpRequest,
            ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
                Box::pin(async { Err(HttpError::Transport("connection refused".to_string())) })
            }
        }

        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        let dead = Dead;
        let attachments = StubAttachmentStore::default();
        let discarded = StubTransport::default();
        let deps = ServiceDependencies::for_test(&discarded, &attachments).with_transport(&dead);

        let error = dispatch_gateway_request(&account("openai"), KEY, &request(), None, &deps)
            .await
            .expect_err("transport failure");

        assert!(
            matches!(error, crate::model_hub::service::ServiceError::Transport(_)),
            "{error:?}"
        );
    }

    /// An observer that throws must not turn a working dispatch into a failure
    /// (`gateway.ts:103` and `gateway.ts:188`).
    #[tokio::test]
    async fn a_failing_observer_never_breaks_the_dispatch() {
        let transport = ok_transport();
        let observer = RecordingObserver::failing();
        let deps =
            ServiceDependencies::for_test(&transport, no_attachments()).with_observer(&observer);

        let response = dispatch_gateway_request(&account("openai"), KEY, &request(), None, &deps)
            .await
            .expect("stats must never break dispatch");

        assert!(response.ok);
        assert_eq!(observer.usages().len(), 1);
        assert_eq!(observer.prompt_dispatches().len(), 1);
    }

    /// `no active models` style options plumbing: the abort signal and the
    /// stream callback travel with the request.
    #[tokio::test]
    async fn options_travel_with_the_request() {
        let transport = StubTransport::event_stream(concat!(
            "data: {\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: [DONE]\n\n"
        ));
        let mut request = request();
        request.stream = Some(true);
        let deltas = std::sync::Arc::new(Mutex::new(String::new()));
        let sink: crate::model_hub::openai_compatible::StreamDeltaCallback = {
            let deltas = std::sync::Arc::clone(&deltas);
            std::sync::Arc::new(move |delta: &str| deltas.lock().expect("lock").push_str(delta))
        };
        let signal = crate::model_hub::http::AbortSignal::new();
        let options = DispatchWithFallbackOptions {
            abort: Some(signal.clone()),
            model_override: None,
            on_stream_delta: Some(sink),
        };
        let deps = ServiceDependencies::for_test(&transport, no_attachments());

        let response =
            dispatch_gateway_request(&account("openai"), KEY, &request, Some(&options), &deps)
                .await
                .expect("no transport failure");

        assert_eq!(response.text, "Hello");
        assert_eq!(&*deltas.lock().expect("lock"), "Hello");
        assert!(!signal.is_aborted(), "a completed dispatch does not abort");
    }
}
