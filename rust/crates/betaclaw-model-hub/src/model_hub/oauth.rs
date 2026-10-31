//! Port of `src/server/model-hub/oauth.ts` (1-69).
//!
//! The OAuth `state` parameter carries the pending account link across the
//! provider round-trip: `createOAuthState` base64url-encodes the JSON payload and
//! appends an HMAC-SHA256 signature (`oauth.ts:29-34`); `parseOAuthState` verifies
//! the signature and the TTL before trusting it (`oauth.ts:36-59`). PKCE
//! (`createPkcePair`, `oauth.ts:61-65`) and the nonce (`createOAuthNonce`,
//! `oauth.ts:67-69`) are the anti-CSRF pieces of the same flow.
//!
//! # How HMAC-SHA256 is reached without a new crate
//!
//! `crypto.rs:34-45` recorded that the OAuth state could not be ported because no
//! usable `hmac` was in the workspace. That note no longer matches this crate's
//! dependency set: `hkdf 0.13`, already a direct dependency of `betaclaw-core`, is
//! built on `hmac 0.13`/`digest 0.11.3` — the same `digest` version `sha2 0.11`
//! uses. HKDF-Extract is *defined* as `PRK = HMAC-Hash(salt, IKM)` (RFC 5869
//! §2.2), so `Hkdf::<Sha256>::extract(Some(key), message).0` is byte-for-byte
//! `HMAC-SHA256(key, message)`. [`hmac_sha256`] is a thin, tested wrapper around
//! that definition; no hand-rolled HMAC and no new crate. The signature check
//! below is a plain string comparison, matching `oauth.ts:44`
//! (`signaturePart !== expected`), which is not constant-time either.
//!
//! # Verified vector
//!
//! Produced with the real `oauth.ts` under Node 24 for
//! `payload = { providerId: 'openai-codex', label: 'My account',
//! createdAt: 1700000000000, nonce: 'nonce-abc', codeVerifier: 'verifier-xyz',
//! oauthRedirectUri: 'http://localhost:1455/auth/callback' }` and
//! `signingKey = 'signing-key-123'`:
//!
//! ```text
//! signature = KfYynvWsRDtuY5FjVZJo_q4aa42NOAFSahpqdBg0YF8
//! ```

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::model_hub::crypto::{pkce_challenge, random_bytes, to_base64_url, CryptoError};

/// `OAUTH_STATE_TTL_MS` from `oauth.ts:12`.
pub const OAUTH_STATE_TTL_MS: i64 = 10 * 60 * 1000;

/// Length of the nonce `createOAuthNonce` draws (`oauth.ts:68`):
/// `crypto.randomBytes(16)`.
pub const OAUTH_NONCE_BYTES: usize = 16;

/// `OauthStatePayload` from `oauth.ts:3-10`.
///
/// The field order is the serialisation order `JSON.stringify` uses and therefore
/// part of the signed bytes; it must not be rearranged. Every field defaults so a
/// missing key reads like TypeScript's `undefined` instead of failing the parse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthStatePayload {
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_verifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_redirect_uri: Option<String>,
}

/// Failure of [`parse_oauth_state`].
///
/// The four messages that `oauth.ts` throws verbatim are preserved exactly; the
/// `JSON.parse` failure (`oauth.ts:48`) is a raw `SyntaxError` there and gains a
/// descriptive wrapper here.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OauthStateError {
    /// `'Invalid OAuth state format.'` (`oauth.ts:39`).
    #[error("Invalid OAuth state format.")]
    InvalidFormat,
    /// `'Invalid OAuth state signature.'` (`oauth.ts:45`).
    #[error("Invalid OAuth state signature.")]
    InvalidSignature,
    /// `'OAuth state payload is incomplete.'` (`oauth.ts:50`).
    #[error("OAuth state payload is incomplete.")]
    Incomplete,
    /// `'OAuth state expired.'` (`oauth.ts:55`).
    #[error("OAuth state expired.")]
    Expired,
    /// `JSON.parse(serializedPayload)` failed.
    #[error("Invalid OAuth state payload: {0}")]
    InvalidJson(String),
}

