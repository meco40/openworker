//! Port of `src/server/model-hub/Models/openai-codex/client/config.ts`, plus the
//! JWT reader that `config.ts:1` imports from
//! `src/server/model-hub/codexAuth.ts`.
//!
//! `codexAuth.ts` is not ported yet (`service/refresh.rs:50` documents that the
//! refresh path has no Rust counterpart), so [`extract_codex_account_id`] and its
//! [`decode_jwt_payload`] helper live here as a mirror of `codexAuth.ts:132-153`.
//! They read the `chatgpt_account_id` claim from
//! `https://api.openai.com/auth`.
//!
//! The header builders return an ordered `Vec` instead of a `Record`, because
//! the order is what makes the request reproducible in a test and because the
//! `HttpRequest` builder applies the headers one by one.
//!
//! # Deviation
//!
//! `Buffer.from(payload, 'base64url')` is lenient: it ignores invalid
//! characters and whitespace, while the port decodes strictly (unpadded input is
//! accepted, anything else is not). A token that is not a well-formed JWT
//! therefore reads as "no account id" here instead of decoding to garbage — both
//! end in the same [`CodexError`].

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::Value;

use super::super::constants::{CODEX_BASE_URL, CODEX_RESPONSES_PATH, OPENAI_CODEX_AUTH_CLAIM_HINT};
use super::super::types::{CodexError, CodexReasoningEffort};

/// `OPENAI_CODEX_AUTH_CLAIM_PATH` from `codexAuth.ts:11`.
pub const CODEX_AUTH_CLAIM_PATH: &str = "https://api.openai.com/auth";
/// The `chatgpt_account_id` member of that claim (`codexAuth.ts:151`).
pub const CODEX_AUTH_CLAIM_FIELD: &str = "chatgpt_account_id";
/// `'responses=experimental'` from `config.ts:50` and `:69`.
pub const CODEX_BETA_HEADER: &str = "responses=experimental";
/// `'pi'` from `config.ts:51` and `:70`.
pub const CODEX_ORIGINATOR: &str = "pi";
/// `'clawtest-model-hub'` from `config.ts:54` and `:72`.
pub const CODEX_USER_AGENT: &str = "clawtest-model-hub";
/// The `resolveCodexProbeModel` fallback of `config.ts:13`.
pub const DEFAULT_PROBE_MODEL: &str = "gpt-5.3-codex";
/// `'text/event-stream'` — the `Accept` of `config.ts:52`.
pub const CODEX_ACCEPT: &str = "text/event-stream";
/// `'application/json'` — the `Accept` of `config.ts:71`.
pub const CODEX_USAGE_ACCEPT: &str = "application/json";

/// `resolveCodexProbeModel` from `config.ts:5-14`.
///
/// `options?.model` wins, then the first non-blank catalog model, then
/// `gpt-5.3-codex`.
pub fn resolve_codex_probe_model(
    preferred_model: Option<&str>,
    default_models: &[String],
) -> String {
    let preferred = preferred_model
        .map(str::trim)
        .filter(|model| !model.is_empty());
    if let Some(preferred) = preferred {
        return preferred.to_string();
    }
    let from_defaults = default_models
        .iter()
        .map(|model| model.trim())
        .find(|model| !model.is_empty());
    match from_defaults {
        Some(model) => model.to_string(),
        None => DEFAULT_PROBE_MODEL.to_string(),
    }
}

/// `(baseUrl || CODEX_BASE_URL).trim().replace(/\/+$/, '')` from `config.ts:17`
/// and `:24`.
///
/// `||` treats an empty string as absent, and every trailing slash is removed.
fn normalized_base_url(base_url: Option<&str>) -> String {
    let raw = base_url
        .filter(|value| !value.is_empty())
        .unwrap_or(CODEX_BASE_URL);
    raw.trim().trim_end_matches('/').to_string()
}

/// `resolveCodexEndpoint` from `config.ts:16-21`.
pub fn resolve_codex_endpoint(base_url: Option<&str>) -> String {
    let normalized = normalized_base_url(base_url);
    if normalized.ends_with(CODEX_RESPONSES_PATH) {
        return normalized;
    }
    if normalized.ends_with("/codex") {
        return format!("{normalized}/responses");
    }
    format!("{normalized}{CODEX_RESPONSES_PATH}")
}

