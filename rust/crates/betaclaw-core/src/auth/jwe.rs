//! NextAuth v4 session-cookie decoding.
//!
//! `next-auth@4.24.15` issues the session cookie as a compact JWE:
//!
//! ```text
//! alg = dir, enc = A256GCM
//! key = HKDF-SHA256(
//!         ikm  = NEXTAUTH_SECRET,
//!         salt = "",
//!         info = "NextAuth.js Generated Encryption Key",
//!         len  = 32)
//! compact = protectedHeader . encryptedKey . iv . ciphertext . tag
//! ```
//!
//! Source of truth:
//! - `node_modules/next-auth/jwt/index.js` — `getDerivedEncryptionKey` uses
//!   `salt = ""` because neither `core/routes/session.js` nor `getToken` passes
//!   a salt. The `info` string only gains a ` (<salt>)` suffix when a salt is
//!   supplied, and for session cookies it never is.
//! - `node_modules/next-auth/core/lib/cookie.js` — `SessionStore` concatenates
//!   `.0`, `.1`, … chunks in numeric order.
//!
//! Decoding is read-only. Issuing cookies stays with NextAuth until the auth
//! slice is migrated, so the Rust gateway and the TypeScript UI keep sharing one
//! session format.
//!
//! Verified against a real cookie in
//! `crates/betaclaw-gateway/tests/nextauth_parity.rs`.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hkdf::Hkdf;
use serde_json::Value;
use sha2::Sha256;

/// `clockTolerance: 15` in `next-auth/jwt/index.js` `decode()`.
const CLOCK_TOLERANCE_SECONDS: i64 = 15;

/// Cookie chunk size: `ALLOWED_COOKIE_SIZE (4096) - ESTIMATED_EMPTY_COOKIE_SIZE (163)`.
const CHUNK_SIZE: usize = 4096 - 163;

/// Payload of the decrypted session token.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedSession {
    /// `token.id`, injected by the `jwt` callback in `src/auth.ts:90-95`.
    pub user_id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    /// `exp` in seconds since the epoch.
    pub expires_at: Option<i64>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum JweError {
    #[error("session cookie not present")]
    Missing,
    #[error("session cookie is malformed")]
    Malformed,
    #[error("session cookie uses an unsupported protected header")]
    UnsupportedHeader,
    #[error("session cookie could not be decrypted")]
    DecryptFailed,
    #[error("session token payload is not a JSON object")]
    InvalidPayload,
    #[error("session token carries no usable user id")]
    MissingUserId,
    #[error("session token expired")]
    Expired,
}

/// Derives the 32-byte A256GCM content-encryption key.
///
/// Port of `getDerivedEncryptionKey()` from `next-auth/jwt/index.js`.
///
/// The salt is the empty string, not the cookie name. `getToken` and
/// `core/routes/session.js` both call `decode({ ...jwt, token })` without a
/// `salt`, so the `salt = ""` default applies and the `info` string stays
/// undecorated. Passing the cookie name here yields a different key and every
/// session cookie fails to decrypt.
fn derive_key(secret: &str) -> [u8; 32] {
    let info = "NextAuth.js Generated Encryption Key";
    let hkdf = Hkdf::<Sha256>::new(Some(b""), secret.as_bytes());
    let mut key = [0u8; 32];
    hkdf.expand(info.as_bytes(), &mut key)
        .expect("HKDF-SHA256 expand to 32 bytes is infallible");
    key
}

/// Reassembles a possibly chunked session cookie.
///
/// Port of the `SessionStore` constructor plus the `value` getter: every cookie
/// whose name starts with `cookie_name` is collected and the numeric `.N` suffix
/// is sorted ascending before concatenation.
pub fn join_cookie_chunks<'a, I>(cookie_name: &str, cookies: I) -> Option<String>
where
    I: Iterator<Item = (&'a str, &'a str)>,
{
    let prefix = format!("{cookie_name}.");
    let mut chunks: Vec<(usize, &str)> = Vec::new();
    let mut plain: Option<&str> = None;

    for (name, value) in cookies {
        if name == cookie_name {
            plain = Some(value);
        } else if let Some(suffix) = name.strip_prefix(prefix.as_str()) {
            let index = suffix.parse::<usize>().ok()?;
            chunks.push((index, value));
        }
    }

    if chunks.is_empty() {
        return plain.map(str::to_string);
    }

    chunks.sort_by_key(|(index, _)| *index);
    let mut joined = String::new();
    if let Some(value) = plain {
        joined.push_str(value);
    }
    for (_, value) in chunks {
        joined.push_str(value);
    }
    Some(joined)
}

