//! Productive [`HttpTransport`] for the Model Hub (OP-16).
//!
//! `betaclaw-core` owns no HTTP client (see `model_hub/http.rs:231-236`); it
//! defines the [`HttpTransport`] seam and ships only `UnreachableTransport` and
//! the test doubles. This module is the missing production implementation: a
//! `reqwest` client that turns an [`HttpRequest`] into a real call and a
//! [`HttpResponse`] back.
//!
//! Contract details pinned by `model_hub/http.rs`:
//!
//! - `request.timeout_ms` is the `fetchWithTimeout` deadline, applied per request
//!   through `RequestBuilder::timeout`.
//! - `request.abort` is the caller's `AbortSignal`; it is checked before the send
//!   (a pre-aborted request never leaves the process) and a matching
//!   `reqwest` timeout is reported as [`HttpError::Timeout`], everything else as
//!   [`HttpError::Transport`].
//! - `HttpResponse.status_text` is filled from the IANA reason phrase by
//!   `HttpResponse::new`, which is what Node's `fetch` reports.
//!
//! Wire it into the gateway's `AppState` and hand it to
//! `ServiceDependencies { transport, .. }` so `dispatch_gateway` is reachable
//! outside tests.

use std::time::Duration;

use betaclaw_core::model_hub::http::{
    AbortSignal, BoxFuture, HttpError, HttpRequest, HttpResponse, HttpTransport,
};
use http::{HeaderMap, StatusCode};

/// The production transport: one shared `reqwest::Client`.
#[derive(Clone, Debug)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    /// A transport over a default `reqwest::Client`.
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    /// A transport over an existing client, so the caller controls the pool and
    /// the TLS configuration.
    pub fn with_client(client: reqwest::Client) -> Self {
        Self { client }
    }

    /// The underlying client — for the reverse proxy and other shared callers.
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport for ReqwestTransport {
    fn send<'a>(&'a self, request: HttpRequest) -> BoxFuture<'a, Result<HttpResponse, HttpError>> {
        Box::pin(async move {
            let abort: Option<AbortSignal> = request.abort.clone();
            if abort.as_ref().is_some_and(AbortSignal::is_aborted) {
                return Err(HttpError::Aborted);
            }

            let method = reqwest::Method::from_bytes(request.method.as_str().as_bytes())
                .map_err(|error| HttpError::Transport(error.to_string()))?;

            let mut builder = self
                .client
                .request(method, request.url.as_str())
                .timeout(Duration::from_millis(request.timeout_ms));

            for (name, value) in request.headers.iter() {
                builder = builder.header(name.clone(), value.clone());
            }
            if let Some(body) = request.body {
                builder = builder.body(body);
            }

            let response = builder.send().await.map_err(map_reqwest_error)?;

            // `AbortSignal.any` rejects the pending fetch as soon as either input
            // fires; a signal that fires while the request is in flight is
            // reported as an abort rather than as the client's error text.
            if abort.as_ref().is_some_and(AbortSignal::is_aborted) {
                return Err(HttpError::Aborted);
            }

            let status = StatusCode::from_u16(response.status().as_u16())
                .map_err(|error| HttpError::Transport(error.to_string()))?;

            let mut headers = HeaderMap::new();
            for (name, value) in response.headers().iter() {
                headers.insert(name.clone(), value.clone());
            }

            let body = response.text().await.map_err(map_reqwest_error)?;

            Ok(HttpResponse::new(status, headers, body))
        })
    }
}

/// `reqwest` failures become the transport's own error type. A deadline is
/// [`HttpError::Timeout`] (`fetchWithTimeout` aborts its controller, which
/// surfaces as an `AbortError` in Node); everything else keeps the client text.
fn map_reqwest_error(error: reqwest::Error) -> HttpError {
    if error.is_timeout() {
        HttpError::Timeout
    } else {
        HttpError::Transport(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pre-aborted request never leaves the process.
    #[tokio::test]
    async fn an_aborted_request_is_short_circuited() {
        let transport = ReqwestTransport::new();
        let signal = AbortSignal::new();
        signal.abort();
        let request = HttpRequest::get("http://127.0.0.1:1/").abort(signal);
        assert_eq!(
            transport.send(request).await.unwrap_err(),
            HttpError::Aborted
        );
    }

    /// A connection failure is reported as a transport error, not a panic.
    #[tokio::test]
    async fn a_connection_failure_is_a_transport_error() {
        let transport = ReqwestTransport::new();
        // Port 1 is not listening on the build host.
        let request = HttpRequest::get("http://127.0.0.1:1/").timeout_ms(2_000);
        let error = transport.send(request).await.unwrap_err();
        assert!(matches!(error, HttpError::Transport(_)), "{error:?}");
    }
}
