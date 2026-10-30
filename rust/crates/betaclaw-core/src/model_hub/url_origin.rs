//! Port of `src/server/model-hub/urlOrigin.ts` (1-20).
//!
//! The module turns whatever host the process happens to be listening on into a
//! browser-reachable origin: `0.0.0.0`, `::` and `[::]` are wildcard binds and
//! are rewritten to `localhost`, everything else is returned unchanged
//! (`normalizeBrowserOrigin`, `urlOrigin.ts:3-14`). `buildModelHubCallbackUrl`
//! appends the OAuth callback path (`urlOrigin.ts:16-20`).
//!
//! # Deviation
//!
//! TypeScript uses the WHATWG `URL` parser (`urlOrigin.ts:5`). `betaclaw-core`
//! declares no URL crate (see the workspace dependency set in `rust/Cargo.toml`),
//! so the origin is reconstructed from [`http::Uri`], which is already a
//! dependency. `http::Uri` accepts exactly the absolute `scheme://host` form this
//! code needs and exposes the scheme, host and port separately; the default-port
//! elision (`http://host:80` -> `http://host`) matches WHATWG serialisation.
//! Inputs the WHATWG parser would percent-encode but `http::Uri` rejects fall
//! back to the original string, which is exactly the TypeScript `catch` branch
//! (`urlOrigin.ts:11-13`).

use http::Uri;

/// `INVALID_BROWSER_HOSTS` from `urlOrigin.ts:1`.
///
/// WHATWG serialises an IPv6 host *with* brackets, so `[::]` is the spelling the
/// `URL` parser produces for `http://[::]`; the unbracketed `::` is kept for the
/// cases where a caller passes the raw wildcard.
const INVALID_BROWSER_HOSTS: &[&str] = &["0.0.0.0", "::", "[::]"];

/// The default port for a scheme, if it has one (`URL` drops it from `origin`).
fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "http" | "ws" => Some(80),
        "https" | "wss" => Some(443),
        "ftp" => Some(21),
        _ => None,
    }
}

/// `url.origin` for an already parsed absolute URI, or `None` when the URI has
/// no scheme or authority (which is the `new URL(...)` throw case).
fn origin_of(uri: &Uri) -> Option<String> {
    let scheme = uri.scheme_str()?;
    let authority = uri.authority()?;
    let host = authority.host();
    if host.is_empty() {
        return None;
    }

    let mut origin = format!("{scheme}://{host}");
    if let Some(port) = authority.port_u16() {
        if default_port(scheme) != Some(port) {
            origin.push(':');
            origin.push_str(&port.to_string());
        }
    }
    Some(origin)
}

/// `normalizeBrowserOrigin(origin)` from `urlOrigin.ts:3-14`.
///
/// A wildcard host becomes `localhost` with the same scheme and port; every other
/// origin round-trips unchanged. An unparsable input is returned verbatim, which
/// is the TypeScript `catch` fallback.
pub fn normalize_browser_origin(origin: &str) -> String {
    let Ok(uri) = origin.parse::<Uri>() else {
        return origin.to_string();
    };
    let Some(mut normalized) = origin_of(&uri) else {
        return origin.to_string();
    };

    if let (Some(scheme), Some(authority)) = (uri.scheme_str(), uri.authority()) {
        if INVALID_BROWSER_HOSTS.contains(&authority.host()) {
            normalized = format!("{scheme}://localhost");
            if let Some(port) = authority.port_u16() {
                if default_port(scheme) != Some(port) {
                    normalized.push(':');
                    normalized.push_str(&port.to_string());
                }
            }
        }
    }
    normalized
}

/// Failure of [`build_model_hub_callback_url`]: `new URL(requestUrl)` would have
/// thrown a `TypeError` in TypeScript.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UrlOriginError {
    /// The request URL is not an absolute `scheme://host` URL.
    #[error("Invalid URL")]
    InvalidUrl,
}

/// `buildModelHubCallbackUrl(requestUrl)` from `urlOrigin.ts:16-20`.
///
/// `new URL(requestUrl)` throws for a missing scheme or host, which the port
/// reports as [`UrlOriginError::InvalidUrl`] instead of a `TypeError`.
pub fn build_model_hub_callback_url(request_url: &str) -> Result<String, UrlOriginError> {
    let uri: Uri = request_url
        .parse()
        .map_err(|_| UrlOriginError::InvalidUrl)?;
    let origin = origin_of(&uri).ok_or(UrlOriginError::InvalidUrl)?;
    let normalized = normalize_browser_origin(&origin);
    Ok(format!("{normalized}/api/model-hub/oauth/callback"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `urlOrigin.ts:6-9`: a wildcard host is swapped for `localhost`, keeping the
    /// port; `localhost` and a concrete host are unchanged.
    #[test]
    fn wildcard_hosts_become_localhost() {
        assert_eq!(
            normalize_browser_origin("http://0.0.0.0:3000"),
            "http://localhost:3000"
        );
        assert_eq!(
            normalize_browser_origin("http://0.0.0.0"),
            "http://localhost"
        );
        assert_eq!(
            normalize_browser_origin("https://0.0.0.0:8443"),
            "https://localhost:8443"
        );
    }

    /// `new URL(...).hostname` keeps the IPv6 brackets, which is why the set
    /// carries both `::` and `[::]`.
    #[test]
    fn ipv6_wildcards_become_localhost() {
        assert_eq!(
            normalize_browser_origin("http://[::]:3000"),
            "http://localhost:3000"
        );
        // A non-wildcard IPv6 origin stays untouched.
        assert_eq!(
            normalize_browser_origin("http://[::1]:3000"),
            "http://[::1]:3000"
        );
    }

    #[test]
    fn non_wildcard_origins_round_trip() {
        assert_eq!(
            normalize_browser_origin("http://localhost:3000"),
            "http://localhost:3000"
        );
        assert_eq!(
            normalize_browser_origin("https://app.example.com"),
            "https://app.example.com"
        );
    }

    /// The default port is dropped from `URL.origin`, exactly like WHATWG
    /// serialisation; a non-default port is kept.
    #[test]
    fn default_ports_are_elided() {
        assert_eq!(
            normalize_browser_origin("http://0.0.0.0:80"),
            "http://localhost"
        );
        assert_eq!(normalize_browser_origin("https://host:443"), "https://host");
        assert_eq!(
            normalize_browser_origin("http://host:8080"),
            "http://host:8080"
        );
    }

    /// `urlOrigin.ts:11-13`: a value the parser rejects is returned verbatim.
    #[test]
    fn unparsable_input_is_returned_verbatim() {
        assert_eq!(normalize_browser_origin("not a url"), "not a url");
        assert_eq!(normalize_browser_origin(""), "");
        assert_eq!(normalize_browser_origin("/relative/path"), "/relative/path");
    }

    /// `urlOrigin.ts:18-19`: origin first, then the fixed callback path.
    #[test]
    fn callback_url_appends_the_fixed_path() {
        assert_eq!(
            build_model_hub_callback_url("http://0.0.0.0:3000/api/model-hub/oauth/start"),
            Ok("http://localhost:3000/api/model-hub/oauth/callback".to_string())
        );
        assert_eq!(
            build_model_hub_callback_url("https://app.example.com/some/path?q=1"),
            Ok("https://app.example.com/api/model-hub/oauth/callback".to_string())
        );
    }

    #[test]
    fn callback_url_rejects_a_relative_url() {
        assert_eq!(
            build_model_hub_callback_url("/api/model-hub/oauth/start"),
            Err(UrlOriginError::InvalidUrl)
        );
    }
}
