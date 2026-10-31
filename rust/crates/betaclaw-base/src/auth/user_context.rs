//! Per-request user resolution.
//!
//! Port of `resolveRequestUserContext()` in `src/server/auth/userContext.ts`.
//! The resolution order is load-bearing: an internal service token outranks the
//! API bearer, which outranks the browser session, which outranks the anonymous
//! local principal.

use crate::auth::jwe::{decode_session_from_cookies, DecodedSession, JweError};
use crate::auth::policy::{constant_time_eq, strip_bearer};
use crate::auth::principal::get_principal_user_id;

/// Resolved identity for a single request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserContext {
    pub user_id: String,
    pub authenticated: bool,
    /// True when the caller presented a service token rather than a user session.
    pub service: bool,
}

/// Everything the resolver needs from the transport layer.
pub struct RequestAuthInput<'a> {
    /// Parsed `Cookie` header as name/value pairs.
    pub cookies: &'a [(String, String)],
    pub authorization: Option<&'a str>,
    pub internal_token_header: Option<&'a str>,
    /// Candidate session cookie names, in priority order.
    pub session_cookie_names: &'a [String],
    pub auth_secret: &'a str,
    pub mc_api_token: Option<&'a str>,
    pub internal_token: &'a str,
    pub require_auth: bool,
    pub now_seconds: i64,
}

/// Resolves the caller identity, or `None` when the request must be rejected.
///
/// The caller is responsible for having run the origin policy gate first; this
/// function only answers "who is this".
pub fn resolve_request_user_context(input: &RequestAuthInput<'_>) -> Option<UserContext> {
    if has_valid_api_token(input) || has_valid_internal_token(input) {
        return Some(UserContext {
            user_id: get_principal_user_id(),
            authenticated: true,
            service: true,
        });
    }

    if input.require_auth {
        // A session is mandatory; without one there is no identity.
        return decode_session(input).map(session_context);
    }

    match decode_session(input) {
        Some(session) => Some(session_context(session)),
        None => Some(UserContext {
            user_id: get_principal_user_id(),
            authenticated: false,
            service: false,
        }),
    }
}

fn session_context(session: DecodedSession) -> UserContext {
    UserContext {
        user_id: session.user_id,
        authenticated: true,
        service: false,
    }
}

fn has_valid_api_token(input: &RequestAuthInput<'_>) -> bool {
    let Some(configured) = input
        .mc_api_token
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let Some(authorization) = input.authorization else {
        return false;
    };
    let Some(provided) = strip_bearer(authorization) else {
        return false;
    };
    constant_time_eq(provided.as_bytes(), configured.as_bytes())
}

/// Internal service token, compared against the per-process value from
/// `src/server/auth/internalRequest.ts`.
fn has_valid_internal_token(input: &RequestAuthInput<'_>) -> bool {
    let Some(provided) = input.internal_token_header else {
        return false;
    };
    if provided.is_empty() || input.internal_token.is_empty() {
        return false;
    }
    constant_time_eq(provided.as_bytes(), input.internal_token.as_bytes())
}

fn decode_session(input: &RequestAuthInput<'_>) -> Option<DecodedSession> {
    if input.cookies.is_empty() {
        return None;
    }
    decode_session_from_cookies(
        input
            .cookies
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
        input.session_cookie_names,
        input.auth_secret,
        input.now_seconds,
    )
    .ok()
}

/// True when the session cookie exists but could not be validated.
///
/// The WebSocket upgrade distinguishes "no cookie" from "bad cookie" only for its
/// log line; both end in a 401.
pub fn session_error_hint(input: &RequestAuthInput<'_>) -> Option<&'static str> {
    if input.cookies.is_empty() {
        return None;
    }
    match decode_session_from_cookies(
        input
            .cookies
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
        input.session_cookie_names,
        input.auth_secret,
        input.now_seconds,
    ) {
        Ok(_) => None,
        Err(JweError::Missing) => None,
        Err(_) => Some("present-but-invalid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::jwe::test_support::issue_token;

    const SECRET: &str = "unit-test-secret";
    const COOKIE: &str = "next-auth.session-token";

    static COOKIE_NAMES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

    fn cookie_names() -> &'static [String] {
        COOKIE_NAMES.get_or_init(|| vec![COOKIE.to_string()])
    }

    fn input<'a>(
        cookies: &'a [(String, String)],
        authorization: Option<&'a str>,
        require_auth: bool,
    ) -> RequestAuthInput<'a> {
        RequestAuthInput {
            cookies,
            authorization,
            internal_token_header: None,
            session_cookie_names: cookie_names(),
            auth_secret: SECRET,
            mc_api_token: Some("api-token"),
            internal_token: "internal-token",
            require_auth,
            now_seconds: 1_700_000_000,
        }
    }

    #[test]
    fn api_token_yields_service_principal() {
        let resolved = resolve_request_user_context(&input(&[], Some("Bearer api-token"), true));
        let context = resolved.unwrap();
        assert!(context.service);
        assert!(context.authenticated);
    }

    #[test]
    fn internal_token_yields_service_principal() {
        let cookies: Vec<(String, String)> = Vec::new();
        let mut req = input(&cookies, None, true);
        req.internal_token_header = Some("internal-token");
        let context = resolve_request_user_context(&req).unwrap();
        assert!(context.service);
    }

    #[test]
    fn session_cookie_resolves_user_id() {
        let token = issue_token(SECRET, COOKIE, r#"{"id":"usr-42","exp":4102444800}"#);
        let cookies = vec![(COOKIE.to_string(), token)];
        let context = resolve_request_user_context(&input(&cookies, None, true)).unwrap();
        assert_eq!(context.user_id, "usr-42");
        assert!(context.authenticated);
        assert!(!context.service);
    }

    #[test]
    fn require_auth_rejects_anonymous() {
        assert!(resolve_request_user_context(&input(&[], None, true)).is_none());
    }

    #[test]
    fn anonymous_principal_when_auth_not_required() {
        let context = resolve_request_user_context(&input(&[], None, false)).unwrap();
        assert!(!context.authenticated);
        assert!(!context.service);
    }

    #[test]
    fn invalid_session_with_auth_required_is_rejected() {
        let cookies = vec![(COOKIE.to_string(), "garbage".to_string())];
        assert!(resolve_request_user_context(&input(&cookies, None, true)).is_none());
    }
}
