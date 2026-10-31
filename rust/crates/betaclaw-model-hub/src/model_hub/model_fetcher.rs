//! Port of `src/server/model-hub/modelFetcher.ts` (1-79).
//!
//! `fetchModelsForAccount` (`modelFetcher.ts:43-77`) is the account-level model
//! discovery the `GET /api/model-hub/accounts/[accountId]/models` route calls. It
//! resolves the provider, decrypts the secret, prefers a provider adapter, falls
//! back to the shared OpenAI-compatible models endpoint, and finally to the
//! catalog's static `defaultModels`. OpenRouter additionally has a dedicated
//! embeddings endpoint (`modelFetcher.ts:20-37`).
//!
//! Every `try { … } catch { … }` branch of the original becomes an explicit
//! `match` on the transport result, so a failure still yields the same seeded
//! models.

use http::header;
use serde_json::Value;

use crate::model_hub::crypto::decrypt_secret;
use crate::model_hub::http::{fetch_with_timeout, HttpRequest};
use crate::model_hub::openai_compatible::fetch_openai_compatible_models;
use crate::model_hub::provider_catalog::find_provider;
use crate::model_hub::providers::{get_provider_adapter, ProviderCall};
use crate::model_hub::types::{
    FetchedModel, ProviderAccountRecord, ProviderAuthMethod, ProviderExecutionContext,
};

use crate::model_hub::service::ServiceError;

/// `options.purpose` from `modelFetcher.ts:46`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FetchPurpose {
    /// `'general'` — the default.
    #[default]
    General,
    /// `'embedding'`.
    Embedding,
}

/// `https://openrouter.ai/api/v1/embeddings/models` from `modelFetcher.ts:21`.
pub const OPENROUTER_EMBEDDING_MODELS_URL: &str = "https://openrouter.ai/api/v1/embeddings/models";

/// `mapDefaultModels` from `modelFetcher.ts:12-18`.
fn map_default_models(provider_id: &str, default_models: &[String]) -> Vec<FetchedModel> {
    default_models
        .iter()
        .map(|id| FetchedModel {
            id: id.clone(),
            name: id.clone(),
            provider: provider_id.to_string(),
            owned_by: None,
            context_window: None,
            created: None,
            billing: None,
        })
        .collect()
}

