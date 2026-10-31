//! Anonymous local principal and browser-origin policy.
//!
//! Direct port of `src/server/auth/proxyPolicy.ts`. Trust is derived from the TCP
//! peer and from browser fetch metadata, never from a header a client can forge.
//! The gateway deletes any inbound `x-betaclaw-client-loopback` value and sets it
//! only when the socket peer is loopback, so a missing marker fails closed.

/// Header carrying the socket-derived loopback marker.
pub const CLIENT_LOOPBACK_HEADER: &str = "x-betaclaw-client-loopback";

/// The subset of request headers this policy inspects.
#[derive(Debug, Clone, Default)]
pub struct BrowserRequestHeaders {
    pub host: Option<String>,
    pub origin: Option<String>,
    pub referer: Option<String>,
    pub sec_fetch_site: Option<String>,
}

impl BrowserRequestHeaders {
    fn host(&self) -> Option<&str> {
        self.host.as_deref().map(str::trim)
    }
    fn origin(&self) -> Option<&str> {
        self.origin.as_deref()
    }
    fn referer(&self) -> Option<&str> {
        self.referer.as_deref()
    }
}

fn normalize_host(host: Option<&str>) -> Option<String> {
    let trimmed = host?.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// True for 127.0.0.0/8, `::1` and their IPv4-mapped forms.
pub fn is_loopback_address(address: Option<&str>) -> bool {
    let Some(address) = address else {
        return false;
    };
    let mut normalized = address.trim().to_ascii_lowercase();
    if let Some(stripped) = normalized.strip_prefix("::ffff:") {
        normalized = stripped.to_string();
    }
    if normalized == "::1" {
        return true;
    }
    let Some(rest) = normalized.strip_prefix("127.") else {
        return false;
    };
    let octets: Vec<&str> = rest.split('.').collect();
    if octets.len() != 3 {
        return false;
    }
    octets.iter().all(|octet| {
        !octet.is_empty()
            && octet.len() <= 3
            && octet.chars().all(|c| c.is_ascii_digit())
            && octet
                .parse::<u32>()
                .map(|value| value <= 255)
                .unwrap_or(false)
    })
}

/// Extracts the host name from a `Host` header, rejecting userinfo and stray
/// colons. Returns `None` for anything that is not a plain name or a bracketed
/// IPv6 literal with an optional port.
fn host_name_of(host_header: Option<&str>) -> Option<String> {
    let host = normalize_host(host_header)?;
    if host == "::1" {
        return Some(host);
    }
    let bracketed = host.starts_with('[');
    let close_at = if bracketed { host.find(']') } else { None };
    if bracketed && close_at.is_none() {
        return None;
    }
    let colon = host.find(':');
    let name = if bracketed {
        host[1..close_at.unwrap()].to_string()
    } else if colon.is_none() {
        host.clone()
    } else {
        host[..colon.unwrap()].to_string()
    };
    let suffix = if bracketed {
        host[close_at.unwrap() + 1..].to_string()
    } else {
        host[name.len()..].to_string()
    };
    if !suffix.is_empty() && !is_port_suffix(&suffix) {
        return None;
    }
    if !bracketed {
        let valid = !name.is_empty()
            && !name.contains('@')
            && !name.contains('/')
            && !name.contains('[')
            && !name.contains(']')
            && !name.contains(':')
            && !name.chars().any(char::is_whitespace);
        if !valid {
            return None;
        }
    }
    Some(name)
}

fn is_port_suffix(suffix: &str) -> bool {
    let Some(port) = suffix.strip_prefix(':') else {
        return false;
    };
    !port.is_empty() && port.len() <= 5 && port.chars().all(|c| c.is_ascii_digit())
}

/// True when the `Host` header names a loopback address.
pub fn is_loopback_host_header(host_header: Option<&str>) -> bool {
    let Some(name) = host_name_of(host_header) else {
        return false;
    };
    name == "localhost" || name == "127.0.0.1" || name == "::1" || name.ends_with(".localhost")
}

/// Extracts the `host[:port]` authority of an absolute URL.
fn url_host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if authority.is_empty() {
        None
    } else {
        Some(authority)
    }
}

fn url_host_matches(url: Option<&str>, host: Option<&str>) -> bool {
    let (Some(url), Some(host)) = (url, host) else {
        return false;
    };
    matches!(url_host(url), Some(authority) if authority == host)
}

