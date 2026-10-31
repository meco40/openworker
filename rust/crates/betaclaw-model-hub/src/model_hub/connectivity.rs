//! Port of `src/server/model-hub/connectivity.ts` (1-52).
//!
//! `testProviderAccountConnectivity` (`connectivity.ts:12-52`) is the account-level
//! probe the `POST /api/model-hub/accounts/[accountId]/test` and
//! `POST /api/model-hub/accounts/test-all` routes call: it resolves the provider
//! from the catalog, decrypts the secret, and hands the work to the provider
//! adapter — or, for an `openai-compatible` provider without an adapter, to the
//! shared models endpoint (`connectivity.ts:34-46`).
//!
//! The transport and the environment are the [`ProviderCall`] collaborators, so
//! the function is exercised against a stub without a socket.

use crate::model_hub::crypto::decrypt_secret;
use crate::model_hub::openai_compatible::test_openai_compatible_models_endpoint;
use crate::model_hub::provider_catalog::find_provider;
use crate::model_hub::providers::{get_provider_adapter, ProviderCall};
use crate::model_hub::types::{
    ConnectivityResult, ProviderAccountRecord, ProviderAuthMethod, ProviderEndpointType,
    ProviderExecutionContext,
};

use crate::model_hub::service::ServiceError;

/// `testProviderAccountConnectivity(account, encryptionKey, options)` from
/// `connectivity.ts:12-52`.
///
/// `decryptSecret` throws on a malformed payload in TypeScript, and that throw
/// escapes the function; the port surfaces it as [`ServiceError::Crypto`]. Every
/// other branch returns `{ ok, message }`.
pub async fn test_provider_account_connectivity(
    call: &ProviderCall<'_>,
    account: &ProviderAccountRecord,
    encryption_key: &str,
    model: Option<&str>,
) -> Result<ConnectivityResult, ServiceError> {
    let Some(provider) = find_provider(&account.provider_id) else {
        return Ok(ConnectivityResult::failed(format!(
            "Unknown provider: {}",
            account.provider_id
        )));
    };

    let secret = decrypt_secret(&account.encrypted_secret_payload(), encryption_key)?;
    if account.auth_method != ProviderAuthMethod::None && secret.trim().is_empty() {
        return Ok(ConnectivityResult::failed("Missing secret token."));
    }

    if let Some(adapter) = get_provider_adapter(&provider.id) {
        let context = ProviderExecutionContext {
            provider: provider.clone(),
            account: account.clone(),
            secret,
        };
        return Ok(adapter.test_connectivity(&context, call, model).await);
    }

    if provider.endpoint_type == ProviderEndpointType::OpenAiCompatible {
        // `provider.apiBaseUrl?.replace(/\/$/, '')` — a single trailing slash is
        // removed, so `…/v1//` keeps its second slash.
        let base_url = provider
            .api_base_url
            .as_deref()
            .map(|base| base.strip_suffix('/').unwrap_or(base));
        let Some(base_url) = base_url.filter(|base| !base.is_empty()) else {
            return Ok(ConnectivityResult::failed(format!(
                "{} has no configured API base URL.",
                provider.name
            )));
        };

        return Ok(test_openai_compatible_models_endpoint(
            call.transport,
            base_url,
            &secret,
            &format!("{} connectivity verified.", provider.name),
            &format!("{} connectivity failed: ", provider.name),
        )
        .await);
    }

    Ok(ConnectivityResult::failed(format!(
        "{} connectivity adapter not implemented.",
        provider.name
    )))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use http::{HeaderMap, StatusCode};
    use serde_json::json;

    use super::*;
    use crate::model_hub::crypto::encrypt_secret_with_iv;
    use crate::model_hub::env::EnvOverrides;
    use crate::model_hub::http::{BoxFuture, HttpError, HttpRequest, HttpResponse, HttpTransport};
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

    /// `connectivity.ts:17-20`: an id outside the catalog is reported verbatim.
    #[tokio::test]
    async fn an_unknown_provider_is_reported() {
        let transport = StubTransport::new(HttpResponse::new(StatusCode::OK, HeaderMap::new(), ""));
        let env = EnvOverrides::new();
        let result = test_provider_account_connectivity(
            &call(&transport, &env),
            &account("does-not-exist", ProviderAuthMethod::ApiKey, "sk"),
            KEY,
            None,
        )
        .await
        .expect("no crypto error");

        assert_eq!(
            result,
            ConnectivityResult::failed("Unknown provider: does-not-exist")
        );
        assert!(transport.seen().is_empty(), "no request is issued");
    }

    /// `connectivity.ts:22-25`: an authenticating account without a usable secret
    /// is rejected before any adapter runs.
    #[tokio::test]
    async fn a_missing_secret_short_circuits() {
        let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({})));
        let env = EnvOverrides::new();
        let result = test_provider_account_connectivity(
            &call(&transport, &env),
            &account("mistral", ProviderAuthMethod::ApiKey, "   "),
            KEY,
            None,
        )
        .await
        .expect("no crypto error");

        assert_eq!(result, ConnectivityResult::failed("Missing secret token."));
        assert!(transport.seen().is_empty());
    }

    /// `connectivity.ts:27-32`: a provider with an adapter delegates to it.
    #[tokio::test]
    async fn a_provider_adapter_is_used() {
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "data": [] })));
        let env = EnvOverrides::new();
        let result = test_provider_account_connectivity(
            &call(&transport, &env),
            &account("mistral", ProviderAuthMethod::ApiKey, "sk-mistral"),
            KEY,
            None,
        )
        .await
        .expect("no crypto error");

        assert!(result.ok);
        assert_eq!(
            result.message,
            "Mistral connectivity verified (models list reachable)."
        );
        assert_eq!(transport.seen()[0].url, "https://api.mistral.ai/v1/models");
    }

    /// `authMethod === 'none'` skips the missing-secret guard
    /// (`connectivity.ts:23`).
    #[tokio::test]
    async fn an_unauthenticated_account_still_probes() {
        let transport =
            StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({ "data": [] })));
        let env = EnvOverrides::new();
        let result = test_provider_account_connectivity(
            &call(&transport, &env),
            &account("mistral", ProviderAuthMethod::None, ""),
            KEY,
            None,
        )
        .await
        .expect("no crypto error");

        assert!(result.ok);
        assert_eq!(transport.seen().len(), 1);
    }

    /// `decryptSecret` throwing (`connectivity.ts:22`) escapes as a crypto error.
    #[tokio::test]
    async fn an_undecryptable_secret_is_reported() {
        let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({})));
        let env = EnvOverrides::new();
        let mut account = account("mistral", ProviderAuthMethod::ApiKey, "sk");
        account.encrypted_secret.iv = "not-base64!".to_string();

        let error =
            test_provider_account_connectivity(&call(&transport, &env), &account, KEY, None)
                .await
                .expect_err("malformed payload");
        assert!(matches!(error, ServiceError::Crypto(_)), "{error:?}");
    }
}
