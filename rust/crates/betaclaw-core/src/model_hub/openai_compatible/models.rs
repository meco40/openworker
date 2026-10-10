//! Port of `src/server/model-hub/Models/shared/openai-compatible/models/fetch.ts`.

use serde_json::Value;

use super::utils::{build_models_url, build_optional_auth_headers};
use crate::model_hub::http::{
    fetch_with_timeout, HttpError, HttpRequest, HttpResponse, HttpTransport,
};
use crate::model_hub::types::{ConnectivityResult, FetchedModel};

/// `fetchOpenAICompatibleModels` from `models/fetch.ts:8-28`.
///
/// A non-2xx status yields an empty list instead of an error, which is what makes
/// Kimi fall back to its seed models. A transport failure *does* propagate — the
/// caller decides whether to swallow it.
///
/// A model entry without an `id` becomes an empty string here; in TypeScript the
/// field is `undefined`, which only matters for the Kimi merge that skips falsy
/// ids and for `JSON.stringify` dropping the key.
pub async fn fetch_openai_compatible_models(
    transport: &dyn HttpTransport,
    base_url: &str,
    secret: &str,
    provider_id: &str,
) -> Result<Vec<FetchedModel>, HttpError> {
    let request = HttpRequest::get(build_models_url(base_url));
    let response = fetch_with_timeout(transport, with_auth(request, secret)).await?;

    if !response.is_ok() {
        return Ok(Vec::new());
    }

    let json: Value = serde_json::from_str(&response.body)
        .map_err(|error| HttpError::InvalidBody(error.to_string()))?;

    Ok(json
        .get("data")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .map(|model| FetchedModel {
                    id: model
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    // `name: model.id` — the shared path does not use a `name`
                    // field even when the provider sends one.
                    name: model
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    provider: provider_id.to_string(),
                    owned_by: model
                        .get("owned_by")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    context_window: None,
                    created: model.get("created").and_then(Value::as_f64),
                    billing: None,
                })
                .collect()
        })
        .unwrap_or_default())
}

/// `testOpenAICompatibleModelsEndpoint` from `models/fetch.ts:30-53`.
///
/// Unlike the fetch helper this one never propagates: every failure becomes
/// `{ ok: false, message: failurePrefix + reason }`, and the reason for a non-2xx
/// status is the raw body text with `HTTP <status>` as the empty fallback.
pub async fn test_openai_compatible_models_endpoint(
    transport: &dyn HttpTransport,
    base_url: &str,
    secret: &str,
    success_message: &str,
    failure_prefix: &str,
) -> ConnectivityResult {
    let request = HttpRequest::get(build_models_url(base_url));
    match fetch_with_timeout(transport, with_auth(request, secret)).await {
        Ok(response) if !response.is_ok() => {
            ConnectivityResult::failed(format!("{failure_prefix}{}", failure_reason(&response)))
        }
        Ok(_) => ConnectivityResult::ok(success_message),
        Err(error) => ConnectivityResult::failed(format!("{failure_prefix}{error}")),
    }
}

/// `text || `HTTP ${response.status}``.
fn failure_reason(response: &HttpResponse) -> String {
    if response.body.is_empty() {
        format!("HTTP {}", response.status.as_u16())
    } else {
        response.body.clone()
    }
}