/// `fetchOpenRouterEmbeddingModels` from `modelFetcher.ts:20-37`.
///
/// A non-2xx response yields an empty list; a transport failure is swallowed the
/// same way (the caller falls back to the seeded models).
async fn fetch_open_router_embedding_models(
    call: &ProviderCall<'_>,
    secret: &str,
) -> Vec<FetchedModel> {
    let request = HttpRequest::get(OPENROUTER_EMBEDDING_MODELS_URL)
        .header(header::AUTHORIZATION.as_str(), &format!("Bearer {secret}"));
    let Ok(response) = fetch_with_timeout(call.transport, request).await else {
        return Vec::new();
    };
    if !response.is_ok() {
        return Vec::new();
    }
    let Ok(json) = serde_json::from_str::<Value>(&response.body) else {
        return Vec::new();
    };

    json.get("data")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .map(|model| {
                    let id = model
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    // `model.name || model.id`.
                    let name = model
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| id.clone());
                    FetchedModel {
                        id,
                        name,
                        provider: "openrouter".to_string(),
                        owned_by: None,
                        context_window: model.get("context_length").and_then(Value::as_f64),
                        created: None,
                        billing: None,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The body of `modelFetcher.ts:57-76`: the shared `try`/`catch` where every
/// failure ends in the catalog's seeded models.
async fn fetch_with_fallback(
    call: &ProviderCall<'_>,
    context: &ProviderExecutionContext,
    purpose: FetchPurpose,
) -> Vec<FetchedModel> {
    if purpose == FetchPurpose::Embedding && context.provider.id == "openrouter" {
        let embedding_models = fetch_open_router_embedding_models(call, &context.secret).await;
        if !embedding_models.is_empty() {
            return embedding_models;
        }
    }

    if let Some(adapter) = get_provider_adapter(&context.provider.id) {
        return match adapter.fetch_models(context, call).await {
            Ok(models) => models,
            Err(_) => map_default_models(&context.provider.id, &context.provider.default_models),
        };
    }

    if let Some(base_url) = context.provider.api_base_url.as_deref() {
        return match fetch_openai_compatible_models(
            call.transport,
            base_url,
            &context.secret,
            &context.provider.id,
        )
        .await
        {
            Ok(models) => models,
            Err(_) => map_default_models(&context.provider.id, &context.provider.default_models),
        };
    }

    map_default_models(&context.provider.id, &context.provider.default_models)
}

/// `fetchModelsForAccount(account, encryptionKey, options)` from
/// `modelFetcher.ts:43-77`.
///
/// `decryptSecret` throws on a malformed payload in TypeScript, and that throw
/// escapes the function (it sits before the `try`); the port surfaces it as
/// [`ServiceError::Crypto`]. A missing provider or a missing secret yields an
/// empty list, and every transport failure falls back to `defaultModels`.
pub async fn fetch_models_for_account(
    call: &ProviderCall<'_>,
    account: &ProviderAccountRecord,
    encryption_key: &str,
    purpose: FetchPurpose,
) -> Result<Vec<FetchedModel>, ServiceError> {
    let Some(provider) = find_provider(&account.provider_id) else {
        return Ok(Vec::new());
    };

    let secret = decrypt_secret(&account.encrypted_secret_payload(), encryption_key)?;
    if account.auth_method != ProviderAuthMethod::None && secret.trim().is_empty() {
        return Ok(Vec::new());
    }

    let context = ProviderExecutionContext {
        provider: provider.clone(),
        account: account.clone(),
        secret,
    };

    Ok(fetch_with_fallback(call, &context, purpose).await)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use http::StatusCode;
    use serde_json::json;

    use super::*;
    use crate::model_hub::crypto::encrypt_secret_with_iv;
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::{
        BoxFuture, HttpError, HttpRequest, HttpResponse, HttpTransport, UnreachableTransport,
    };
    use crate::model_hub::openai_compatible::NOOP_ATTACHMENT_STORE;
    use crate::model_hub::types::EncryptedSecretPayloadJson;

    const KEY: &str = "test-only-encryption-key-32bytes";

    struct StubTransport {
        response: HttpResponse,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        fn new(response: HttpResponse) -> Self {
            Self {
                response,
                seen: Mutex::new(Vec::new()),
            }
        }

        fn seen(&self) -> Vec<HttpRequest> {
            self.seen.lock().expect("lock").clone()
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen.lock().expect("lock").push(request);
            let response = self.response.clone();
            Box::pin(async move { Ok(response) })
        }
    }

    fn call<'a>(transport: &'a dyn HttpTransport, env: &'a EnvOverrides) -> ProviderCall<'a> {
        ProviderCall {
            transport,
            attachments: &NOOP_ATTACHMENT_STORE,
            env,
        }
    }

    fn account(
        provider_id: &str,
        auth_method: ProviderAuthMethod,
        secret: &str,
    ) -> ProviderAccountRecord {
        let iv = [7u8; 12];
        let payload = encrypt_secret_with_iv(secret, KEY, "default", &iv).expect("encrypt");
        ProviderAccountRecord {
            id: "acc".to_string(),
            provider_id: provider_id.to_string(),
            label: "acc".to_string(),
            auth_method,
            secret_masked: "****".to_string(),
            has_refresh_token: false,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            last_check_at: None,
            last_check_ok: None,
            last_check_message: None,
            encrypted_secret: EncryptedSecretPayloadJson::from_payload(&payload),
            encrypted_refresh_token: None,
        }
    }

    /// `modelFetcher.ts:48-49`: an unknown provider yields no models.
    #[tokio::test]
    async fn an_unknown_provider_yields_no_models() {
        let env = EnvOverrides::new();
        let models = fetch_models_for_account(
            &call(&UnreachableTransport, &env),
            &account("does-not-exist", ProviderAuthMethod::ApiKey, "sk"),
            KEY,
            FetchPurpose::General,
        )
        .await
        .expect("no crypto error");
        assert!(models.is_empty());
    }

    /// `modelFetcher.ts:51-52`: a missing secret yields no models and no request.
    #[tokio::test]
    async fn a_missing_secret_yields_no_models() {
        let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({})));
        let env = EnvOverrides::new();
        let models = fetch_models_for_account(
            &call(&transport, &env),
            &account("mistral", ProviderAuthMethod::ApiKey, "   "),
            KEY,
            FetchPurpose::General,
        )
        .await
        .expect("no crypto error");
        assert!(models.is_empty());
        assert!(transport.seen().is_empty());
    }

    /// `modelFetcher.ts:65-67`: a provider adapter wins and its models are mapped.
    #[tokio::test]
    async fn the_provider_adapter_supplies_the_models() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "data": [{ "id": "mistral-large-latest" }] }),
        ));
        let env = EnvOverrides::new();
        let models = fetch_models_for_account(
            &call(&transport, &env),
            &account("mistral", ProviderAuthMethod::ApiKey, "sk-mistral"),
            KEY,
            FetchPurpose::General,
        )
        .await
        .expect("no crypto error");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "mistral-large-latest");
        assert_eq!(models[0].name, "mistral-large-latest");
        assert_eq!(models[0].provider, "mistral");
        assert_eq!(transport.seen()[0].url, "https://api.mistral.ai/v1/models");
    }

    /// `modelFetcher.ts:58-63`: the OpenRouter embeddings endpoint is used for
    /// `purpose === 'embedding'`, and its `name`/`context_length` fields survive.
    #[tokio::test]
    async fn openrouter_embedding_purpose_uses_the_embeddings_endpoint() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "data": [{ "id": "openai/text-embedding-3-small", "name": "Small", "context_length": 8191 }] }),
        ));
        let env = EnvOverrides::new();
        let models = fetch_models_for_account(
            &call(&transport, &env),
            &account("openrouter", ProviderAuthMethod::ApiKey, "sk-or"),
            KEY,
            FetchPurpose::Embedding,
        )
        .await
        .expect("no crypto error");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "openai/text-embedding-3-small");
        assert_eq!(models[0].name, "Small");
        assert_eq!(models[0].provider, "openrouter");
        assert_eq!(models[0].context_window, Some(8191.0));
        assert_eq!(transport.seen()[0].url, OPENROUTER_EMBEDDING_MODELS_URL);
        assert_eq!(
            transport.seen()[0]
                .headers
                .get("authorization")
                .expect("auth"),
            "Bearer sk-or"
        );
    }

    /// `modelFetcher.ts:74-76`: any failure inside the `try` falls back to the
    /// catalog's `defaultModels`.
    #[tokio::test]
    async fn a_transport_failure_falls_back_to_default_models() {
        let env = EnvOverrides::new();
        let models = fetch_models_for_account(
            &call(&UnreachableTransport, &env),
            &account("mistral", ProviderAuthMethod::ApiKey, "sk-mistral"),
            KEY,
            FetchPurpose::General,
        )
        .await
        .expect("no crypto error");

        let provider = find_provider("mistral").expect("catalog");
        let expected = map_default_models("mistral", &provider.default_models);
        assert!(!expected.is_empty(), "mistral seeds models");
        assert_eq!(models, expected);
    }
}
