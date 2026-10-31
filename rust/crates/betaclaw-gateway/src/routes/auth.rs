//! Native `/api/auth/*` route family replacing `next-auth@4.24.15` in the Node runtime.
//!
//! Handles:
//! - `GET  /api/auth/providers`
//! - `GET  /api/auth/csrf`
//! - `POST /api/auth/callback/credentials`
//! - `GET  /api/auth/session`
//! - `POST /api/auth/signout`
//! - `GET  /api/auth/signin` & `GET /api/auth/signin/credentials`
//! - `GET  /api/auth/error`

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use betaclaw_core::auth::{
    chunk_cookie_value, create_csrf_token, csrf_cookie_name, decode_session_from_cookies,
    encode_session_token, session_cookie_name, use_secure_cookies, verify_csrf_token,
};
use serde_json::json;

use crate::state::{AppState, SharedState};

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/auth/providers", get(get_providers))
        .route("/api/auth/csrf", get(get_csrf))
        .route("/api/auth/callback/credentials", post(callback_credentials))
        .route("/api/auth/session", get(get_session))
        .route("/api/auth/signout", post(post_signout))
        .route("/api/auth/signin", get(get_signin))
        .route("/api/auth/signin/credentials", get(get_signin))
        .route("/api/auth/error", get(get_error))
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        if bytes[index] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn extract_cookies(headers: &HeaderMap) -> Vec<(&str, &str)> {
    let mut result = Vec::new();
    for value in headers.get_all(header::COOKIE) {
        if let Ok(s) = value.to_str() {
            for pair in s.split(';') {
                if let Some((k, v)) = pair.trim().split_once('=') {
                    result.push((k.trim(), v.trim()));
                }
            }
        }
    }
    result
}

fn extract_cookie(cookies: &[(&str, &str)], name: &str) -> Option<String> {
    cookies.iter().find(|(k, _)| *k == name).map(|(_, v)| {
        if v.contains('%') {
            percent_decode(v)
        } else {
            v.to_string()
        }
    })
}

fn resolve_base_url(state: &AppState, headers: &HeaderMap) -> String {
    if !state.config.nextauth_url.is_empty() {
        return state.config.nextauth_url.trim_end_matches('/').to_string();
    }
    let is_https = use_secure_cookies(&state.config.nextauth_url);
    let proto = if is_https { "https" } else { "http" };
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1:3000");
    format!("{proto}://{host}")
}