/// `headers: buildOptionalAuthHeaders(secret)` from `utils.ts:15-19`.
fn with_auth(request: HttpRequest, secret: &str) -> HttpRequest {
    match build_optional_auth_headers(secret) {
        Some(authorization) => request.header("Authorization", &authorization),
        None => request,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use http::{HeaderMap, StatusCode};

    use super::*;
    use crate::model_hub::http::BoxFuture;

    struct RecordingTransport {
        response: HttpResponse,
        seen: std::sync::Mutex<Vec<HttpRequest>>,
    }

    impl RecordingTransport {
        fn new(response: HttpResponse) -> Arc<Self> {
            Arc::new(Self {
                response,
                seen: std::sync::Mutex::new(Vec::new()),
            })
        }
    }

    impl HttpTransport for RecordingTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen.lock().expect("lock").push(request.clone());
            let response = self.response.clone();
            Box::pin(async move { Ok(response) })
        }
    }

    #[tokio::test]
    async fn maps_the_models_list() {
        let transport = RecordingTransport::new(HttpResponse::json(
            StatusCode::OK,
            &serde_json::json!({
                "data": [
                    { "id": "gpt-4.1", "owned_by": "openai", "created": 1_700_000_000 },
                    { "id": "gpt-4o" }
                ]
            }),
        ));
        let models = fetch_openai_compatible_models(
            &*transport,
            "https://api.openai.com/v1",
            "sk-test",
            "openai",
        )
        .await
        .expect("fetch models");

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-4.1");
        assert_eq!(models[0].name, "gpt-4.1");
        assert_eq!(models[0].provider, "openai");
        assert_eq!(models[0].owned_by.as_deref(), Some("openai"));
        assert_eq!(models[0].created, Some(1_700_000_000.0));
        assert_eq!(models[1].owned_by, None);

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen[0].url, "https://api.openai.com/v1/models");
        assert_eq!(
            seen[0].headers.get("authorization").expect("auth header"),
            "Bearer sk-test"
        );
    }

    /// A non-2xx status yields an empty list, which is what lets Kimi fall back to
    /// its seed models (`tests/unit/model-hub/kimi-models.test.ts`).
    #[tokio::test]
    async fn a_rejected_request_returns_an_empty_list() {
        let transport = RecordingTransport::new(HttpResponse::json(
            StatusCode::FORBIDDEN,
            &serde_json::json!({ "error": "nope" }),
        ));
        let models = fetch_openai_compatible_models(&*transport, "https://x/v1", "sk", "kimi")
            .await
            .expect("no transport error");
        assert!(models.is_empty());
    }

    #[tokio::test]
    async fn a_missing_data_key_yields_an_empty_list() {
        let transport =
            RecordingTransport::new(HttpResponse::json(StatusCode::OK, &serde_json::json!({})));
        let models = fetch_openai_compatible_models(&*transport, "https://x/v1", "sk", "kimi")
            .await
            .expect("fetch");
        assert!(models.is_empty());
    }

    #[tokio::test]
    async fn connectivity_reports_the_success_message() {
        let transport = RecordingTransport::new(HttpResponse::json(
            StatusCode::OK,
            &serde_json::json!({ "data": [] }),
        ));
        let result = test_openai_compatible_models_endpoint(
            &*transport,
            "https://api.openai.com/v1",
            "sk-test",
            "OpenAI connectivity verified (models list reachable).",
            "OpenAI connectivity failed: ",
        )
        .await;
        assert_eq!(
            result,
            ConnectivityResult::ok("OpenAI connectivity verified (models list reachable).")
        );
    }

    /// The failure prefix and the raw body text are concatenated without a
    /// separator; the provider supplies the trailing space.
    #[tokio::test]
    async fn connectivity_failure_appends_the_raw_body() {
        let transport = RecordingTransport::new(HttpResponse::text(
            StatusCode::UNAUTHORIZED,
            "invalid_authentication_error",
        ));
        let result = test_openai_compatible_models_endpoint(
            &*transport,
            "https://api.kimi.com/coding/v1",
            "sk-bad",
            "Kimi connectivity verified (models list reachable).",
            "Kimi connectivity failed: ",
        )
        .await;
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "Kimi connectivity failed: invalid_authentication_error"
        );
    }

    #[tokio::test]
    async fn connectivity_failure_falls_back_to_the_status_line() {
        let transport = RecordingTransport::new(HttpResponse::text(StatusCode::BAD_GATEWAY, ""));
        let result = test_openai_compatible_models_endpoint(
            &*transport,
            "https://x/v1",
            "sk",
            "ok",
            "prefix ",
        )
        .await;
        assert_eq!(result.message, "prefix HTTP 502");
    }

    #[tokio::test]
    async fn connectivity_never_propagates_a_transport_error() {
        let result = test_openai_compatible_models_endpoint(
            &crate::model_hub::http::UnreachableTransport,
            "https://x/v1",
            "sk",
            "ok",
            "prefix ",
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.message, "prefix No HTTP transport is configured.");
    }

    /// An empty secret produces no `Authorization` header at all.
    #[tokio::test]
    async fn an_empty_secret_omits_the_authorization_header() {
        let transport = RecordingTransport::new(HttpResponse::json(
            StatusCode::OK,
            &serde_json::json!({ "data": [] }),
        ));
        fetch_openai_compatible_models(&*transport, "https://x/v1", "  ", "ollama")
            .await
            .expect("fetch");
        let seen = transport.seen.lock().expect("lock");
        assert!(seen[0].headers.get("authorization").is_none());
        assert_eq!(seen[0].headers.len(), 0);
        let _ = HeaderMap::new();
    }
}