/// True when a browser reports the request as cross-site: Fetch Metadata says so,
/// or a present `Origin`/`Referer` names a different host (including opaque "null").
pub fn is_cross_site_browser_request(input: &BrowserRequestHeaders) -> bool {
    if let Some(site) = input.sec_fetch_site.as_deref().map(str::trim) {
        let site = site.to_ascii_lowercase();
        if site == "cross-site" || site == "same-site" {
            return true;
        }
    }
    let host = normalize_host(input.host());
    let origin_present = input.origin().map(|v| !v.is_empty()).unwrap_or(false);
    let referer_present = input.referer().map(|v| !v.is_empty()).unwrap_or(false);
    (origin_present && !url_host_matches(input.origin(), host.as_deref()))
        || (referer_present && !url_host_matches(input.referer(), host.as_deref()))
}

/// True for same-origin browser UI requests.
pub fn is_same_origin_browser_request(input: &BrowserRequestHeaders) -> bool {
    if let Some(site) = input.sec_fetch_site.as_deref().map(str::trim) {
        if site.eq_ignore_ascii_case("same-origin") {
            return true;
        }
    }
    let host = normalize_host(input.host());
    url_host_matches(input.origin(), host.as_deref())
        || url_host_matches(input.referer(), host.as_deref())
}

#[derive(Debug, Clone)]
pub struct AnonymousLocalPrincipalInput {
    pub require_auth: bool,
    pub mc_api_token_configured: bool,
    pub socket_loopback: bool,
    pub browser: BrowserRequestHeaders,
}

/// Anonymous access as the local principal without a session or bearer token.
///
/// Denied when auth is required. Otherwise the TCP peer must be loopback, the
/// `Host` must name loopback (blocks DNS rebinding), and no cross-site browser may
/// be involved. With `MC_API_TOKEN` configured only same-origin browser UI qualifies.
pub fn should_allow_anonymous_local_principal(input: &AnonymousLocalPrincipalInput) -> bool {
    if input.require_auth {
        return false;
    }
    if !input.socket_loopback || !is_loopback_host_header(input.browser.host()) {
        return false;
    }
    if is_cross_site_browser_request(&input.browser) {
        return false;
    }
    !input.mc_api_token_configured || is_same_origin_browser_request(&input.browser)
}

/// Result of applying the request gate. Ported from `proxy.ts:104-244`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    /// Path is not an API path; the request continues to the UI layer.
    NotApiPath,
    /// Public endpoint (auth callbacks, webhooks, health probes).
    Public,
    /// Demo mode blocked a mutation.
    DemoBlocked,
    /// Anonymous local principal accepted.
    LocalPrincipal,
    /// Session cookie accepted.
    Session,
    /// `Bearer` token accepted.
    Bearer,
    /// Demo mode allowed a read.
    DemoRead,
    UnauthorizedNoToken,
    UnauthorizedMissingBearer,
    UnauthorizedBadBearer,
    /// `/api/events/stream` accepted a `?token=` query parameter.
    EventsQueryToken,
}