/// `Hmac<Sha256>` computed through HKDF-Extract, which is *defined* as
/// `HMAC-Hash(salt, IKM)` (RFC 5869 §2.2). Reusing `hkdf` keeps the workspace
/// dependency set unchanged, and the result is checked against the Node vector in
/// the tests.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let (prk, _) = hkdf::Hkdf::<Sha256>::extract(Some(key), message);
    let mut out = [0u8; 32];
    out.copy_from_slice(&prk);
    out
}

/// `signState` from `oauth.ts:25-27`: base64url without padding of the raw MAC.
pub fn sign_state(serialized_payload: &str, signing_key: &str) -> String {
    to_base64_url(&hmac_sha256(
        signing_key.as_bytes(),
        serialized_payload.as_bytes(),
    ))
}

/// `fromBase64Url` from `oauth.ts:19-23`.
///
/// Node's `Buffer.from(value, 'base64')` is lenient: it ignores characters it
/// cannot place and never throws. The port keeps that shape by returning an empty
/// buffer when the strict decoder rejects the input, which then fails the
/// signature comparison — the same observable outcome as Node decoding to a
/// different string.
pub fn from_base64_url(input: &str) -> Vec<u8> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    let normalized = input.replace('-', "+").replace('_', "/");
    let remainder = normalized.len() % 4;
    let padded = if remainder == 0 {
        normalized
    } else {
        format!("{normalized}{}", "=".repeat(4 - remainder))
    };
    STANDARD.decode(padded.as_bytes()).unwrap_or_default()
}

/// `createOAuthState(payload, signingKey)` from `oauth.ts:29-34`.
pub fn create_oauth_state(payload: &OauthStatePayload, signing_key: &str) -> String {
    let serialized_payload =
        serde_json::to_string(payload).expect("OAuth state payload is always serialisable");
    let encoded_payload = to_base64_url(serialized_payload.as_bytes());
    let signature = sign_state(&serialized_payload, signing_key);
    format!("{encoded_payload}.{signature}")
}

/// `parseOAuthState(state, signingKey)` from `oauth.ts:36-59`, with the clock
/// injected so the TTL check is deterministic in a test.
pub fn parse_oauth_state_at(
    state: &str,
    signing_key: &str,
    now_ms: i64,
) -> Result<OauthStatePayload, OauthStateError> {
    let mut parts = state.split('.');
    let (Some(payload_part), Some(signature_part)) = (parts.next(), parts.next()) else {
        return Err(OauthStateError::InvalidFormat);
    };

    let serialized_payload = String::from_utf8_lossy(&from_base64_url(payload_part)).into_owned();
    let expected = sign_state(&serialized_payload, signing_key);
    if signature_part != expected {
        return Err(OauthStateError::InvalidSignature);
    }

    let payload: OauthStatePayload = serde_json::from_str(&serialized_payload)
        .map_err(|error| OauthStateError::InvalidJson(error.to_string()))?;

    if payload.provider_id.is_empty()
        || payload.label.is_empty()
        || payload.created_at == 0
        || payload.nonce.is_empty()
    {
        return Err(OauthStateError::Incomplete);
    }

    let age = now_ms - payload.created_at;
    if age > OAUTH_STATE_TTL_MS {
        return Err(OauthStateError::Expired);
    }

    Ok(payload)
}

/// `Date.now()` — milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// `parseOAuthState(state, signingKey)` from `oauth.ts:36-59`.
pub fn parse_oauth_state(
    state: &str,
    signing_key: &str,
) -> Result<OauthStatePayload, OauthStateError> {
    parse_oauth_state_at(state, signing_key, now_ms())
}