fn resolve_client_ip(headers: &HeaderMap) -> Option<String> {
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            let trimmed = first.trim();
            if !trimmed.is_empty() && trimmed.len() <= 64 {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

pub fn sanitize_callback_url(raw: Option<&str>, base_url: &str) -> String {
    let Some(url) = raw else {
        return format!("{base_url}/");
    };
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return format!("{base_url}/");
    }
    if trimmed.starts_with('/') && !trimmed.starts_with("//") && !trimmed.starts_with("/\\") {
        return format!("{base_url}{}", encode_unsafe_url_bytes(trimmed));
    }
    if let Ok(parsed) = url::Url::parse(trimmed) {
        if let Ok(base_parsed) = url::Url::parse(base_url) {
            if parsed.origin() == base_parsed.origin() {
                return parsed.to_string();
            }
        }
    }
    format!("{base_url}/")
}

/// Percent-encodes controls, space, DEL and non-ASCII bytes, as the WHATWG URL
/// serialiser behind next-auth's `new URL(callbackUrl, baseUrl)` does. Without
/// it a relative callback such as `/ä` cannot become a `Location` header value.
fn encode_unsafe_url_bytes(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if (0x21..0x7f).contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[derive(Default)]
struct AuthParams {
    csrf_token: Option<String>,
    email: Option<String>,
    password: Option<String>,
    callback_url: Option<String>,
    is_json: bool,
}

fn parse_auth_params(bytes: &[u8], headers: &HeaderMap) -> AuthParams {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let mut params = AuthParams::default();

    if content_type.contains("application/json") {
        if let Ok(val) = serde_json::from_slice::<serde_json::Value>(bytes) {
            params.csrf_token = val
                .get("csrfToken")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            params.email = val
                .get("email")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            params.password = val
                .get("password")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            params.callback_url = val
                .get("callbackUrl")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            params.is_json = val.get("json").and_then(|v| v.as_bool()).unwrap_or(false)
                || val.get("json").and_then(|v| v.as_str()) == Some("true");
        }
    } else {
        // Form urlencoded fallback
        if let Ok(form) = serde_urlencoded::from_bytes::<HashMap<String, String>>(bytes) {
            params.csrf_token = form.get("csrfToken").cloned();
            params.email = form.get("email").cloned();
            params.password = form.get("password").cloned();
            params.callback_url = form.get("callbackUrl").cloned();
            params.is_json = form.get("json").map(|s| s == "true").unwrap_or(false);
        }
    }

    params
}

async fn get_providers(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let base_url = resolve_base_url(&state, &headers);
    let body = json!({
        "credentials": {
            "id": "credentials",
            "name": "Local Credentials",
            "type": "credentials",
            "signinUrl": format!("{base_url}/api/auth/signin/credentials"),
            "callbackUrl": format!("{base_url}/api/auth/callback/credentials")
        }
    });

    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    Ok((StatusCode::OK, resp_headers, Json(body)).into_response())
}

async fn get_csrf(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let use_secure = use_secure_cookies(&state.config.nextauth_url);
    let cookie_name = csrf_cookie_name(use_secure);
    let cookies = extract_cookies(&headers);
    let existing_cookie = extract_cookie(&cookies, cookie_name);

    let (token, cookie_val) =
        create_csrf_token(&state.config.auth_secret, existing_cookie.as_deref());

    let secure_flag = if use_secure { "; Secure" } else { "" };
    let cookie_header =
        format!("{cookie_name}={cookie_val}; Path=/; HttpOnly; SameSite=Lax{secure_flag}");

    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    resp_headers.insert(
        header::CACHE_CONTROL,
        "private, no-cache, no-store".parse().unwrap(),
    );
    resp_headers.insert(header::PRAGMA, "no-cache".parse().unwrap());
    resp_headers.insert(header::EXPIRES, "0".parse().unwrap());
    resp_headers.append(header::SET_COOKIE, cookie_header.parse().unwrap());

    Ok((
        StatusCode::OK,
        resp_headers,
        Json(json!({ "csrfToken": token })),
    )
        .into_response())
}

async fn callback_credentials(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Response {
    let base_url = resolve_base_url(&state, &headers);
    let params = parse_auth_params(&body_bytes, &headers);
    let use_secure = use_secure_cookies(&state.config.nextauth_url);
    let csrf_name = csrf_cookie_name(use_secure);
    let cookies = extract_cookies(&headers);
    let cookie_csrf = extract_cookie(&cookies, csrf_name);

    // 1. Verify CSRF
    if !verify_csrf_token(
        &state.config.auth_secret,
        cookie_csrf.as_deref(),
        params.csrf_token.as_deref(),
    ) {
        let signin_url = format!("{base_url}/api/auth/signin?csrf=true");
        return if params.is_json {
            let mut h = HeaderMap::new();
            h.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
            (StatusCode::OK, h, Json(json!({ "url": signin_url }))).into_response()
        } else {
            let mut h = HeaderMap::new();
            h.insert(header::LOCATION, signin_url.parse().unwrap());
            (StatusCode::FOUND, h, ()).into_response()
        };
    }

    // 2. Rate limit and credentials verification
    let email = params
        .email
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let password = params.password.as_deref().unwrap_or("");
    let ip = resolve_client_ip(&headers);
    let email_key = format!("email:{}", email.chars().take(254).collect::<String>());
    let ip_key = ip.map(|ip_str| format!("ip:{ip_str}"));

    let is_blocked = {
        let mut limiter = state.login_limiter.lock().await;
        limiter.is_blocked(&email_key)
            || ip_key.as_deref().is_some_and(|key| limiter.is_blocked(key))
    };

    let has_empty_credentials = email.is_empty() || password.is_empty();

    let auth_user = if is_blocked || has_empty_credentials {
        None
    } else {
        let mut store = state.auth_users.lock().await;
        store.verify_credentials(&email, password).unwrap_or(None)
    };

    if auth_user.is_none() {
        if !is_blocked && !has_empty_credentials {
            let mut limiter = state.login_limiter.lock().await;
            limiter.record_failure(&email_key);
            if let Some(ref k) = ip_key {
                limiter.record_failure(k);
            }
        }
        let error_url =
            format!("{base_url}/api/auth/error?error=CredentialsSignin&provider=credentials");
        return if params.is_json {
            let mut h = HeaderMap::new();
            h.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
            (
                StatusCode::UNAUTHORIZED,
                h,
                Json(json!({ "url": error_url })),
            )
                .into_response()
        } else {
            let mut h = HeaderMap::new();
            h.insert(header::LOCATION, error_url.parse().unwrap());
            (StatusCode::FOUND, h, ()).into_response()
        };
    }

    let user = auth_user.unwrap();
    {
        let mut limiter = state.login_limiter.lock().await;
        limiter.reset(&email_key);
    }

    // 3. Issue session JWE
    let now = chrono::Utc::now().timestamp();
    let max_age = 30 * 24 * 60 * 60; // 30 days
    let exp = now + max_age;
    let payload = json!({
        "name": user.name,
        "email": user.email,
        "sub": user.id,
        "id": user.id,
        "iat": now,
        "exp": exp,
        "jti": uuid::Uuid::new_v4().to_string(),
    });

    let token = match encode_session_token(&state.config.auth_secret, &payload.to_string()) {
        Ok(t) => t,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let session_name = session_cookie_name(use_secure);
    let chunks = chunk_cookie_value(&token);
    let secure_flag = if use_secure { "; Secure" } else { "" };
    let expires_http = chrono::DateTime::from_timestamp(exp, 0)
        .unwrap_or_default()
        .format("%a, %d %b %Y %H:%M:%S GMT");

    let mut resp_headers = HeaderMap::new();
    if chunks.len() == 1 {
        let cookie_val = format!(
            "{session_name}={}; Path=/; HttpOnly; SameSite=Lax; Expires={expires_http}; Max-Age={max_age}{secure_flag}",
            chunks[0]
        );
        resp_headers.append(header::SET_COOKIE, cookie_val.parse().unwrap());
    } else {
        for (i, chunk) in chunks.iter().enumerate() {
            let cookie_val = format!(
                "{session_name}.{i}={chunk}; Path=/; HttpOnly; SameSite=Lax; Expires={expires_http}; Max-Age={max_age}{secure_flag}"
            );
            resp_headers.append(header::SET_COOKIE, cookie_val.parse().unwrap());
        }
    }

    let target_url = sanitize_callback_url(params.callback_url.as_deref(), &base_url);

    if params.is_json {
        resp_headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        (
            StatusCode::OK,
            resp_headers,
            Json(json!({ "url": target_url })),
        )
            .into_response()
    } else {
        resp_headers.insert(header::LOCATION, target_url.parse().unwrap());
        (StatusCode::FOUND, resp_headers, ()).into_response()
    }
}

async fn get_session(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let use_secure = use_secure_cookies(&state.config.nextauth_url);
    let session_name = session_cookie_name(use_secure);
    let cookies = extract_cookies(&headers);
    let now = chrono::Utc::now().timestamp();

    let candidate_names = vec![session_name.to_string()];
    let decoded = decode_session_from_cookies(
        cookies.iter().map(|(k, v)| (*k, *v)),
        &candidate_names,
        &state.config.auth_secret,
        now,
    );

    let Ok(session) = decoded else {
        let mut resp_headers = HeaderMap::new();
        resp_headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        resp_headers.insert(
            header::CACHE_CONTROL,
            "private, no-cache, no-store".parse().unwrap(),
        );

        for (name, _) in cookies.iter().filter(|(name, _)| {
            *name == session_name
                || name
                    .strip_prefix(session_name)
                    .is_some_and(|suffix| suffix.starts_with('.'))
        }) {
            let secure_flag = if use_secure { "; Secure" } else { "" };
            let clear_cookie = format!(
                "{name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax{secure_flag}"
            );
            resp_headers.append(header::SET_COOKIE, clear_cookie.parse().unwrap());
        }

        return Ok((StatusCode::OK, resp_headers, Json(json!({}))).into_response());
    };

    // Rolling session: re-issue cookie with fresh 30-day expiry
    let max_age = 30 * 24 * 60 * 60;
    let new_exp = now + max_age;
    let payload = json!({
        "name": session.name,
        "email": session.email,
        "sub": session.user_id,
        "id": session.user_id,
        "iat": now,
        "exp": new_exp,
        "jti": uuid::Uuid::new_v4().to_string(),
    });

    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    resp_headers.insert(
        header::CACHE_CONTROL,
        "private, no-cache, no-store".parse().unwrap(),
    );

    let expires_http = chrono::DateTime::from_timestamp(new_exp, 0)
        .unwrap_or_default()
        .format("%a, %d %b %Y %H:%M:%S GMT");

    if let Ok(new_token) = encode_session_token(&state.config.auth_secret, &payload.to_string()) {
        let chunks = chunk_cookie_value(&new_token);
        let secure_flag = if use_secure { "; Secure" } else { "" };
        if chunks.len() == 1 {
            let cookie_val = format!(
                "{session_name}={}; Path=/; HttpOnly; SameSite=Lax; Expires={expires_http}; Max-Age={max_age}{secure_flag}",
                chunks[0]
            );
            resp_headers.append(header::SET_COOKIE, cookie_val.parse().unwrap());
        } else {
            for (i, chunk) in chunks.iter().enumerate() {
                let cookie_val = format!(
                    "{session_name}.{i}={chunk}; Path=/; HttpOnly; SameSite=Lax; Expires={expires_http}; Max-Age={max_age}{secure_flag}"
                );
                resp_headers.append(header::SET_COOKIE, cookie_val.parse().unwrap());
            }
        }
    }

    let expires_dt = chrono::DateTime::from_timestamp(new_exp, 0).unwrap_or_default();
    let body = json!({
        "user": {
            "name": session.name,
            "email": session.email,
            "id": session.user_id
        },
        "expires": expires_dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    });

    Ok((StatusCode::OK, resp_headers, Json(body)).into_response())
}

async fn post_signout(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Response {
    let base_url = resolve_base_url(&state, &headers);
    let params = parse_auth_params(&body_bytes, &headers);
    let use_secure = use_secure_cookies(&state.config.nextauth_url);
    let csrf_name = csrf_cookie_name(use_secure);
    let cookies = extract_cookies(&headers);
    let cookie_csrf = extract_cookie(&cookies, csrf_name);

    if !verify_csrf_token(
        &state.config.auth_secret,
        cookie_csrf.as_deref(),
        params.csrf_token.as_deref(),
    ) {
        let error_url = format!("{base_url}/api/auth/signin?csrf=true");
        return if params.is_json {
            let mut h = HeaderMap::new();
            h.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
            (StatusCode::OK, h, Json(json!({ "url": error_url }))).into_response()
        } else {
            let mut h = HeaderMap::new();
            h.insert(header::LOCATION, error_url.parse().unwrap());
            (StatusCode::FOUND, h, ()).into_response()
        };
    }

    let session_name = session_cookie_name(use_secure);
    let secure_flag = if use_secure { "; Secure" } else { "" };

    let mut resp_headers = HeaderMap::new();
    // Clean main session cookie and chunk cookies
    let clean_cookie = format!(
        "{session_name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax{secure_flag}"
    );
    resp_headers.append(header::SET_COOKIE, clean_cookie.parse().unwrap());
    for name in cookies.iter().map(|(name, _)| name).filter(|name| {
        name.strip_prefix(&format!("{session_name}."))
            .is_some_and(|index| index.parse::<usize>().is_ok())
    }) {
        let clean_chunk = format!(
            "{name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax{secure_flag}"
        );
        resp_headers.append(header::SET_COOKIE, clean_chunk.parse().unwrap());
    }

    let target_url = sanitize_callback_url(params.callback_url.as_deref(), &base_url);

    if params.is_json {
        resp_headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        (
            StatusCode::OK,
            resp_headers,
            Json(json!({ "url": target_url })),
        )
            .into_response()
    } else {
        resp_headers.insert(header::LOCATION, target_url.parse().unwrap());
        (StatusCode::FOUND, resp_headers, ()).into_response()
    }
}

async fn get_signin(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let base_url = resolve_base_url(&state, &headers);
    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(
        header::LOCATION,
        format!("{base_url}/login").parse().unwrap(),
    );
    Ok((StatusCode::FOUND, resp_headers, ()).into_response())
}

async fn get_error(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let base_url = resolve_base_url(&state, &headers);
    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(
        header::LOCATION,
        format!("{base_url}/login").parse().unwrap(),
    );
    Ok((StatusCode::FOUND, resp_headers, ()).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> SharedState {
        let mut config = betaclaw_core::config::GatewayConfig::from_env().unwrap();
        config.logs_db_path = ":memory:".into();
        config.messages_db_path = ":memory:".into();
        config.personas_db_path = ":memory:".into();
        config.nextauth_url = "http://localhost:3000".into();
        let mut state = AppState::new(config).unwrap();
        state.auth_users = tokio::sync::Mutex::new(
            betaclaw_core::auth::AuthUserStore::open(
                ":memory:",
                &betaclaw_core::auth::user_store::BootstrapConfig {
                    default_email: "login@example.invalid".into(),
                    default_password: "isolated-test-password".into(),
                    default_name: "Test".into(),
                    node_env: "test".into(),
                },
            )
            .unwrap(),
        );
        std::sync::Arc::new(state)
    }

    #[tokio::test]
    async fn empty_attempts_do_not_count_and_ten_failures_block_correct_credentials() {
        let state = test_state();
        let (token, cookie) = create_csrf_token(&state.config.auth_secret, None);
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        headers.insert(
            header::COOKIE,
            format!("next-auth.csrf-token={}", cookie.replace('|', "%7C"))
                .parse()
                .unwrap(),
        );
        for _ in 0..12 {
            let body = Bytes::from(json!({"email":"login@example.invalid","password":"","csrfToken":token,"json":"true"}).to_string());
            assert_eq!(
                callback_credentials(State(state.clone()), headers.clone(), body)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert!(state.login_limiter.lock().await.is_empty());
        for _ in 0..10 {
            let body = Bytes::from(json!({"email":"login@example.invalid","password":"wrong","csrfToken":token,"json":true}).to_string());
            assert_eq!(
                callback_credentials(State(state.clone()), headers.clone(), body)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert!(state
            .login_limiter
            .lock()
            .await
            .is_blocked("email:login@example.invalid"));
        let body = Bytes::from(json!({"email":"login@example.invalid","password":"isolated-test-password","csrfToken":token,"json":true}).to_string());
        assert_eq!(
            callback_credentials(State(state), headers, body)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn forwarded_proto_cannot_change_cookie_security_and_invalid_chunks_are_cleared() {
        let state = test_state();
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        let response = get_csrf(State(state.clone()), headers).await.unwrap();
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.starts_with("next-auth.csrf-token="));
        assert!(!cookie.contains("; Secure"));
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-cache, no-store"
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "next-auth.session-token.0=bad; next-auth.session-token.1=bad"
                .parse()
                .unwrap(),
        );
        let response = get_session(State(state), headers).await.unwrap();
        let removed = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|c| c.to_str().unwrap())
            .collect::<Vec<_>>();
        assert!(removed
            .iter()
            .any(|c| c.starts_with("next-auth.session-token.0=;")));
        assert!(removed
            .iter()
            .any(|c| c.starts_with("next-auth.session-token.1=;")));
    }

    #[tokio::test]
    async fn signout_clears_all_received_session_chunks() {
        let state = test_state();
        let (token, cookie) = create_csrf_token(&state.config.auth_secret, None);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("next-auth.csrf-token={cookie}; next-auth.session-token.8=part")
                .parse()
                .unwrap(),
        );
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let response = post_signout(
            State(state),
            headers,
            Bytes::from(json!({"csrfToken":token,"json":true}).to_string()),
        )
        .await;
        assert!(response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .any(|value| value
                .to_str()
                .unwrap()
                .starts_with("next-auth.session-token.8=;")));
    }

    #[test]
    fn test_sanitize_callback_url() {
        let base = "http://127.0.0.1:3000";

        // Valid relative paths
        assert_eq!(
            sanitize_callback_url(Some("/settings"), base),
            "http://127.0.0.1:3000/settings"
        );
        assert_eq!(
            sanitize_callback_url(Some("/chat?id=123"), base),
            "http://127.0.0.1:3000/chat?id=123"
        );

        // Bytes a header value cannot carry are percent-encoded, so the
        // result always parses as a `Location` value instead of panicking.
        let encoded = sanitize_callback_url(Some("/chat/ä b\u{7f}"), base);
        assert_eq!(encoded, "http://127.0.0.1:3000/chat/%C3%A4%20b%7F");
        assert!(encoded.parse::<axum::http::HeaderValue>().is_ok());

        // Valid absolute URL with identical origin
        assert_eq!(
            sanitize_callback_url(Some("http://127.0.0.1:3000/settings"), base),
            "http://127.0.0.1:3000/settings"
        );

        // Open redirect attacks
        assert_eq!(
            sanitize_callback_url(Some("http://127.0.0.1:3000.evil.com/"), base),
            "http://127.0.0.1:3000/"
        );
        assert_eq!(
            sanitize_callback_url(Some("http://127.0.0.1:3000@evil.com/"), base),
            "http://127.0.0.1:3000/"
        );
        assert_eq!(
            sanitize_callback_url(Some("//evil.com"), base),
            "http://127.0.0.1:3000/"
        );
        assert_eq!(
            sanitize_callback_url(Some("/\\evil.com"), base),
            "http://127.0.0.1:3000/"
        );
        assert_eq!(
            sanitize_callback_url(Some("javascript:alert(1)"), base),
            "http://127.0.0.1:3000/"
        );
        assert_eq!(
            sanitize_callback_url(Some("https://attacker.com/steal"), base),
            "http://127.0.0.1:3000/"
        );
        assert_eq!(sanitize_callback_url(None, base), "http://127.0.0.1:3000/");
        assert_eq!(
            sanitize_callback_url(Some(""), base),
            "http://127.0.0.1:3000/"
        );
    }

    #[test]
    fn test_cookie_name_security() {
        assert!(!use_secure_cookies("http://localhost:3000"));
        assert!(!use_secure_cookies("http://127.0.0.1:3000"));
        assert_eq!(csrf_cookie_name(false), "next-auth.csrf-token");
        assert_eq!(session_cookie_name(false), "next-auth.session-token");

        assert!(use_secure_cookies("https://example.com"));
        assert_eq!(csrf_cookie_name(true), "__Host-next-auth.csrf-token");
        assert_eq!(
            session_cookie_name(true),
            "__Secure-next-auth.session-token"
        );
    }

    #[test]
    fn test_percent_decode() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("a%7Cb"), "a|b");
        assert_eq!(percent_decode("plain_token"), "plain_token");
    }
}