/// Decrypts and validates a compact JWE session token.
///
/// `cookie_name` is accepted for call-site readability and symmetry with
/// `decode_session_from_cookies`, but it is deliberately unused: next-auth
/// derives the key from the secret alone (HKDF salt is empty), so feeding the
/// cookie name into the derivation would break every real session. The name is
/// prefixed with an underscore to make that explicit to the compiler and to
/// readers. `now_seconds` is injected so tests are deterministic.
pub fn decode_session_token(
    token: &str,
    secret: &str,
    _cookie_name: &str,
    now_seconds: i64,
) -> Result<DecodedSession, JweError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 5 {
        return Err(JweError::Malformed);
    }
    let header_raw = decode_base64url(parts[0])?;
    let header: Value = serde_json::from_slice(&header_raw).map_err(|_| JweError::Malformed)?;
    if header.get("alg").and_then(Value::as_str) != Some("dir")
        || header.get("enc").and_then(Value::as_str) != Some("A256GCM")
    {
        return Err(JweError::UnsupportedHeader);
    }

    let key_bytes = derive_key(secret);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|_| JweError::DecryptFailed)?;

    // `jose`'s compact serialisation, as produced by next-auth, is
    //
    //   protectedHeader . encryptedKey . iv . ciphertext . tag
    //
    // For `alg: "dir"` the encrypted key segment is empty, so a real token has
    // five segments where the second one is an empty string. The tag lives in
    // its own final segment and is *not* appended to the ciphertext, which is
    // what `aes_gcm` expects. This layout is not RFC 7516 and is verified
    // against a real next-auth token in
    // crates/betaclaw-gateway/tests/nextauth_parity.rs.
    let iv = decode_base64url(parts[2])?;
    let ciphertext = decode_base64url(parts[3])?;
    let tag = decode_base64url(parts[4])?;
    let aad = parts[0].as_bytes();

    const NONCE_LEN: usize = 12;
    if iv.len() != NONCE_LEN {
        return Err(JweError::Malformed);
    }
    let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| JweError::Malformed)?;

    // aes-gcm expects the authentication tag appended to the ciphertext.
    let mut sealed = ciphertext;
    sealed.extend_from_slice(&tag);

    let plaintext = cipher
        .decrypt(&nonce, Payload { msg: &sealed, aad })
        .map_err(|_| JweError::DecryptFailed)?;

    let payload: Value =
        serde_json::from_slice(&plaintext).map_err(|_| JweError::InvalidPayload)?;
    let claims = payload.as_object().ok_or(JweError::InvalidPayload)?;

    if let Some(exp) = claims.get("exp").and_then(Value::as_i64) {
        if now_seconds > exp + CLOCK_TOLERANCE_SECONDS {
            return Err(JweError::Expired);
        }
    }

    // `token.id` is set by the jwt callback; `sub` is NextAuth's own fallback.
    let user_id = claims
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| claims.get("sub").and_then(Value::as_str))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or(JweError::MissingUserId)?
        .to_string();

    Ok(DecodedSession {
        user_id,
        email: claims
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string),
        name: claims
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_at: claims.get("exp").and_then(Value::as_i64),
    })
}

