//! Port of `src/server/model-hub/codexAuth.ts` (1-208).
//!
//! The module owns the OpenAI Codex OAuth client: the public app id and endpoint
//! constants (`codexAuth.ts:6-11`), the CLI credential reader (keychain on macOS,
//! `~/.codex/auth.json` otherwise; `codexAuth.ts:126-130`), the JWT helpers
//! (`codexAuth.ts:132-161`) and the token refresh (`codexAuth.ts:167-208`).
//!
//! It closes OP-12: `service/provider/refresh.ts` used an `Err` no-op for the
//! refresh, and that seam is now backed by [`refresh_open_ai_codex_token`].
//!
//! # Deviations
//!
//! - `execSync('security find-generic-password …')` (`codexAuth.ts:100`) is a
//!   macOS-only shell-out; [`read_codex_from_keychain`] therefore only runs on
//!   `target_os = "macos"` and reports `None` everywhere else, exactly like the
//!   `process.platform !== 'darwin'` guard (`codexAuth.ts:94`).
//! - `Buffer.from(payload, 'base64url')` is lenient; the port reuses
//!   [`crate::model_hub::oauth::from_base64_url`], which returns an empty buffer
//!   for a value it cannot decode. A malformed JWT then reads as "no claim",
//!   which is what the TypeScript `catch` (`codexAuth.ts:141-143`) produces.
//! - `Date.now()` is passed in for [`refresh_open_ai_codex_token`] and
//!   [`is_jwt_expiring_soon_at`] so a test can pin the clock.

use std::path::PathBuf;

use http::header;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::model_hub::env::EnvOverrides;
use crate::model_hub::http::{HttpRequest, HttpTransport};
use crate::model_hub::oauth::from_base64_url;

/// `OPENAI_CODEX_PUBLIC_CLIENT_ID` from `codexAuth.ts:6`.
pub const OPENAI_CODEX_PUBLIC_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
/// `OPENAI_CODEX_AUTHORIZE_URL` from `codexAuth.ts:7`.
pub const OPENAI_CODEX_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
/// `OPENAI_CODEX_TOKEN_URL` from `codexAuth.ts:8`.
pub const OPENAI_CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// `OPENAI_CODEX_SCOPE` from `codexAuth.ts:9`.
pub const OPENAI_CODEX_SCOPE: &str = "openid profile email offline_access";
/// `OPENAI_CODEX_LOCAL_REDIRECT_URI` from `codexAuth.ts:10`.
pub const OPENAI_CODEX_LOCAL_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
/// `OPENAI_CODEX_AUTH_CLAIM_PATH` from `codexAuth.ts:11`.
pub const OPENAI_CODEX_AUTH_CLAIM_PATH: &str = "https://api.openai.com/auth";
/// The `chatgpt_account_id` member of that claim (`codexAuth.ts:151`).
pub const OPENAI_CODEX_AUTH_CLAIM_ID: &str = "chatgpt_account_id";
/// The default expiry buffer of `isJwtExpiringSoon` (`codexAuth.ts:155`).
pub const DEFAULT_EXPIRY_BUFFER_SECONDS: i64 = 90;

/// `CodexCliCredentials['source']` from `codexAuth.ts:27`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexCredentialSource {
    /// `'keychain'`.
    Keychain,
    /// `'auth_file'`.
    AuthFile,
}

impl CodexCredentialSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexCredentialSource::Keychain => "keychain",
            CodexCredentialSource::AuthFile => "auth_file",
        }
    }
}

/// `CodexCliCredentials` from `codexAuth.ts:23-28`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexCliCredentials {
    pub access_token: String,
    pub refresh_token: String,
    pub account_id: Option<String>,
    pub source: CodexCredentialSource,
}

/// `OpenAICodexRefreshResult` from `codexAuth.ts:30-35`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAICodexRefreshResult {
    pub access_token: String,
    pub refresh_token: String,
    /// `expiresAt` in milliseconds, absent when `expires_in` was not usable.
    pub expires_at: Option<i64>,
    pub account_id: Option<String>,
}