/// `resolveCodexUsageEndpoint` from `config.ts:23-37`.
///
/// Everything up to and including the first `/backend-api` is the backend root,
/// so a base URL that already carries a path still resolves to
/// `${backendRoot}/wham/usage`.
pub fn resolve_codex_usage_endpoint(base_url: Option<&str>) -> String {
    let normalized = normalized_base_url(base_url);
    if let Some(index) = normalized.find("/backend-api") {
        let backend_base = &normalized[..index + "/backend-api".len()];
        return format!("{backend_base}/wham/usage");
    }
    if let Some(stripped) = normalized.strip_suffix(CODEX_RESPONSES_PATH) {
        return format!("{stripped}/wham/usage");
    }
    if let Some(stripped) = normalized.strip_suffix("/codex") {
        return format!("{stripped}/wham/usage");
    }
    format!("{normalized}/wham/usage")
}

/// The `throw new Error(...)` both header builders share (`config.ts:41-45`,
/// `:60-64`).
fn missing_account_id_error() -> CodexError {
    CodexError::new(format!(
        "OpenAI Codex access token is missing {OPENAI_CODEX_AUTH_CLAIM_HINT} in JWT claims."
    ))
}

/// `buildCodexHeaders` from `config.ts:39-56`.
pub fn build_codex_headers(secret: &str) -> Result<Vec<(&'static str, String)>, CodexError> {
    let account_id = extract_codex_account_id(secret).ok_or_else(missing_account_id_error)?;
    Ok(vec![
        ("Authorization", format!("Bearer {secret}")),
        ("chatgpt-account-id", account_id),
        ("OpenAI-Beta", CODEX_BETA_HEADER.to_string()),
        ("originator", CODEX_ORIGINATOR.to_string()),
        ("Accept", CODEX_ACCEPT.to_string()),
        ("Content-Type", "application/json".to_string()),
        ("User-Agent", CODEX_USER_AGENT.to_string()),
    ])
}

/// `buildCodexUsageHeaders` from `config.ts:58-74` — the same set without
/// `Content-Type` and with a JSON `Accept`.
pub fn build_codex_usage_headers(secret: &str) -> Result<Vec<(&'static str, String)>, CodexError> {
    let account_id = extract_codex_account_id(secret).ok_or_else(missing_account_id_error)?;
    Ok(vec![
        ("Authorization", format!("Bearer {secret}")),
        ("chatgpt-account-id", account_id),
        ("OpenAI-Beta", CODEX_BETA_HEADER.to_string()),
        ("originator", CODEX_ORIGINATOR.to_string()),
        ("Accept", CODEX_USAGE_ACCEPT.to_string()),
        ("User-Agent", CODEX_USER_AGENT.to_string()),
    ])
}

/// `clampCodexReasoningEffort` from `config.ts:76-95`.
///
/// `gpt-5.2*`/`gpt-5.3*` cannot do `minimal`, `gpt-5.1` cannot do `xhigh`, and
/// `gpt-5.1-codex-mini` collapses `high`/`xhigh` to `high` and `minimal` to
/// `medium`. The comparison uses the lowercased, trimmed model id.
pub fn clamp_codex_reasoning_effort(
    model_id: &str,
    effort: CodexReasoningEffort,
) -> CodexReasoningEffort {
    let normalized_model_id = model_id.trim().to_lowercase();

    if (normalized_model_id.starts_with("gpt-5.2") || normalized_model_id.starts_with("gpt-5.3"))
        && effort == CodexReasoningEffort::Minimal
    {
        return CodexReasoningEffort::Low;
    }
    if normalized_model_id == "gpt-5.1" && effort == CodexReasoningEffort::Xhigh {
        return CodexReasoningEffort::High;
    }
    if normalized_model_id == "gpt-5.1-codex-mini" {
        if matches!(
            effort,
            CodexReasoningEffort::High | CodexReasoningEffort::Xhigh
        ) {
            return CodexReasoningEffort::High;
        }
        if effort == CodexReasoningEffort::Minimal {
            return CodexReasoningEffort::Medium;
        }
    }
    effort
}

/// `decodeJwtPayload` from `codexAuth.ts:132-144`.
///
/// The token must have exactly three dot-separated parts and a non-empty
/// payload that base64url-decodes to a JSON object (or array — `typeof []` is
/// `'object'` too in JavaScript).
pub fn decode_jwt_payload(token: &str) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = parts[1];
    if payload.is_empty() {
        return None;
    }

    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let decoded = String::from_utf8_lossy(&bytes).to_string();
    let parsed: Value = serde_json::from_str(&decoded).ok()?;
    (parsed.is_object() || parsed.is_array()).then_some(parsed)
}

