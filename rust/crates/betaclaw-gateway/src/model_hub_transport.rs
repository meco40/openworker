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
//! - Redirects are not followed. The SSRF guard follows them hop by hop, and a
//!   redirect followed here would reach a host the guard never checked.
//! - `request.resolve_to` is the address the guard checked. The request connects
//!   there (see `families::hardening::transport::pinned_client`).
//! - `request.max_body_bytes` caps the body. Reading stops with an error once the
//!   cap is exceeded (see `families::hardening::transport::read_capped_body`).
//! - Transport errors never carry the request URL. The Bot API puts its token in
//!   the path.
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
use reqwest::redirect::Policy;

use crate::families::hardening::transport::{pinned_client, read_capped_body};

/// The production transport: one shared `reqwest::Client` that does not follow redirects.
#[derive(Clone, Debug)]
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    /// A transport over a client that does not follow redirects.
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .build()
            .expect("the default HTTP client builds");
        Self { client }
    }

    /// A transport over an existing client, so the caller controls the pool and
    /// the TLS configuration. The client must not follow redirects, and `reqwest`
    /// offers no way to check that here. `AppState::upstream` still follows them.
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

            let pinned;
            let client = match request.resolve_to {
                Some(address) => {
                    pinned = pinned_client(&request.url, address)?;
                    &pinned
                }
                None => &self.client,
            };
            let mut builder = client
                .request(method, request.url.as_str())
                .timeout(Duration::from_millis(request.timeout_ms));

            for (name, value) in request.headers.iter() {
                builder = builder.header(name.clone(), value.clone());
            }
            if let Some(body) = request.body {
                builder = builder.body(body);
            }

            let mut response = builder.send().await.map_err(map_reqwest_error)?;

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

            let body = read_capped_body(&mut response, request.max_body_bytes).await?;
            Ok(HttpResponse::from_bytes(status, headers, body))
        })
    }
}

/// `reqwest` failures become the transport's own error type. A deadline is
/// [`HttpError::Timeout`] (`fetchWithTimeout` aborts its controller, which
/// surfaces as an `AbortError` in Node); everything else keeps the client text
/// without the URL, because the Bot API token sits in the path.
pub(crate) fn map_reqwest_error(error: reqwest::Error) -> HttpError {
    if error.is_timeout() {
        HttpError::Timeout
    } else {
        HttpError::Transport(error.without_url().to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Serves `response` to every connection on a loopback port and returns the port.
    async fn serve(response: impl Into<Vec<u8>>) -> u16 {
        let response: Vec<u8> = response.into();
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a loopback port");
        let port = listener.local_addr().expect("local address").port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let response = response.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buffer = [0u8; 1024];
                    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                        match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(read) => head.extend_from_slice(&buffer[..read]),
                        }
                    }
                    let _ = socket.write_all(&response).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        port
    }

    fn http_response(status_line: &str, extra_headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status_line}\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

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

    /// A 302 is returned as it is. The redirect target is never requested, so the
    /// target's closed port would fail the call if it were followed.
    #[tokio::test]
    async fn a_redirect_is_returned_and_not_followed() {
        let location = "Location: http://127.0.0.1:1/followed\r\n";
        let port = serve(http_response("302 Found", location, "")).await;
        let request = HttpRequest::get(format!("http://127.0.0.1:{port}/start")).timeout_ms(2_000);
        let response = ReqwestTransport::new()
            .send(request)
            .await
            .expect("the 302 is an answer, not an error");
        assert_eq!(response.status, StatusCode::FOUND);
    }

    /// A body past `max_body_bytes` fails the call. A body under the cap arrives whole.
    #[tokio::test]
    async fn the_body_cap_refuses_an_oversized_response() {
        let body = "x".repeat(2_000);
        let port = serve(http_response("200 OK", "", &body)).await;
        let url = format!("http://127.0.0.1:{port}/");
        let refused = ReqwestTransport::new()
            .send(HttpRequest::get(&url).timeout_ms(2_000).max_body_bytes(100))
            .await
            .unwrap_err();
        assert_eq!(
            refused,
            HttpError::Transport("Response body exceeds the 100-byte limit.".to_string())
        );
        let whole = ReqwestTransport::new()
            .send(
                HttpRequest::get(&url)
                    .timeout_ms(2_000)
                    .max_body_bytes(4_096),
            )
            .await
            .expect("a body under the cap is read");
        assert_eq!(whole.body.len(), 2_000);
    }

    /// `resolve_to` connects to the checked address. `pinned.invalid` is not in DNS,
    /// so only the pin can reach the server.
    #[tokio::test]
    async fn resolve_to_connects_to_the_checked_address() {
        let port = serve(http_response("200 OK", "", "pinned")).await;
        let request = HttpRequest::get(format!("http://pinned.invalid:{port}/"))
            .timeout_ms(5_000)
            .resolve_to(SocketAddr::from(([127, 0, 0, 1], port)));
        let response = ReqwestTransport::new()
            .send(request)
            .await
            .expect("the pinned address answers");
        assert_eq!(response.body, "pinned");
    }

    /// The Bot API puts its token in the URL path, so no error text may carry the URL.
    #[tokio::test]
    async fn transport_errors_omit_the_request_url() {
        let request =
            HttpRequest::get("http://127.0.0.1:1/bot-SECRET-TOKEN/getMe").timeout_ms(2_000);
        let error = ReqwestTransport::new().send(request).await.unwrap_err();
        let HttpError::Transport(text) = &error else {
            panic!("expected a transport error, got {error:?}");
        };
        assert!(
            !text.contains("SECRET-TOKEN") && !text.contains("127.0.0.1"),
            "{text}"
        );
    }

    /// A PNG header with NUL and 0xFF bytes arrives unchanged in `body_bytes`. `body` holds
    /// its lossy text.
    #[tokio::test]
    async fn binary_bodies_arrive_unchanged_in_body_bytes() {
        const PNG: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0x00,
        ];
        let mut raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            PNG.len()
        )
        .into_bytes();
        raw.extend_from_slice(PNG);
        let port = serve(raw).await;
        let request =
            HttpRequest::get(format!("http://127.0.0.1:{port}/cat.png")).timeout_ms(2_000);
        let response = ReqwestTransport::new()
            .send(request)
            .await
            .expect("the image is an answer");
        assert_eq!(response.body_bytes, PNG);
        assert_eq!(response.body, String::from_utf8_lossy(PNG).into_owned());
    }
}
