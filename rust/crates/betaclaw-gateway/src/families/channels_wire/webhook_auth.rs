//! Port of `src/server/channels/webhookAuth.ts`.
//!
//! Secrets are compared after hashing both sides, so the comparison runs in
//! constant time and the length of the secret does not leak. A missing expected
//! secret rejects the request, unless `ALLOW_INSECURE_WEBHOOKS=true` outside
//! production.

use std::sync::atomic::{AtomicBool, Ordering};

use axum::http::HeaderMap;
use betaclaw_core::channels::pairing::credentials::ChannelEnv;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

static INSECURE_WARNING_LOGGED: AtomicBool = AtomicBool::new(false);

/// `allowInsecureWebhookFallback`.
pub fn allow_insecure_fallback(env: &ChannelEnv) -> bool {
    if env.get("ALLOW_INSECURE_WEBHOOKS").as_deref() != Some("true") {
        return false;
    }
    match env.get("NODE_ENV").as_deref() {
        Some("production") => return false,
        Some("test") => return true,
        _ => {}
    }
    if !INSECURE_WARNING_LOGGED.swap(true, Ordering::Relaxed) {
        tracing::warn!(
            "ALLOW_INSECURE_WEBHOOKS=true enabled. Missing webhook secrets are accepted in non-production environments."
        );
    }
    true
}

/// `verifyTelegramWebhook`: the `X-Telegram-Bot-Api-Secret-Token` header.
pub fn verify_telegram_webhook(headers: &HeaderMap, secret: &str, env: &ChannelEnv) -> bool {
    verify_header(headers, "x-telegram-bot-api-secret-token", secret, env)
}

/// `verifySharedSecret`: the `X-Webhook-Secret` header of the bridges.
pub fn verify_shared_secret(headers: &HeaderMap, secret: &str, env: &ChannelEnv) -> bool {
    verify_header(headers, "x-webhook-secret", secret, env)
}

fn verify_header(headers: &HeaderMap, header: &str, secret: &str, env: &ChannelEnv) -> bool {
    if secret.is_empty() {
        return allow_insecure_fallback(env);
    }
    let provided = headers.get(header).and_then(|value| value.to_str().ok());
    secrets_match(provided, secret)
}

/// `secretsMatch`: equal digests in constant time. A missing header never matches.
pub fn secrets_match(provided: Option<&str>, expected: &str) -> bool {
    let Some(provided) = provided else {
        return false;
    };
    let provided_digest = Sha256::digest(provided.as_bytes());
    let expected_digest = Sha256::digest(expected.as_bytes());
    bool::from(provided_digest.as_slice().ct_eq(expected_digest.as_slice()))
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn headers_with(name: &'static str, value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(name, HeaderValue::from_str(value).expect("header value"));
        headers
    }

    #[test]
    fn a_secret_matches_only_itself() {
        assert!(secrets_match(Some("s3cret"), "s3cret"));
        assert!(!secrets_match(Some("s3cre"), "s3cret"));
        assert!(!secrets_match(Some(""), "s3cret"));
        assert!(!secrets_match(None, "s3cret"));
    }

    #[test]
    fn a_telegram_request_needs_the_configured_secret() {
        let env = ChannelEnv::new();
        let good = headers_with("x-telegram-bot-api-secret-token", "s3cret");
        let bad = headers_with("x-telegram-bot-api-secret-token", "guess");
        assert!(verify_telegram_webhook(&good, "s3cret", &env));
        assert!(!verify_telegram_webhook(&bad, "s3cret", &env));
        assert!(!verify_telegram_webhook(&HeaderMap::new(), "s3cret", &env));
    }

    #[test]
    fn a_missing_secret_rejects_unless_insecure_webhooks_are_allowed_outside_production() {
        let env = ChannelEnv::new();
        assert!(!verify_shared_secret(&HeaderMap::new(), "", &env));

        env.set("ALLOW_INSECURE_WEBHOOKS", "true");
        env.set("NODE_ENV", "production");
        assert!(!verify_shared_secret(&HeaderMap::new(), "", &env));

        env.set("NODE_ENV", "test");
        assert!(verify_shared_secret(&HeaderMap::new(), "", &env));
    }

    #[test]
    fn the_bridge_header_is_checked_for_shared_secrets() {
        let env = ChannelEnv::new();
        let good = headers_with("x-webhook-secret", "bridge");
        assert!(verify_shared_secret(&good, "bridge", &env));
        assert!(!verify_shared_secret(&HeaderMap::new(), "bridge", &env));
    }
}