/// Failure of [`refresh_open_ai_codex_token`].
///
/// `codexAuth.ts:189,194` throw a plain `Error` whose message the caller
/// (`provider/refresh.ts:39-41`) swallows; the port keeps the message text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodexAuthError {
    /// A non-2xx response or a missing `access_token`.
    #[error("{0}")]
    Refresh(String),
    /// The HTTP client itself failed.
    #[error("{0}")]
    Transport(String),
}

/// `toStringOrEmpty` from `codexAuth.ts:37-39`.
fn to_string_or_empty(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

/// `resolveHomeDirFromEnv` from `codexAuth.ts:41-44`.
///
/// `HOME` wins, then `USERPROFILE`; the result is made absolute, mirroring
/// `path.resolve`.
fn resolve_home_dir_from_env(env: &EnvOverrides) -> String {
    let from_home = env.get("HOME").map(|value| value.trim().to_string());
    let home = match from_home {
        Some(value) if !value.is_empty() => value,
        _ => env
            .get("USERPROFILE")
            .map(|value| value.trim().to_string())
            .unwrap_or_default(),
    };
    if home.is_empty() {
        return String::new();
    }
    match std::path::absolute(&home) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(_) => home,
    }
}

/// `resolveCodexHomePath` from `codexAuth.ts:46-56`.
///
/// `CODEX_HOME` wins outright; otherwise `~/.codex`. The path is canonicalised
/// when it exists (`fs.realpathSync.native`), else returned unchanged.
pub fn resolve_codex_home_path(env: &EnvOverrides) -> String {
    let configured = env
        .get("CODEX_HOME")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let home_root = match &configured {
        Some(value) => value.clone(),
        None => resolve_home_dir_from_env(env),
    };
    if home_root.is_empty() {
        return String::new();
    }
    let home = if configured.is_some() {
        home_root
    } else {
        PathBuf::from(&home_root)
            .join(".codex")
            .to_string_lossy()
            .into_owned()
    };
    std::fs::canonicalize(&home)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or(home)
}

/// `resolveCodexAuthFilePath` from `codexAuth.ts:58-62`.
pub fn resolve_codex_auth_file_path(env: &EnvOverrides) -> Option<String> {
    let codex_home = resolve_codex_home_path(env);
    if codex_home.is_empty() {
        return None;
    }
    Some(
        PathBuf::from(codex_home)
            .join("auth.json")
            .to_string_lossy()
            .into_owned(),
    )
}

/// `computeCodexKeychainAccount` from `codexAuth.ts:64-67`.
pub fn compute_codex_keychain_account(codex_home_path: &str) -> String {
    let hash = Sha256::digest(codex_home_path.as_bytes());
    let hex: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("cli|{}", &hex[..16])
}

/// `parseAuthPayload` from `codexAuth.ts:74-91`.
///
/// `tokens.access_token` and `tokens.refresh_token` must both be non-empty, and
/// the account id falls back to the JWT claim. `source` is always `'auth_file'`,
/// because only the auth-file reader uses this helper.
fn parse_auth_payload(raw: &Value) -> Option<CodexCliCredentials> {
    let tokens = raw.get("tokens")?.as_object()?;
    let access_token = to_string_or_empty(tokens.get("access_token"));
    let refresh_token = to_string_or_empty(tokens.get("refresh_token"));
    if access_token.is_empty() || refresh_token.is_empty() {
        return None;
    }
    let account_id = {
        let explicit = to_string_or_empty(tokens.get("account_id"));
        if explicit.is_empty() {
            extract_codex_account_id(&access_token)
        } else {
            Some(explicit)
        }
    };
    Some(CodexCliCredentials {
        access_token,
        refresh_token,
        account_id,
        source: CodexCredentialSource::AuthFile,
    })
}

/// `readCodexFromAuthFile` from `codexAuth.ts:114-124`.
pub fn read_codex_from_auth_file(env: &EnvOverrides) -> Option<CodexCliCredentials> {
    let auth_path = resolve_codex_auth_file_path(env)?;
    let raw = std::fs::read_to_string(&auth_path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parse_auth_payload(&parsed)
}

/// `readCodexFromKeychain` from `codexAuth.ts:93-112`.
///
/// Only the `darwin` branch exists in TypeScript; every other platform returns
/// `None` before touching the shell.
pub fn read_codex_from_keychain(env: &EnvOverrides) -> Option<CodexCliCredentials> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    read_codex_from_keychain_macos(env)
}