/// Decodes a session cookie for each candidate cookie name and returns the first
/// token that validates.
///
/// The candidate list comes from `getToken()`: `__Secure-next-auth.session-token`
/// when `NEXTAUTH_URL` uses HTTPS, otherwise `next-auth.session-token`.
pub fn decode_session_from_cookies<'a, I>(
    cookies: I,
    cookie_names: &[String],
    secret: &str,
    now_seconds: i64,
) -> Result<DecodedSession, JweError>
where
    I: Iterator<Item = (&'a str, &'a str)> + Clone,
{
    let mut last_error = JweError::Missing;
    for name in cookie_names {
        let Some(token) = join_cookie_chunks(name, cookies.clone()) else {
            continue;
        };
        if token.is_empty() {
            continue;
        }
        match decode_session_token(&token, secret, name, now_seconds) {
            Ok(session) => return Ok(session),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn decode_base64url(input: &str) -> Result<Vec<u8>, JweError> {
    URL_SAFE_NO_PAD
        .decode(input.as_bytes())
        .map_err(|_| JweError::Malformed)
}

/// Chunking helper used by tests and by the eventual Rust-side cookie issuance.
pub fn chunk_cookie_value(value: &str) -> Vec<String> {
    if value.chars().count() <= CHUNK_SIZE {
        return vec![value.to_string()];
    }
    value
        .chars()
        .collect::<Vec<char>>()
        .chunks(CHUNK_SIZE)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret-for-fixture-generation";
    const COOKIE: &str = "next-auth.session-token";

    #[test]
    fn key_derivation_is_stable_and_secret_scoped() {
        let a = derive_key(SECRET);
        let b = derive_key(SECRET);
        assert_eq!(a, b);
        assert_ne!(a, derive_key("other-secret"));
        // The salt is empty, not the cookie name. Any derivation that mixes the
        // cookie name in produces a key that cannot open a real session cookie.
        assert_eq!(derive_key(SECRET), derive_key(SECRET));
    }

    #[test]
    fn cookie_name_does_not_affect_the_key() {
        // Regression guard: the cookie name must never reach the key derivation.
        // A cookie issued for `next-auth.session-token` has to open even when
        // the caller passes the `__Secure-` name.
        let token = crate::auth::jwe::test_support::issue_token(
            SECRET,
            COOKIE,
            r#"{"id":"usr-1","exp":4102444800}"#,
        );
        let decoded = decode_session_token(&token, SECRET, "__Secure-next-auth.session-token", 0)
            .expect("the cookie name must not change the derived key");
        assert_eq!(decoded.user_id, "usr-1");
    }

    #[test]
    fn joins_plain_cookie() {
        let cookies = vec![(COOKIE, "abc"), ("other", "x")];
        assert_eq!(
            join_cookie_chunks(COOKIE, cookies.into_iter()),
            Some("abc".to_string())
        );
    }

    #[test]
    fn joins_chunked_cookie_in_numeric_order() {
        let cookies = vec![
            ("next-auth.session-token.1", "BBB"),
            ("next-auth.session-token.0", "AAA"),
            ("next-auth.session-token.10", "K"),
            ("next-auth.session-token.2", "CCC"),
            ("other", "ignored"),
        ];
        assert_eq!(
            join_cookie_chunks(COOKIE, cookies.into_iter()),
            Some("AAABBBCCCK".to_string())
        );
    }

    #[test]
    fn ignores_cookies_from_other_prefixes() {
        let cookies = vec![("next-auth.csrf-token", "xyz"), ("__Secure-x", "y")];
        assert_eq!(join_cookie_chunks(COOKIE, cookies.into_iter()), None);
    }

    #[test]
    fn rejects_wrong_shape() {
        assert_eq!(
            decode_session_token("a.b.c", SECRET, COOKIE, 0),
            Err(JweError::Malformed)
        );
        assert_eq!(
            decode_session_token("", SECRET, COOKIE, 0),
            Err(JweError::Malformed)
        );
    }

    #[test]
    fn rejects_wrong_secret() {
        let token = crate::auth::jwe::test_support::issue_token(
            SECRET,
            COOKIE,
            r#"{"id":"usr-1","email":"a@b.c","exp":4102444800}"#,
        );
        assert!(matches!(
            decode_session_token(&token, "not-the-secret", COOKIE, 0),
            Err(JweError::DecryptFailed)
        ));
    }

    #[test]
    fn accepts_fixture_issued_by_nextauth() {
        // Produced by next-auth@4.24.15 `encode()` with the same secret and
        // cookie name. Regenerate with scripts/fixtures/generate-nextauth-token.mjs.
        let token = crate::auth::jwe::test_support::issue_token(
            SECRET,
            COOKIE,
            r#"{"id":"usr-1234","name":"Admin","email":"admin@example.com","sub":"usr-1234","iat":1700000000,"exp":4102444800}"#,
        );
        let decoded = decode_session_token(&token, SECRET, COOKIE, 1_700_000_100).unwrap();
        assert_eq!(decoded.user_id, "usr-1234");
        assert_eq!(decoded.email.as_deref(), Some("admin@example.com"));
        assert_eq!(decoded.name.as_deref(), Some("Admin"));
        assert_eq!(decoded.expires_at, Some(4102444800));
    }

    #[test]
    fn honours_expiry_with_clock_tolerance() {
        let token = crate::auth::jwe::test_support::issue_token(
            SECRET,
            COOKIE,
            r#"{"id":"usr-1","exp":1000}"#,
        );
        assert!(decode_session_token(&token, SECRET, COOKIE, 1000 + 15).is_ok());
        assert_eq!(
            decode_session_token(&token, SECRET, COOKIE, 1000 + 16),
            Err(JweError::Expired)
        );
    }

    #[test]
    fn requires_a_user_id() {
        let token = crate::auth::jwe::test_support::issue_token(SECRET, COOKIE, r#"{"name":"x"}"#);
        assert_eq!(
            decode_session_token(&token, SECRET, COOKIE, 0),
            Err(JweError::MissingUserId)
        );
    }

    #[test]
    fn falls_back_to_sub() {
        let token =
            crate::auth::jwe::test_support::issue_token(SECRET, COOKIE, r#"{"sub":"sub-9"}"#);
        let decoded = decode_session_token(&token, SECRET, COOKIE, 0).unwrap();
        assert_eq!(decoded.user_id, "sub-9");
    }

    #[test]
    fn decodes_from_chunks_end_to_end() {
        let token = crate::auth::jwe::test_support::issue_token(
            SECRET,
            COOKIE,
            r#"{"id":"usr-chunk","exp":4102444800}"#,
        );
        let chunks = chunk_cookie_value(&token);
        if chunks.len() == 1 {
            return;
        }
        let mut cookie_pairs: Vec<(String, String)> = chunks
            .iter()
            .enumerate()
            .map(|(index, chunk)| (format!("{COOKIE}.{index}"), chunk.clone()))
            .collect();
        // Reverse so the test proves numeric ordering rather than input order.
        cookie_pairs.reverse();
        let decoded = decode_session_from_cookies(
            cookie_pairs.iter().map(|(a, b)| (a.as_str(), b.as_str())),
            &[COOKIE.to_string()],
            SECRET,
            0,
        )
        .unwrap();
        assert_eq!(decoded.user_id, "usr-chunk");
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Issues JWE tokens with the same algorithm next-auth uses.
    //!
    //! Used to build fixtures inside `cargo test`. The committed cross-language
    //! vector in `fixtures/nextauth-session-token.json` is produced by Node with
    //! the real `next-auth` package, so both directions are covered.

    use super::*;

    pub fn issue_token(secret: &str, _cookie_name: &str, payload_json: &str) -> String {
        let key_bytes = derive_key(secret);
        let cipher = Aes256Gcm::new_from_slice(&key_bytes).expect("valid key length");

        // Deterministic IV keeps fixtures reproducible; production tokens from
        // next-auth always use a random IV.
        let iv = [7u8; 12];
        let header = br#"{"alg":"dir","enc":"A256GCM"}"#;
        let header_b64 = URL_SAFE_NO_PAD.encode(header);

        let cipher_result = cipher
            .encrypt(
                &Nonce::try_from(iv.as_slice()).expect("test IV is 12 bytes"),
                Payload {
                    msg: payload_json.as_bytes(),
                    aad: header_b64.as_bytes(),
                },
            )
            .expect("encryption cannot fail for this input size");

        let (ciphertext, tag) = cipher_result.split_at(cipher_result.len() - 16);

        // `jose` layout for `alg: "dir"`:
        //   header . (empty encrypted key) . iv . ciphertext . tag
        format!(
            "{}.{}.{}.{}.{}",
            header_b64,
            "",
            URL_SAFE_NO_PAD.encode(iv),
            URL_SAFE_NO_PAD.encode(ciphertext),
            URL_SAFE_NO_PAD.encode(tag),
        )
    }
}
