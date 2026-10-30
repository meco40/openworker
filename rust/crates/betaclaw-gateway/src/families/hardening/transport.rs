//! Helpers for the Model Hub HTTP client (`model_hub_transport.rs`).
//!
//! The SSRF guard checks a host and pins the request to the address it checked
//! (`HttpRequest::resolve_to`). [`pinned_client`] carries out that pin. [`read_capped_body`]
//! enforces `HttpRequest::max_body_bytes` while the body streams in.

use std::net::SocketAddr;

use betaclaw_core::model_hub::http::HttpError;
use reqwest::redirect::Policy;

use crate::model_hub_transport::map_reqwest_error;

/// A client that connects to `address` for the host of `url` and does not follow redirects.
///
/// `resolve` replaces the DNS lookup for that one host only. TLS still checks the certificate
/// against the host name, so the pin changes the address and not the identity. `no_proxy` keeps
/// `HTTP_PROXY` from sending the request to the proxy, which would resolve the host itself.
pub fn pinned_client(url: &str, address: SocketAddr) -> Result<reqwest::Client, HttpError> {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .ok_or_else(|| HttpError::Transport("A pinned request needs a host name.".to_string()))?;
    reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve(&host, address)
        .build()
        .map_err(map_reqwest_error)
}

/// Reads the body chunk by chunk and fails as soon as it grows past `max_bytes`.
///
/// Without a cap the whole body is read, as before.
pub async fn read_capped_body(
    response: &mut reqwest::Response,
    max_bytes: Option<usize>,
) -> Result<Vec<u8>, HttpError> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(map_reqwest_error)? {
        if let Some(max) = max_bytes.filter(|max| body.len() + chunk.len() > *max) {
            return Err(HttpError::Transport(format!(
                "Response body exceeds the {max}-byte limit."
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `HTTP_PROXY` must not take a pinned request away from the checked address. reqwest reads
    /// the proxy setting when a client is built, and setting an environment variable in a shared
    /// test binary would race with other tests, so the test inspects the built client instead.
    /// The default client is the control: it does carry a proxy setting.
    #[test]
    fn pinned_client_ignores_the_proxy_environment() {
        let address = SocketAddr::from(([127, 0, 0, 1], 9));
        let pinned = pinned_client("http://pinned.test/", address).expect("pinned client");
        let default = reqwest::Client::builder().build().expect("default client");
        assert!(
            format!("{default:?}").contains("proxies"),
            "the control client must show a proxy setting"
        );
        assert!(!format!("{pinned:?}").contains("proxies"), "{pinned:?}");
    }
}
