//! Port of `src/server/http/fetchWithPolicy.ts`.
//!
//! Each attempt gets its own deadline. A failed attempt is retried after `delay * attempt`
//! milliseconds, up to `retries` times, when its status code is retryable or it timed out or
//! failed at the network level. The last response is returned as it is, even when its status
//! is retryable.
//!
//! Deviation: a request cancelled by the caller's signal is not retried. TypeScript retries
//! every `AbortError`, including the one raised by its own signal.

use std::time::Duration;

use crate::model_hub::http::{
    fetch_with_timeout, HttpError, HttpRequest, HttpResponse, HttpTransport,
};

/// `DEFAULT_TIMEOUT_MS`.
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
/// `DEFAULT_RETRY_COUNT`.
pub const DEFAULT_RETRY_COUNT: u32 = 1;
/// `DEFAULT_RETRY_BASE_DELAY_MS`.
pub const DEFAULT_RETRY_BASE_DELAY_MS: u64 = 300;
/// `RETRYABLE_STATUS_CODES`.
pub const RETRYABLE_STATUS_CODES: [u16; 7] = [408, 425, 429, 500, 502, 503, 504];

/// `FetchPolicyOptions` with the TypeScript defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchPolicy {
    pub timeout_ms: u64,
    pub retries: u32,
    pub retry_delay_ms: u64,
    pub retryable_status_codes: Vec<u16>,
}

impl Default for FetchPolicy {
    fn default() -> Self {
        Self {
            timeout_ms: DEFAULT_TIMEOUT_MS,
            retries: DEFAULT_RETRY_COUNT,
            retry_delay_ms: DEFAULT_RETRY_BASE_DELAY_MS,
            retryable_status_codes: RETRYABLE_STATUS_CODES.to_vec(),
        }
    }
}

/// `fetchWithPolicy` (fetchWithPolicy.ts:46-79).
pub async fn fetch_with_policy(
    transport: &dyn HttpTransport,
    request: HttpRequest,
    policy: &FetchPolicy,
) -> Result<HttpResponse, HttpError> {
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let can_retry = attempt <= policy.retries;
        match fetch_with_timeout(transport, request.clone().timeout_ms(policy.timeout_ms)).await {
            Ok(response) => {
                if can_retry
                    && policy
                        .retryable_status_codes
                        .contains(&response.status.as_u16())
                {
                    sleep_before_retry(policy.retry_delay_ms, attempt).await;
                    continue;
                }
                return Ok(response);
            }
            Err(error) => {
                let retryable = matches!(error, HttpError::Timeout | HttpError::Transport(_));
                if !(can_retry && retryable) {
                    return Err(error);
                }
                sleep_before_retry(policy.retry_delay_ms, attempt).await;
            }
        }
    }
}

async fn sleep_before_retry(base_ms: u64, attempt: u32) {
    let delay = base_ms.saturating_mul(u64::from(attempt));
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net_guard::test_support::{response_with, FakeTransport};

    fn policy(retries: u32) -> FetchPolicy {
        FetchPolicy {
            retries,
            retry_delay_ms: 0,
            ..FetchPolicy::default()
        }
    }

    fn request() -> HttpRequest {
        HttpRequest::get("https://api.test/")
    }

    #[tokio::test]
    async fn a_retryable_status_is_retried_and_the_last_response_returned() {
        let transport = FakeTransport::with(vec![
            Ok(response_with(503, &[], "")),
            Ok(response_with(503, &[], "still down")),
        ]);
        let response = fetch_with_policy(&transport, request(), &policy(1))
            .await
            .expect("response");
        assert_eq!(response.status.as_u16(), 503);
        assert_eq!(response.body, "still down");
        assert_eq!(transport.requests().len(), 2);
    }

    #[tokio::test]
    async fn a_network_error_is_retried() {
        let transport = FakeTransport::with(vec![
            Err(HttpError::Transport("connection reset".to_string())),
            Ok(response_with(200, &[], "ok")),
        ]);
        let response = fetch_with_policy(&transport, request(), &policy(1))
            .await
            .expect("response");
        assert_eq!(response.status.as_u16(), 200);
        assert_eq!(transport.requests().len(), 2);
    }

    #[tokio::test]
    async fn a_client_error_is_returned_without_a_retry() {
        let transport = FakeTransport::with(vec![Ok(response_with(404, &[], "missing"))]);
        let response = fetch_with_policy(&transport, request(), &policy(3))
            .await
            .expect("response");
        assert_eq!(response.status.as_u16(), 404);
        assert_eq!(transport.requests().len(), 1);
    }

    #[tokio::test]
    async fn a_cancelled_request_is_not_retried() {
        let transport = FakeTransport::with(vec![
            Err(HttpError::Aborted),
            Ok(response_with(200, &[], "ok")),
        ]);
        let error = fetch_with_policy(&transport, request(), &policy(1))
            .await
            .unwrap_err();
        assert_eq!(error, HttpError::Aborted);
        assert_eq!(transport.requests().len(), 1);
    }

    #[tokio::test]
    async fn timeouts_are_retried_until_the_budget_is_spent() {
        let transport = FakeTransport::with(vec![Err(HttpError::Timeout), Err(HttpError::Timeout)]);
        let error = fetch_with_policy(&transport, request(), &policy(1))
            .await
            .unwrap_err();
        assert_eq!(error, HttpError::Timeout);
        assert_eq!(transport.requests().len(), 2);
    }
}