/// `createPkcePair()` from `oauth.ts:61-65`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PkcePair {
    /// `codeVerifier` — `toBase64Url(crypto.randomBytes(32))`.
    pub code_verifier: String,
    /// `codeChallenge` — `toBase64Url(sha256(codeVerifier))`.
    pub code_challenge: String,
}

/// `createPkcePair()` from `oauth.ts:61-65`.
pub fn create_pkce_pair() -> Result<PkcePair, CryptoError> {
    let code_verifier = to_base64_url(&random_bytes(
        crate::model_hub::crypto::PKCE_VERIFIER_BYTES,
    )?);
    let code_challenge = pkce_challenge(&code_verifier);
    Ok(PkcePair {
        code_verifier,
        code_challenge,
    })
}

/// `createOAuthNonce()` from `oauth.ts:67-69`.
pub fn create_oauth_nonce() -> Result<String, CryptoError> {
    Ok(to_base64_url(&random_bytes(OAUTH_NONCE_BYTES)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIGNING_KEY: &str = "signing-key-123";
    /// `signState(serialized, 'signing-key-123')` from the Node 24 vector.
    const NODE_SIGNATURE: &str = "KfYynvWsRDtuY5FjVZJo_q4aa42NOAFSahpqdBg0YF8";

    fn node_payload() -> OauthStatePayload {
        OauthStatePayload {
            provider_id: "openai-codex".to_string(),
            label: "My account".to_string(),
            created_at: 1_700_000_000_000,
            nonce: "nonce-abc".to_string(),
            code_verifier: Some("verifier-xyz".to_string()),
            oauth_redirect_uri: Some("http://localhost:1455/auth/callback".to_string()),
        }
    }

    /// The exact serialised payload the Node vector signed.
    const NODE_SERIALIZED: &str = concat!(
        "{\"providerId\":\"openai-codex\",\"label\":\"My account\",",
        "\"createdAt\":1700000000000,\"nonce\":\"nonce-abc\",",
        "\"codeVerifier\":\"verifier-xyz\",",
        "\"oauthRedirectUri\":\"http://localhost:1455/auth/callback\"}"
    );

    /// `JSON.stringify` order + `signState` must reproduce the Node signature
    /// byte for byte; this pins both the field order and the HMAC.
    #[test]
    fn signature_matches_the_node_vector() {
        assert_eq!(NODE_SERIALIZED, "{\"providerId\":\"openai-codex\",\"label\":\"My account\",\"createdAt\":1700000000000,\"nonce\":\"nonce-abc\",\"codeVerifier\":\"verifier-xyz\",\"oauthRedirectUri\":\"http://localhost:1455/auth/callback\"}");
        assert_eq!(sign_state(NODE_SERIALIZED, SIGNING_KEY), NODE_SIGNATURE);
    }

    /// `createOAuthState` signs exactly the bytes `serde_json` produces for the
    /// payload, so the encoded prefix decodes to [`NODE_SERIALIZED`].
    #[test]
    fn create_oauth_state_signs_the_json_payload() {
        let state = create_oauth_state(&node_payload(), SIGNING_KEY);
        let (encoded, signature) = state.split_once('.').expect("state has a signature");
        assert_eq!(signature, NODE_SIGNATURE);
        assert_eq!(encoded, to_base64_url(NODE_SERIALIZED.as_bytes()));
        assert_eq!(
            String::from_utf8(from_base64_url(encoded)).expect("utf8"),
            NODE_SERIALIZED
        );
    }

    /// `oauth.ts:36-59`: a valid, unexpired state round-trips with every field.
    #[test]
    fn parse_round_trips_the_payload() {
        let state = create_oauth_state(&node_payload(), SIGNING_KEY);
        let parsed =
            parse_oauth_state_at(&state, SIGNING_KEY, 1_700_000_000_000 + 1).expect("valid state");
        assert_eq!(parsed, node_payload());
    }

    /// The optional fields are omitted from the signed bytes when absent.
    #[test]
    fn optional_fields_are_omitted() {
        let payload = OauthStatePayload {
            provider_id: "openai".to_string(),
            label: "L".to_string(),
            created_at: 1,
            nonce: "n".to_string(),
            code_verifier: None,
            oauth_redirect_uri: None,
        };
        let state = create_oauth_state(&payload, SIGNING_KEY);
        let (encoded, _) = state.split_once('.').expect("state");
        assert_eq!(
            String::from_utf8(from_base64_url(encoded)).expect("utf8"),
            "{\"providerId\":\"openai\",\"label\":\"L\",\"createdAt\":1,\"nonce\":\"n\"}"
        );
    }

    /// `oauth.ts:37-40`: a state without a signature separator is malformed.
    #[test]
    fn a_state_without_a_dot_is_malformed() {
        assert_eq!(
            parse_oauth_state_at("no-dot-here", SIGNING_KEY, 0),
            Err(OauthStateError::InvalidFormat)
        );
    }

    /// `oauth.ts:43-46`: a signature over a different key is rejected.
    #[test]
    fn a_wrong_key_is_rejected() {
        let state = create_oauth_state(&node_payload(), SIGNING_KEY);
        assert_eq!(
            parse_oauth_state_at(&state, "other-key", 1_700_000_000_000),
            Err(OauthStateError::InvalidSignature)
        );
    }

    /// `oauth.ts:49-51`: a validly signed but incomplete payload is rejected.
    #[test]
    fn an_incomplete_payload_is_rejected() {
        let payload = OauthStatePayload {
            provider_id: "openai".to_string(),
            label: String::new(),
            created_at: 1,
            nonce: "n".to_string(),
            code_verifier: None,
            oauth_redirect_uri: None,
        };
        let state = create_oauth_state(&payload, SIGNING_KEY);
        assert_eq!(
            parse_oauth_state_at(&state, SIGNING_KEY, 1),
            Err(OauthStateError::Incomplete)
        );
    }

    /// `oauth.ts:53-56`: older than the 10-minute TTL is expired, exactly at the
    /// boundary it still parses (`age > TTL`).
    #[test]
    fn the_ttl_is_enforced() {
        let state = create_oauth_state(&node_payload(), SIGNING_KEY);
        let created = node_payload().created_at;
        assert!(parse_oauth_state_at(&state, SIGNING_KEY, created + OAUTH_STATE_TTL_MS).is_ok());
        assert_eq!(
            parse_oauth_state_at(&state, SIGNING_KEY, created + OAUTH_STATE_TTL_MS + 1),
            Err(OauthStateError::Expired)
        );
    }

    /// `fromBase64Url` reverses `toBase64Url`, and yields empty for garbage
    /// (Node `Buffer.from` behaviour).
    #[test]
    fn base64_url_round_trips_and_is_lenient() {
        let bytes = [0xfb, 0xff, 0xfe, 0x00, 0x3e, 0x3f];
        assert_eq!(from_base64_url(&to_base64_url(&bytes)), bytes);
        assert!(from_base64_url("!!!!").is_empty());
    }

    /// `oauth.ts:61-65`: 32 random bytes -> a 43-char verifier and a 43-char
    /// challenge; two draws differ.
    #[test]
    fn pkce_pair_has_the_expected_shape() {
        let pair = create_pkce_pair().expect("csprng");
        assert_eq!(pair.code_verifier.len(), 43);
        assert_eq!(pair.code_challenge.len(), 43);
        assert_eq!(pair.code_challenge, pkce_challenge(&pair.code_verifier));
        assert_ne!(
            pair.code_verifier,
            create_pkce_pair().expect("csprng").code_verifier
        );
    }

    /// `oauth.ts:67-69`: 16 random bytes -> a 22-char base64url nonce.
    #[test]
    fn oauth_nonce_has_the_expected_shape() {
        let nonce = create_oauth_nonce().expect("csprng");
        assert_eq!(nonce.len(), 22);
        assert_ne!(nonce, create_oauth_nonce().expect("csprng"));
    }
}