#[cfg(target_os = "macos")]
fn read_codex_from_keychain_macos(env: &EnvOverrides) -> Option<CodexCliCredentials> {
    let codex_home = resolve_codex_home_path(env);
    if codex_home.is_empty() {
        return None;
    }
    let account = compute_codex_keychain_account(&codex_home);
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Codex Auth",
            "-a",
            &account,
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let parsed: Value = serde_json::from_str(raw.trim()).ok()?;
    parse_auth_payload(&parsed).map(|mut credentials| {
        credentials.source = CodexCredentialSource::Keychain;
        credentials
    })
}

#[cfg(not(target_os = "macos"))]
fn read_codex_from_keychain_macos(_env: &EnvOverrides) -> Option<CodexCliCredentials> {
    None
}

/// `readCodexCliCredentials` from `codexAuth.ts:126-130`.
pub fn read_codex_cli_credentials(env: &EnvOverrides) -> Option<CodexCliCredentials> {
    read_codex_from_keychain(env).or_else(|| read_codex_from_auth_file(env))
}

/// `decodeJwtPayload` from `codexAuth.ts:132-144`.
///
/// The middle segment is base64url-decoded and parsed as JSON; anything that is
/// not a JSON object yields `None`, matching the `catch` branch.
pub fn decode_jwt_payload(token: &str) -> Option<Value> {
    let mut parts = token.split('.');
    let (Some(_header), Some(payload), Some(_signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    if payload.is_empty() {
        return None;
    }
    let decoded = String::from_utf8_lossy(&from_base64_url(payload)).into_owned();
    let parsed: Value = serde_json::from_str(&decoded).ok()?;
    parsed.is_object().then_some(parsed)
}

/// `extractCodexAccountId` from `codexAuth.ts:146-153`.
pub fn extract_codex_account_id(access_token: &str) -> Option<String> {
    let payload = decode_jwt_payload(access_token)?;
    let auth = payload.get(OPENAI_CODEX_AUTH_CLAIM_PATH)?;
    if !auth.is_object() {
        return None;
    }
    let account_id = auth
        .get(OPENAI_CODEX_AUTH_CLAIM_ID)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(account_id.to_string())
}

/// `isJwtExpiringSoon(token, bufferSeconds)` from `codexAuth.ts:155-161`, with the
/// clock injected.
///
/// A missing or non-numeric `exp` reports `false`, and the buffer is floored at
/// zero (`Math.max(0, bufferSeconds)`).
pub fn is_jwt_expiring_soon_at(token: &str, buffer_seconds: i64, now_sec: i64) -> bool {
    let Some(payload) = decode_jwt_payload(token) else {
        return false;
    };
    let Some(exp) = payload.get("exp").and_then(Value::as_f64) else {
        return false;
    };
    let threshold = now_sec as f64 + buffer_seconds.max(0) as f64;
    exp <= threshold
}

/// `isJwtExpiringSoon(token, bufferSeconds)` from `codexAuth.ts:155-161`.
pub fn is_jwt_expiring_soon(token: &str, buffer_seconds: i64) -> bool {
    is_jwt_expiring_soon_at(token, buffer_seconds, now_seconds())
}

/// `Math.floor(Date.now() / 1000)`.
pub fn now_seconds() -> i64 {
    crate::model_hub::oauth::now_ms() / 1000
}

/// `getOpenAICodexClientId` from `codexAuth.ts:163-165`.
pub fn get_open_ai_codex_client_id(env: &EnvOverrides) -> String {
    let configured = env
        .get("OPENAI_OAUTH_CLIENT_ID")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    configured.unwrap_or_else(|| OPENAI_CODEX_PUBLIC_CLIENT_ID.to_string())
}

/// `Number(json.expires_in)`: a JSON number or a numeric string, else `None`.
fn number_or_nan(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// The `application/x-www-form-urlencoded` serialiser `URLSearchParams.toString`
/// uses: alphanumerics and `*-._` stay, space becomes `+`, everything else is
/// percent-encoded per byte.
fn form_encode(pairs: &[(&str, &str)]) -> String {
    fn encode(value: &str) -> String {
        let mut out = String::new();
        for byte in value.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                    out.push(byte as char);
                }
                b' ' => out.push('+'),
                _ => out.push_str(&format!("%{byte:02X}")),
            }
        }
        out
    }
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// `refreshOpenAICodexToken(refreshToken)` from `codexAuth.ts:167-208`.
///
/// The token endpoint is reached through the injected [`HttpTransport`], and the
/// clock is passed in for the `expiresAt` arithmetic. `response.json()` failing
/// yields an empty object (`codexAuth.ts:183`), which is what the port does before
/// checking the status.
pub async fn refresh_open_ai_codex_token(
    transport: &dyn HttpTransport,
    refresh_token: &str,
    env: &EnvOverrides,
    now_ms: i64,
) -> Result<OpenAICodexRefreshResult, CodexAuthError> {
    let token_url = env
        .get("OPENAI_OAUTH_TOKEN_URL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| OPENAI_CODEX_TOKEN_URL.to_string());
    let client_id = get_open_ai_codex_client_id(env);
    let body = form_encode(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", &client_id),
    ]);

    let request = HttpRequest::post(token_url)
        .header(
            header::CONTENT_TYPE.as_str(),
            "application/x-www-form-urlencoded",
        )
        .body(body);

    let response = transport
        .send(request)
        .await
        .map_err(|error| CodexAuthError::Transport(error.to_string()))?;

    let json: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);

    if !response.is_ok() {
        let description = to_string_or_empty(json.get("error_description"));
        let details = if !description.is_empty() {
            description
        } else {
            let error = to_string_or_empty(json.get("error"));
            if !error.is_empty() {
                error
            } else {
                format!(
                    "OpenAI Codex token refresh failed ({}).",
                    response.status.as_u16()
                )
            }
        };
        return Err(CodexAuthError::Refresh(details));
    }

    let next_access_token = to_string_or_empty(json.get("access_token"));
    if next_access_token.is_empty() {
        return Err(CodexAuthError::Refresh(
            "OpenAI Codex token refresh response did not include access_token.".to_string(),
        ));
    }

    let next_refresh_token = {
        let refreshed = to_string_or_empty(json.get("refresh_token"));
        if refreshed.is_empty() {
            refresh_token.to_string()
        } else {
            refreshed
        }
    };

    let expires_at = number_or_nan(json.get("expires_in"))
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| now_ms + (value * 1000.0) as i64);

    Ok(OpenAICodexRefreshResult {
        account_id: extract_codex_account_id(&next_access_token),
        access_token: next_access_token,
        refresh_token: next_refresh_token,
        expires_at,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use http::{HeaderMap, StatusCode};
    use serde_json::json;

    use super::*;
    use crate::model_hub::http::{HttpError, HttpResponse};

    /// A capturing transport: it records every request and replays one response.
    struct StubTransport {
        response: Mutex<Option<HttpResponse>>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl StubTransport {
        fn new(response: HttpResponse) -> Self {
            Self {
                response: Mutex::new(Some(response)),
                seen: Mutex::new(Vec::new()),
            }
        }
    }

    impl HttpTransport for StubTransport {
        fn send<'a>(
            &'a self,
            request: HttpRequest,
        ) -> crate::model_hub::http::BoxFuture<'a, Result<HttpResponse, HttpError>> {
            self.seen.lock().expect("lock").push(request);
            let response = self
                .response
                .lock()
                .expect("lock")
                .take()
                .unwrap_or_else(|| HttpResponse::new(StatusCode::OK, HeaderMap::new(), ""));
            Box::pin(async move { Ok(response) })
        }
    }

    fn jwt_token(payload: &Value) -> String {
        format!(
            "{}.{}.{}",
            URL_SAFE_NO_PAD.encode("{\"alg\":\"none\"}"),
            URL_SAFE_NO_PAD.encode(serde_json::to_string(payload).expect("payload")),
            URL_SAFE_NO_PAD.encode("sig"),
        )
    }

    fn codex_token(account_id: Option<&str>, exp: Option<i64>) -> String {
        let mut claims = json!({ "sub": "user" });
        if let Some(account_id) = account_id {
            claims[OPENAI_CODEX_AUTH_CLAIM_PATH] =
                json!({ OPENAI_CODEX_AUTH_CLAIM_ID: account_id });
        }
        if let Some(exp) = exp {
            claims["exp"] = json!(exp);
        }
        jwt_token(&claims)
    }

    /// `codexAuth.ts:132-144`: only a three-part, JSON-object payload decodes.
    #[test]
    fn decode_jwt_payload_matches_typescript() {
        let token = jwt_token(&json!({ "sub": "u" }));
        assert_eq!(
            decode_jwt_payload(&token).and_then(|v| v.get("sub").cloned()),
            Some(json!("u"))
        );
        assert_eq!(decode_jwt_payload("a.b"), None);
        assert_eq!(decode_jwt_payload("a..c"), None);
        assert_eq!(decode_jwt_payload("a.b.c.d"), None);
        assert_eq!(
            decode_jwt_payload(&format!("a.{}.c", URL_SAFE_NO_PAD.encode("42"))),
            None
        );
        assert_eq!(
            decode_jwt_payload(&format!(
                "a.{}.c",
                URL_SAFE_NO_PAD.encode("{\"a\":\"not json")
            )),
            None
        );
    }

    /// `codexAuth.ts:146-153`: the id is read from the auth claim and trimmed.
    #[test]
    fn extract_codex_account_id_reads_the_claim() {
        assert_eq!(
            extract_codex_account_id(&codex_token(Some("acct_1"), None)).as_deref(),
            Some("acct_1")
        );
        assert_eq!(
            extract_codex_account_id(&codex_token(Some("  spaced  "), None)).as_deref(),
            Some("spaced")
        );
        assert_eq!(extract_codex_account_id(&codex_token(None, None)), None);
        assert_eq!(extract_codex_account_id("not-a-jwt"), None);
    }

    /// `codexAuth.ts:155-161`: `exp <= now + max(0, buffer)`, and a missing or
    /// non-numeric `exp` reports `false`.
    #[test]
    fn is_jwt_expiring_soon_uses_the_expiry_window() {
        let token = codex_token(None, Some(1000));
        assert!(is_jwt_expiring_soon_at(&token, 90, 910));
        assert!(is_jwt_expiring_soon_at(&token, 90, 1000));
        assert!(!is_jwt_expiring_soon_at(&token, 90, 909));
        // A negative buffer is floored at zero.
        assert!(is_jwt_expiring_soon_at(&token, -50, 1000));
        assert!(!is_jwt_expiring_soon_at(&token, -50, 999));
        // No usable `exp`.
        assert!(!is_jwt_expiring_soon_at("not-a-jwt", 90, 0));
        assert!(!is_jwt_expiring_soon_at(&codex_token(None, None), 90, 0));
    }

    /// `codexAuth.ts:64-67`: `cli|<first 16 hex of sha256(home)>`; value from the
    /// Node 24 vector for `/Users/example/.codex`.
    #[test]
    fn keychain_account_matches_the_node_vector() {
        assert_eq!(
            compute_codex_keychain_account("/Users/example/.codex"),
            "cli|8533f99d37c07dbb"
        );
    }

    /// `codexAuth.ts:163-165`: the public client id, overridable by the env.
    #[test]
    fn client_id_defaults_to_the_public_app_id() {
        assert_eq!(
            get_open_ai_codex_client_id(&EnvOverrides::new()),
            OPENAI_CODEX_PUBLIC_CLIENT_ID
        );
        let env = EnvOverrides::new().with("OPENAI_OAUTH_CLIENT_ID", "  custom  ");
        assert_eq!(get_open_ai_codex_client_id(&env), "custom");
        let env = EnvOverrides::new().with("OPENAI_OAUTH_CLIENT_ID", "   ");
        assert_eq!(
            get_open_ai_codex_client_id(&env),
            OPENAI_CODEX_PUBLIC_CLIENT_ID
        );
    }

    /// `codexAuth.ts:167-208`: a successful refresh posts the form body to the
    /// token endpoint and reads `access_token`, `refresh_token` and `expires_in`.
    #[tokio::test]
    async fn refresh_posts_the_form_and_reads_the_result() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600 }),
        ));
        let env = EnvOverrides::new();

        let result = refresh_open_ai_codex_token(&transport, "old-refresh", &env, 1_000_000)
            .await
            .expect("refresh");

        assert_eq!(result.access_token, "new-access");
        assert_eq!(result.refresh_token, "new-refresh");
        assert_eq!(result.expires_at, Some(1_000_000 + 3_600_000));

        let seen = transport.seen.lock().expect("lock");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].method, http::Method::POST);
        assert_eq!(seen[0].url, OPENAI_CODEX_TOKEN_URL);
        assert_eq!(
            seen[0].headers.get("content-type").expect("content type"),
            "application/x-www-form-urlencoded"
        );
        assert_eq!(
            seen[0].body.as_deref().expect("body"),
            format!(
                "grant_type=refresh_token&refresh_token=old-refresh&client_id={}",
                OPENAI_CODEX_PUBLIC_CLIENT_ID
            )
        );
    }

    /// `codexAuth.ts:197`: a response without `refresh_token` keeps the old one.
    #[tokio::test]
    async fn refresh_keeps_the_old_refresh_token_when_absent() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "access_token": "a" }),
        ));
        let result = refresh_open_ai_codex_token(&transport, "keep-me", &EnvOverrides::new(), 0)
            .await
            .expect("refresh");
        assert_eq!(result.refresh_token, "keep-me");
        assert_eq!(result.expires_at, None);
    }

    /// `codexAuth.ts:184-190`: `error_description` wins over `error` over the
    /// status fallback.
    #[tokio::test]
    async fn refresh_errors_follow_the_typescript_precedence() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::BAD_REQUEST,
            &json!({ "error_description": "bad token", "error": "invalid_grant" }),
        ));
        let error = refresh_open_ai_codex_token(&transport, "r", &EnvOverrides::new(), 0)
            .await
            .expect_err("refresh fails");
        assert_eq!(error, CodexAuthError::Refresh("bad token".to_string()));

        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "invalid_grant" }),
        ));
        let error = refresh_open_ai_codex_token(&transport, "r", &EnvOverrides::new(), 0)
            .await
            .expect_err("refresh fails");
        assert_eq!(error, CodexAuthError::Refresh("invalid_grant".to_string()));

        let transport =
            StubTransport::new(HttpResponse::text(StatusCode::INTERNAL_SERVER_ERROR, ""));
        let error = refresh_open_ai_codex_token(&transport, "r", &EnvOverrides::new(), 0)
            .await
            .expect_err("refresh fails");
        assert_eq!(
            error,
            CodexAuthError::Refresh("OpenAI Codex token refresh failed (500).".to_string())
        );
    }

    /// `codexAuth.ts:192-195`: a 2xx without `access_token` is an error.
    #[tokio::test]
    async fn refresh_requires_an_access_token() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "token_type": "Bearer" }),
        ));
        let error = refresh_open_ai_codex_token(&transport, "r", &EnvOverrides::new(), 0)
            .await
            .expect_err("refresh fails");
        assert_eq!(
            error,
            CodexAuthError::Refresh(
                "OpenAI Codex token refresh response did not include access_token.".to_string()
            )
        );
    }

    /// `codexAuth.ts:170`: `OPENAI_OAUTH_TOKEN_URL` overrides the endpoint.
    #[tokio::test]
    async fn refresh_honours_the_token_url_override() {
        let transport = StubTransport::new(HttpResponse::json(
            StatusCode::OK,
            &json!({ "access_token": "a" }),
        ));
        let env = EnvOverrides::new().with("OPENAI_OAUTH_TOKEN_URL", "https://example.test/token");
        refresh_open_ai_codex_token(&transport, "r", &env, 0)
            .await
            .expect("refresh");
        assert_eq!(
            transport.seen.lock().expect("lock")[0].url,
            "https://example.test/token"
        );
    }
}