impl GateDecision {
    /// Response body and status for a rejecting decision, matching the JSON
    /// shapes produced by `proxy.ts` and `withUserContext`.
    pub fn rejection(&self) -> Option<(u16, &'static str)> {
        match self {
            GateDecision::DemoBlocked => Some((
                403,
                r#"{"error":"Demo mode — this is a read-only instance. Write operations are disabled."}"#,
            )),
            GateDecision::UnauthorizedNoToken => Some((401, r#"{"error":"Unauthorized"}"#)),
            GateDecision::UnauthorizedMissingBearer => Some((401, r#"{"error":"Unauthorized"}"#)),
            GateDecision::UnauthorizedBadBearer => Some((401, r#"{"error":"Unauthorized"}"#)),
            _ => None,
        }
    }
}

/// Outcome of the non-auth part of the gate.
pub struct GateOutcome {
    pub decision: GateDecision,
    pub set_demo_mode_header: bool,
}

/// Applies the pre-auth part of the gate.
///
/// `session_token_valid` is supplied by the caller because validating the session
/// requires the JWE decode, which is more expensive than the rest of the gate.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_gate(
    pathname: &str,
    method: &str,
    browser: &BrowserRequestHeaders,
    socket_loopback: bool,
    require_auth: bool,
    demo_mode: bool,
    mc_api_token_configured: bool,
    mc_api_token: Option<&str>,
    query_token: Option<&str>,
    authorization: Option<&str>,
    session_token_valid: bool,
) -> GateOutcome {
    if !pathname.starts_with("/api/") {
        return GateOutcome {
            decision: GateDecision::NotApiPath,
            set_demo_mode_header: demo_mode,
        };
    }

    if crate::config::is_public_api_path(pathname) {
        return GateOutcome {
            decision: GateDecision::Public,
            set_demo_mode_header: false,
        };
    }

    let method = method.to_ascii_uppercase();
    if demo_mode {
        if !matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
            return GateOutcome {
                decision: GateDecision::DemoBlocked,
                set_demo_mode_header: false,
            };
        }
        return GateOutcome {
            decision: GateDecision::DemoRead,
            set_demo_mode_header: false,
        };
    }

    if should_allow_anonymous_local_principal(&AnonymousLocalPrincipalInput {
        require_auth,
        mc_api_token_configured,
        socket_loopback,
        browser: browser.clone(),
    }) {
        return GateOutcome {
            decision: GateDecision::LocalPrincipal,
            set_demo_mode_header: false,
        };
    }

    if session_token_valid {
        return GateOutcome {
            decision: GateDecision::Session,
            set_demo_mode_header: false,
        };
    }

    let Some(token) = mc_api_token.filter(|value| !value.is_empty()) else {
        return GateOutcome {
            decision: GateDecision::UnauthorizedNoToken,
            set_demo_mode_header: false,
        };
    };

    if pathname == "/api/events/stream" {
        if let Some(candidate) = query_token {
            if constant_time_eq(candidate.as_bytes(), token.as_bytes()) {
                return GateOutcome {
                    decision: GateDecision::EventsQueryToken,
                    set_demo_mode_header: false,
                };
            }
        }
    }

    let Some(authorization) = authorization else {
        return GateOutcome {
            decision: GateDecision::UnauthorizedMissingBearer,
            set_demo_mode_header: false,
        };
    };
    let Some(provided) = strip_bearer(authorization) else {
        return GateOutcome {
            decision: GateDecision::UnauthorizedMissingBearer,
            set_demo_mode_header: false,
        };
    };

    if constant_time_eq(provided.as_bytes(), token.as_bytes()) {
        GateOutcome {
            decision: GateDecision::Bearer,
            set_demo_mode_header: false,
        }
    } else {
        GateOutcome {
            decision: GateDecision::UnauthorizedBadBearer,
            set_demo_mode_header: false,
        }
    }
}

/// Length-independent constant-time comparison.
///
/// Mirrors `constantTimeEqual()` in `proxy.ts:48-60`: the comparison walks the
/// longer of the two inputs and folds the length difference into the mismatch
/// accumulator, so the running time does not reveal the shared prefix length.
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut mismatch = (left.len() ^ right.len()) as u8;
    for index in 0..max_len {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        mismatch |= left_byte ^ right_byte;
    }
    mismatch == 0
}

/// Extracts the token from an `Authorization: Bearer <token>` header.
///
/// Matches the `/^Bearer\s+(.+)$/i` regex in `src/server/auth/userContext.ts:61`.
pub fn strip_bearer(authorization: &str) -> Option<String> {
    let trimmed = authorization.trim_start();
    let (scheme, rest) = trimmed.split_once(char::is_whitespace)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim_start();
    if token.is_empty() || token.contains(char::is_whitespace) {
        return None;
    }
    Some(token.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn browser(host: &str) -> BrowserRequestHeaders {
        BrowserRequestHeaders {
            host: Some(host.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn loopback_addresses() {
        assert!(is_loopback_address(Some("127.0.0.1")));
        assert!(is_loopback_address(Some("127.255.255.254")));
        assert!(is_loopback_address(Some("::1")));
        assert!(is_loopback_address(Some("::ffff:127.0.0.1")));
        assert!(!is_loopback_address(Some("192.168.1.10")));
        assert!(!is_loopback_address(Some("127.0.0.256")));
        assert!(!is_loopback_address(None));
    }

    #[test]
    fn loopback_host_headers() {
        assert!(is_loopback_host_header(Some("localhost:3000")));
        assert!(is_loopback_host_header(Some("127.0.0.1")));
        assert!(is_loopback_host_header(Some("[::1]:3000")));
        assert!(is_loopback_host_header(Some("app.localhost")));
        assert!(!is_loopback_host_header(Some("evil.example.com")));
        assert!(!is_loopback_host_header(Some("localhost:evil")));
        assert!(!is_loopback_host_header(Some("user@localhost")));
    }

    #[test]
    fn cross_site_detection() {
        let mut headers = browser("app.example.com");
        headers.origin = Some("https://evil.example.com".to_string());
        assert!(is_cross_site_browser_request(&headers));
        assert!(!is_same_origin_browser_request(&headers));

        let mut headers = browser("app.example.com");
        headers.origin = Some("http://app.example.com".to_string());
        assert!(!is_cross_site_browser_request(&headers));
        assert!(is_same_origin_browser_request(&headers));

        let mut headers = browser("app.example.com");
        headers.sec_fetch_site = Some("same-origin".to_string());
        assert!(is_same_origin_browser_request(&headers));

        let mut headers = browser("app.example.com");
        headers.sec_fetch_site = Some("cross-site".to_string());
        assert!(is_cross_site_browser_request(&headers));
    }

    #[test]
    fn anonymous_principal_requires_loopback_and_same_origin() {
        let input =
            |require_auth, token_configured, socket_loopback, headers: BrowserRequestHeaders| {
                AnonymousLocalPrincipalInput {
                    require_auth,
                    mc_api_token_configured: token_configured,
                    socket_loopback,
                    browser: headers,
                }
            };

        assert!(should_allow_anonymous_local_principal(&input(
            false,
            false,
            true,
            browser("localhost:3000")
        )));
        assert!(!should_allow_anonymous_local_principal(&input(
            true,
            false,
            true,
            browser("localhost:3000")
        )));
        assert!(!should_allow_anonymous_local_principal(&input(
            false,
            false,
            false,
            browser("localhost:3000")
        )));
        assert!(!should_allow_anonymous_local_principal(&input(
            false,
            false,
            true,
            browser("evil.example.com")
        )));

        // With MC_API_TOKEN set, a plain loopback client without browser
        // metadata is no longer accepted.
        assert!(!should_allow_anonymous_local_principal(&input(
            false,
            true,
            true,
            browser("localhost:3000")
        )));
    }

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secrets"));
        assert!(!constant_time_eq(b"secret", b"sekret"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn bearer_parsing() {
        assert_eq!(strip_bearer("Bearer abc123").as_deref(), Some("abc123"));
        assert_eq!(strip_bearer("bearer abc123").as_deref(), Some("abc123"));
        assert!(strip_bearer("Basic abc123").is_none());
        assert!(strip_bearer("Bearer ").is_none());
        assert!(strip_bearer("Bearer a b").is_none());
    }

    #[test]
    fn gate_allows_public_paths_without_session() {
        let outcome = evaluate_gate(
            "/api/channels/telegram/webhook",
            "POST",
            &BrowserRequestHeaders::default(),
            false,
            true,
            false,
            true,
            Some("token"),
            None,
            None,
            false,
        );
        assert_eq!(outcome.decision, GateDecision::Public);
    }

    #[test]
    fn gate_blocks_demo_mutations() {
        let outcome = evaluate_gate(
            "/api/logs",
            "DELETE",
            &BrowserRequestHeaders::default(),
            false,
            false,
            true,
            false,
            None,
            None,
            None,
            false,
        );
        assert_eq!(outcome.decision, GateDecision::DemoBlocked);
        assert_eq!(outcome.decision.rejection().unwrap().0, 403);
    }

    #[test]
    fn gate_falls_back_to_bearer() {
        let outcome = evaluate_gate(
            "/api/logs",
            "GET",
            &BrowserRequestHeaders::default(),
            false,
            true,
            false,
            true,
            Some("topsecret"),
            None,
            Some("Bearer wrong"),
            false,
        );
        assert_eq!(outcome.decision, GateDecision::UnauthorizedBadBearer);

        let outcome = evaluate_gate(
            "/api/logs",
            "GET",
            &BrowserRequestHeaders::default(),
            false,
            true,
            false,
            true,
            Some("topsecret"),
            None,
            Some("Bearer topsecret"),
            false,
        );
        assert_eq!(outcome.decision, GateDecision::Bearer);
    }

    #[test]
    fn gate_accepts_sse_query_token() {
        let outcome = evaluate_gate(
            "/api/events/stream",
            "GET",
            &BrowserRequestHeaders::default(),
            false,
            true,
            false,
            true,
            Some("topsecret"),
            Some("topsecret"),
            None,
            false,
        );
        assert_eq!(outcome.decision, GateDecision::EventsQueryToken);
    }

    #[test]
    fn gate_reports_no_token_when_unconfigured() {
        let outcome = evaluate_gate(
            "/api/logs",
            "GET",
            &browser("app.example.com"),
            false,
            true,
            false,
            false,
            None,
            None,
            None,
            false,
        );
        assert_eq!(outcome.decision, GateDecision::UnauthorizedNoToken);
    }

    #[test]
    fn gate_sets_demo_header_for_non_api_paths() {
        let outcome = evaluate_gate(
            "/",
            "GET",
            &browser("localhost:3000"),
            true,
            false,
            true,
            false,
            None,
            None,
            None,
            false,
        );
        assert_eq!(outcome.decision, GateDecision::NotApiPath);
        assert!(outcome.set_demo_mode_header);
    }
}
