//! Port of `src/server/model-hub/Models/openai-codex/client/usage.ts`.
//!
//! `GET ${backendRoot}/wham/usage` fills the rate-limit snapshot that the
//! response headers may not carry. A non-2xx status and an unparsable body both
//! read as "no snapshot" (`usage.ts:21-23`); only a header failure or a
//! transport failure is an `Err`, which is what `testConnectivity.ts:21-25`
//! catches.

use serde_json::Value;

use crate::model_hub::http::{fetch_with_timeout, HttpRequest, HttpTransport};
use crate::model_hub::types::RateLimitSnapshot;

use super::super::parsers::usage_rate_limit_parser::parse_codex_usage_rate_limits;
use super::super::types::CodexError;
use super::config::{build_codex_usage_headers, resolve_codex_usage_endpoint};

/// `CODEX_USAGE_TIMEOUT_MS` from `usage.ts:6`.
pub const CODEX_USAGE_TIMEOUT_MS: u64 = 15_000;

/// `fetchCodexUsageRateLimits(secret)` from `usage.ts:8-24`.
pub async fn fetch_codex_usage_rate_limits(
    transport: &dyn HttpTransport,
    secret: &str,
) -> Result<Option<RateLimitSnapshot>, CodexError> {
    let endpoint = resolve_codex_usage_endpoint(None);
    let headers = build_codex_usage_headers(secret)?;

    let mut http_request = HttpRequest::get(endpoint).timeout_ms(CODEX_USAGE_TIMEOUT_MS);
    for (name, value) in headers {
        http_request = http_request.header(name, &value);
    }

    let response = fetch_with_timeout(transport, http_request)
        .await
        .map_err(|error| CodexError::new(error.to_string()))?;

    if !response.is_ok() {
        return Ok(None);
    }

    // `await response.json().catch(() => null)`.
    let payload: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
    Ok(parse_codex_usage_rate_limits(&payload))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use base64::Engine as _;
    use http::StatusCode;
    use serde_json::json;

    use super::*;
    use crate::model_hub::http::{BoxFuture, HttpError, HttpResponse, HttpTransport};

    struct StubTransport {
        response: HttpResponse,
        requests: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        fn new(response: HttpResponse) -> Self {
            Self {
                response,
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.requests.lock().expect("lock").push(request);
            let response = self.response.clone();
            Box::pin(async move { Ok(response) })
        }
    }

    /// A token with the account claim, mirroring
    /// `openai-codex-models.test.ts:6-15`.
    fn token() -> String {
        let payload = json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct" }
        });
        format!(
            "h.{}.s",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string())
        )
    }

    #[tokio::test]
    async fn a_usage_payload_becomes_a_snapshot() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({
                "rate_limit": {
                    "primary_window": { "used_percent": 12, "limit_window_seconds": 18000 },
                    "secondary_window": { "used_percent": 0, "limit_window_seconds": 604800 }
                }
            }),
        ));

        let snapshot = fetch_codex_usage_rate_limits(&transport, &token())
            .await
            .expect("fetch")
            .expect("snapshot");
        let labels: Vec<&str> = snapshot
            .windows
            .iter()
            .map(|window| window.window.as_str())
            .collect();
        assert_eq!(labels, vec!["5h", "7d"]);
        assert_eq!(snapshot.windows[0].used_percent, Some(12.0));
        assert_eq!(snapshot.windows[0].remaining_percent, Some(88.0));

        let requests = transport.requests.lock().expect("lock");
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].url,
            "https://chatgpt.com/backend-api/wham/usage"
        );
    }

    /// A non-2xx status and an unparsable body both read as "no snapshot".
    #[tokio::test]
    async fn an_unusable_usage_response_reads_as_no_snapshot() {
        let unauthorized = StubTransport::new(HttpResponse::text(StatusCode::UNAUTHORIZED, "nope"));
        assert_eq!(
            fetch_codex_usage_rate_limits(&unauthorized, &token())
                .await
                .expect("fetch"),
            None
        );

        let unparsable = StubTransport::new(HttpResponse::text(StatusCode::OK, "<html>"));
        assert_eq!(
            fetch_codex_usage_rate_limits(&unparsable, &token())
                .await
                .expect("fetch"),
            None
        );
    }

    /// A secret without the claim fails before the request is sent.
    #[tokio::test]
    async fn a_missing_claim_is_an_error() {
        let transport = StubTransport::new(HttpResponse::json(StatusCode::OK, &json!({})));
        let error = fetch_codex_usage_rate_limits(&transport, "not-a-jwt")
            .await
            .expect_err("missing claim");
        assert!(error.message.contains("chatgpt_account_id"));
        assert!(transport.requests.lock().expect("lock").is_empty());
    }
}