/// `extractCodexAccountId` from `codexAuth.ts:146-153`.
///
/// Reads `payload['https://api.openai.com/auth'].chatgpt_account_id` and trims
/// it; anything else — a token without the claim, a non-object claim, a blank
/// value — reads as `None`, which both header builders turn into the
/// `chatgpt_account_id` error.
pub fn extract_codex_account_id(access_token: &str) -> Option<String> {
    let payload = decode_jwt_payload(access_token)?;
    let auth = payload.get(CODEX_AUTH_CLAIM_PATH)?;
    if !auth.is_object() {
        return None;
    }
    super::super::utils::to_non_empty_string(auth.get(CODEX_AUTH_CLAIM_FIELD))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The helper of `openai-codex-models.test.ts:6-15`.
    fn codex_access_token(account_id: &str) -> String {
        let payload = json!({ CODEX_AUTH_CLAIM_PATH: { CODEX_AUTH_CLAIM_FIELD: account_id } });
        let encoded = URL_SAFE_NO_PAD.encode(payload.to_string());
        format!("header.{encoded}.signature")
    }

    #[test]
    fn the_probe_model_falls_back_from_the_option_to_the_catalog() {
        assert_eq!(
            resolve_codex_probe_model(Some(" gpt-5.6 "), &["gpt-5.3-codex".to_string()]),
            "gpt-5.6"
        );
        assert_eq!(
            resolve_codex_probe_model(Some("   "), &[" gpt-5.6 ".to_string()]),
            "gpt-5.6"
        );
        assert_eq!(
            resolve_codex_probe_model(None, &["".to_string(), "gpt-5.1".to_string()]),
            "gpt-5.1"
        );
        assert_eq!(
            resolve_codex_probe_model(None, &[" ".to_string()]),
            DEFAULT_PROBE_MODEL
        );
        assert_eq!(resolve_codex_probe_model(None, &[]), DEFAULT_PROBE_MODEL);
    }

    #[test]
    fn the_responses_endpoint_is_derived_from_the_base_url() {
        assert_eq!(
            resolve_codex_endpoint(None),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            resolve_codex_endpoint(Some("")),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            resolve_codex_endpoint(Some("https://chatgpt.com/backend-api///")),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            resolve_codex_endpoint(Some("https://example.test/codex")),
            "https://example.test/codex/responses"
        );
        assert_eq!(
            resolve_codex_endpoint(Some("https://example.test/codex/responses")),
            "https://example.test/codex/responses"
        );
        assert_eq!(
            resolve_codex_endpoint(Some("https://example.test")),
            "https://example.test/codex/responses"
        );
    }

    #[test]
    fn the_usage_endpoint_collapses_onto_the_backend_root() {
        assert_eq!(
            resolve_codex_usage_endpoint(None),
            "https://chatgpt.com/backend-api/wham/usage"
        );
        assert_eq!(
            resolve_codex_usage_endpoint(Some("https://chatgpt.com/backend-api/codex/responses")),
            "https://chatgpt.com/backend-api/wham/usage"
        );
        assert_eq!(
            resolve_codex_usage_endpoint(Some("https://chatgpt.com/backend-api/codex")),
            "https://chatgpt.com/backend-api/wham/usage"
        );
        assert_eq!(
            resolve_codex_usage_endpoint(Some("https://example.test")),
            "https://example.test/wham/usage"
        );
        assert_eq!(
            resolve_codex_usage_endpoint(Some("https://example.test/api")),
            "https://example.test/api/wham/usage"
        );
    }

    #[test]
    fn the_headers_carry_the_account_id_and_the_beta_flag() {
        let token = codex_access_token("acct_dispatch");
        let headers = build_codex_headers(&token).expect("headers");
        assert_eq!(
            headers,
            vec![
                ("Authorization", format!("Bearer {token}")),
                ("chatgpt-account-id", "acct_dispatch".to_string()),
                ("OpenAI-Beta", "responses=experimental".to_string()),
                ("originator", "pi".to_string()),
                ("Accept", "text/event-stream".to_string()),
                ("Content-Type", "application/json".to_string()),
                ("User-Agent", "clawtest-model-hub".to_string()),
            ]
        );
    }

    /// `tests/unit/model-hub/connectivity.test.ts:398-399` expects the failure
    /// message to name the claim.
    #[test]
    fn a_token_without_the_claim_reports_the_missing_claim() {
        let error = build_codex_headers("header.e30.signature").expect_err("missing claim");
        assert_eq!(
            error.message,
            "OpenAI Codex access token is missing chatgpt_account_id in JWT claims."
        );

        let usage_error = build_codex_usage_headers("not-a-jwt").expect_err("missing claim");
        assert!(usage_error.message.contains("chatgpt_account_id"));
    }

    #[test]
    fn the_usage_headers_omit_the_content_type() {
        let token = codex_access_token("acct");
        let headers = build_codex_usage_headers(&token).expect("headers");
        assert_eq!(
            headers,
            vec![
                ("Authorization", format!("Bearer {token}")),
                ("chatgpt-account-id", "acct".to_string()),
                ("OpenAI-Beta", "responses=experimental".to_string()),
                ("originator", "pi".to_string()),
                ("Accept", "application/json".to_string()),
                ("User-Agent", "clawtest-model-hub".to_string()),
            ]
        );
    }

    #[test]
    fn the_account_id_is_read_from_the_claim() {
        assert_eq!(
            extract_codex_account_id(&codex_access_token("acct_test")).as_deref(),
            Some("acct_test")
        );
        assert_eq!(
            extract_codex_account_id(&codex_access_token("  spaced  ")).as_deref(),
            Some("spaced")
        );
        // A padded payload and an unrelated root key are both fine.
        let payload = json!({ "sub": "x", CODEX_AUTH_CLAIM_PATH: { CODEX_AUTH_CLAIM_FIELD: "a" } });
        let padded = format!("h.{}=.s", URL_SAFE_NO_PAD.encode(payload.to_string()));
        assert_eq!(extract_codex_account_id(&padded).as_deref(), Some("a"));
    }

    #[test]
    fn a_token_that_is_not_a_jwt_has_no_account_id() {
        assert_eq!(extract_codex_account_id(""), None);
        assert_eq!(extract_codex_account_id("a.b"), None);
        assert_eq!(extract_codex_account_id("a..c"), None);
        assert_eq!(extract_codex_account_id("a.!!!!.c"), None);
        // Valid base64, but not JSON.
        assert_eq!(
            extract_codex_account_id(&format!("a.{}.c", URL_SAFE_NO_PAD.encode("payload"))),
            None
        );
        // JSON, but not an object.
        assert_eq!(
            extract_codex_account_id(&format!("a.{}.c", URL_SAFE_NO_PAD.encode("42"))),
            None
        );
        assert_eq!(
            extract_codex_account_id(&format!("a.{}.c", URL_SAFE_NO_PAD.encode("null"))),
            None
        );
    }

    #[test]
    fn a_claim_without_a_usable_id_has_no_account_id() {
        for payload in [
            json!({}),
            json!({ CODEX_AUTH_CLAIM_PATH: null }),
            json!({ CODEX_AUTH_CLAIM_PATH: "https://api.openai.com/auth" }),
            json!({ CODEX_AUTH_CLAIM_PATH: { CODEX_AUTH_CLAIM_FIELD: "   " } }),
            json!({ CODEX_AUTH_CLAIM_PATH: { CODEX_AUTH_CLAIM_FIELD: 7 } }),
        ] {
            let token = format!("a.{}.c", URL_SAFE_NO_PAD.encode(payload.to_string()));
            assert_eq!(extract_codex_account_id(&token), None, "{payload}");
        }
    }

    #[test]
    fn the_reasoning_effort_is_clamped_per_model() {
        use CodexReasoningEffort::{High, Low, Medium, Minimal, None as NoEffort, Xhigh};

        assert_eq!(clamp_codex_reasoning_effort("gpt-5.3-codex", Minimal), Low);
        assert_eq!(clamp_codex_reasoning_effort("GPT-5.2", Minimal), Low);
        assert_eq!(clamp_codex_reasoning_effort(" gpt-5.2-pro ", Minimal), Low);
        assert_eq!(clamp_codex_reasoning_effort("gpt-5.3-codex", High), High);
        assert_eq!(clamp_codex_reasoning_effort("gpt-5.4", Minimal), Minimal);

        assert_eq!(clamp_codex_reasoning_effort("gpt-5.1", Xhigh), High);
        assert_eq!(clamp_codex_reasoning_effort("gpt-5.1", High), High);
        assert_eq!(clamp_codex_reasoning_effort("gpt-5.1-pro", Xhigh), Xhigh);

        assert_eq!(
            clamp_codex_reasoning_effort("gpt-5.1-codex-mini", High),
            High
        );
        assert_eq!(
            clamp_codex_reasoning_effort("gpt-5.1-codex-mini", Xhigh),
            High
        );
        assert_eq!(
            clamp_codex_reasoning_effort("gpt-5.1-codex-mini", Minimal),
            Medium
        );
        assert_eq!(clamp_codex_reasoning_effort("gpt-5.1-codex-mini", Low), Low);
        assert_eq!(
            clamp_codex_reasoning_effort("GPT-5.1-CODEX-MINI", NoEffort),
            NoEffort
        );
    }
}
