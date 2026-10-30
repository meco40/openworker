//! CSRF token creation and verification matching next-auth v4.24.15 (`core/lib/csrf-token.js`).
//!
//! Format: `token|sha256(token + secret)`
//! where `token` is 32 random bytes represented as 64 hex characters.

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Computes the expected SHA-256 hash for a given CSRF token and secret.
fn compute_csrf_hash(token: &str, secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.update(secret.as_bytes());
    let result = hasher.finalize();
    hex_encode(&result)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}

/// Generates a new 32-byte (64 hex characters) random CSRF token.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    let _ = getrandom::fill(&mut bytes);
    hex_encode(&bytes)
}

/// Creates or reuses a CSRF token.
///
/// If `cookie_value` contains a valid `token|hash` pair matching `secret`,
/// that token is reused. Otherwise, a fresh token is generated.
/// Returns `(token, cookie_value)`.
pub fn create_csrf_token(secret: &str, cookie_value: Option<&str>) -> (String, String) {
    if let Some(cookie) = cookie_value {
        if let Some((token, hash)) = cookie.split_once('|') {
            if token.len() == 64 && hash.len() == 64 {
                let expected = compute_csrf_hash(token, secret);
                if hash.as_bytes().ct_eq(expected.as_bytes()).into() {
                    return (token.to_string(), cookie.to_string());
                }
            }
        }
    }

    let token = generate_token();
    let hash = compute_csrf_hash(&token, secret);
    let cookie = format!("{token}|{hash}");
    (token, cookie)
}

/// Verifies that the CSRF token in the request body matches the token in the cookie,
/// and that the cookie hash is valid for the given secret, in constant time.
pub fn verify_csrf_token(
    secret: &str,
    cookie_value: Option<&str>,
    body_token: Option<&str>,
) -> bool {
    let Some(cookie) = cookie_value else {
        return false;
    };
    let Some(body) = body_token else {
        return false;
    };
    let Some((token, hash)) = cookie.split_once('|') else {
        return false;
    };

    let expected_hash = compute_csrf_hash(token, secret);
    let hash_valid: bool = hash.as_bytes().ct_eq(expected_hash.as_bytes()).into();
    let token_valid: bool = token.as_bytes().ct_eq(body.as_bytes()).into();

    hash_valid && token_valid
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret-123";

    #[test]
    fn creates_and_verifies_csrf_token() {
        let (token, cookie) = create_csrf_token(SECRET, None);
        assert_eq!(token.len(), 64);
        assert!(cookie.starts_with(&token));

        assert!(verify_csrf_token(SECRET, Some(&cookie), Some(&token)));
        assert!(!verify_csrf_token(
            SECRET,
            Some(&cookie),
            Some("wrong-token")
        ));
        assert!(!verify_csrf_token(
            "wrong-secret",
            Some(&cookie),
            Some(&token)
        ));
        assert!(!verify_csrf_token(SECRET, None, Some(&token)));
        assert!(!verify_csrf_token(SECRET, Some(&cookie), None));
    }

    #[test]
    fn reuses_valid_csrf_token() {
        let (token1, cookie1) = create_csrf_token(SECRET, None);
        let (token2, cookie2) = create_csrf_token(SECRET, Some(&cookie1));
        assert_eq!(token1, token2);
        assert_eq!(cookie1, cookie2);
    }

    #[test]
    fn replaces_invalid_csrf_token() {
        let (token, cookie) = create_csrf_token(SECRET, Some("malformed-cookie"));
        assert_ne!(cookie, "malformed-cookie");
        assert!(verify_csrf_token(SECRET, Some(&cookie), Some(&token)));
    }
}
