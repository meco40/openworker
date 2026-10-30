//! Cross-language parity tests.
//!
//! These tests are the reason the Rust auth port can be trusted: they decrypt a
//! session cookie produced by the real `next-auth@4.24.15` package and assert
//! the Rust decoder returns the same identity. Regenerate the fixture with
//! `node scripts/fixtures/generate-nextauth-token.mjs`.

use std::collections::HashMap;

use betaclaw_core::auth::jwe::{
    chunk_cookie_value, decode_session_from_cookies, decode_session_token, join_cookie_chunks,
};

const FIXTURE: &str = include_str!("fixtures/nextauth-session-token.json");
const CSRF_FIXTURE: &str = include_str!("fixtures/nextauth-csrf.json");

#[derive(Debug, serde::Deserialize)]
struct CsrfFixture {
    secret: String,
    #[serde(rename = "csrfToken")]
    csrf_token: String,
    #[serde(rename = "csrfCookie")]
    csrf_cookie: String,
}

#[derive(Debug, serde::Deserialize)]
struct Fixture {
    #[serde(rename = "cookieName")]
    cookie_name: String,
    secret: String,
    #[serde(rename = "expectedUserId")]
    expected_user_id: String,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
    token: String,
    #[serde(rename = "csrfToken")]
    csrf_token: String,
    #[serde(rename = "csrfCookie")]
    csrf_cookie: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE).expect("fixture is valid JSON")
}

#[test]
fn decrypts_token_issued_by_real_nextauth() {
    let fixture = fixture();
    let decoded = decode_session_token(
        &fixture.token,
        &fixture.secret,
        &fixture.cookie_name,
        1_700_000_000,
    )
    .expect("Rust decoder must accept a token produced by next-auth");
    assert_eq!(decoded.user_id, fixture.expected_user_id);
    assert_eq!(decoded.email.as_deref(), Some("fixture@example.com"));
    assert_eq!(decoded.name.as_deref(), Some("Fixture Admin"));
    assert_eq!(decoded.expires_at, Some(fixture.expires_at));
}

#[test]
fn rejects_token_with_wrong_secret() {
    let fixture = fixture();
    assert!(decode_session_token(
        &fixture.token,
        "wrong-secret",
        &fixture.cookie_name,
        1_700_000_000
    )
    .is_err());
}

#[test]
fn cookie_name_does_not_change_the_derived_key() {
    // next-auth derives the key from the secret alone (`salt = ""`), so a token
    // opens regardless of which cookie name the caller reports. Pinning this
    // guards against reintroducing the cookie name into the salt or the info
    // string, which silently breaks every real session.
    let fixture = fixture();
    for name in [
        "next-auth.session-token",
        "__Secure-next-auth.session-token",
        "irrelevant-name",
    ] {
        let decoded = decode_session_token(&fixture.token, &fixture.secret, name, 1_700_000_000)
            .unwrap_or_else(|error| {
                panic!("cookie name {name} must not affect decoding: {error:?}")
            });
        assert_eq!(decoded.user_id, fixture.expected_user_id);
    }
}

#[test]
fn resolves_identity_through_the_cookie_header() {
    let fixture = fixture();
    let cookies = [(fixture.cookie_name.clone(), fixture.token.clone())];
    let decoded = decode_session_from_cookies(
        cookies
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
        std::slice::from_ref(&fixture.cookie_name),
        &fixture.secret,
        1_700_000_000,
    )
    .expect("cookie path must decode");
    assert_eq!(decoded.user_id, fixture.expected_user_id);
}

#[test]
fn resolves_identity_from_chunked_cookie() {
    let fixture = fixture();
    let _cookies = [(fixture.cookie_name.clone(), fixture.token.clone())];

    // The fixture token is well under the 3933 byte chunk size, so no chunking
    // happens for a real session. Chunk handling is covered separately by
    // `chunk_join_matches_nextauth_session_store` and by the round-trip below.
    assert_eq!(chunk_cookie_value(&fixture.token).len(), 1);

    // Re-chunk the token into two pieces and prove the join reconstructs it.
    let token = &fixture.token;
    let split_at = token.len() / 2;
    let cookies = [
        (
            format!("{}.1", fixture.cookie_name),
            token[split_at..].to_string(),
        ),
        (
            format!("{}.0", fixture.cookie_name),
            token[..split_at].to_string(),
        ),
    ];

    let decoded = decode_session_from_cookies(
        cookies
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
        std::slice::from_ref(&fixture.cookie_name),
        &fixture.secret,
        1_700_000_000,
    )
    .expect("a token split across two cookie chunks must reassemble");
    assert_eq!(decoded.user_id, fixture.expected_user_id);
}

#[test]
fn expired_token_is_rejected_within_clock_tolerance() {
    let fixture = fixture();
    let just_inside = fixture.expires_at + 15;
    assert!(decode_session_token(
        &fixture.token,
        &fixture.secret,
        &fixture.cookie_name,
        just_inside
    )
    .is_ok());

    let just_outside = fixture.expires_at + 16;
    assert!(decode_session_token(
        &fixture.token,
        &fixture.secret,
        &fixture.cookie_name,
        just_outside
    )
    .is_err());
}

#[test]
fn chunk_join_matches_nextauth_session_store() {
    let mut map: HashMap<&str, &str> = HashMap::new();
    map.insert("next-auth.session-token.10", "K");
    map.insert("next-auth.session-token.2", "C");
    map.insert("next-auth.session-token.0", "A");
    map.insert("next-auth.session-token.1", "B");
    map.insert("next-auth.csrf-token", "IGNORED");

    let joined = join_cookie_chunks("next-auth.session-token", map.iter().map(|(a, b)| (*a, *b)))
        .expect("chunks present");
    assert_eq!(joined, "ABCK");
}

#[test]
fn verifies_csrf_token_issued_by_real_nextauth() {
    let fixture = fixture();
    let (token, cookie) = (fixture.csrf_token, fixture.csrf_cookie);
    assert!(betaclaw_core::auth::verify_csrf_token(
        &fixture.secret,
        Some(&cookie.replace("%7C", "|").replace("%7c", "|")),
        Some(&token)
    ));
    assert!(!betaclaw_core::auth::verify_csrf_token(
        "wrong-secret",
        Some(&cookie.replace("%7C", "|").replace("%7c", "|")),
        Some(&token)
    ));
}

#[test]
fn verifies_dedicated_csrf_fixture_from_nextauth() {
    let fixture: CsrfFixture = serde_json::from_str(CSRF_FIXTURE).expect("valid csrf fixture");
    assert!(betaclaw_core::auth::verify_csrf_token(
        &fixture.secret,
        Some(&fixture.csrf_cookie.replace("%7C", "|").replace("%7c", "|")),
        Some(&fixture.csrf_token),
    ));
    assert!(!betaclaw_core::auth::verify_csrf_token(
        "wrong-secret",
        Some(&fixture.csrf_cookie.replace("%7C", "|").replace("%7c", "|")),
        Some(&fixture.csrf_token),
    ));
}

#[test]
fn rust_encoded_token_is_decodable_and_matches_claims() {
    let fixture = fixture();
    let exp = 2_100_000_000; // year 2036 so it is valid for next-auth decode tests
    let payload = serde_json::json!({
        "id": "usr-rust-issued",
        "sub": "usr-rust-issued",
        "name": "Rust User",
        "email": "rust@example.com",
        "iat": 1_700_000_000,
        "exp": exp,
    });
    let token = betaclaw_core::auth::encode_session_token(&fixture.secret, &payload.to_string())
        .expect("token encoding must succeed");

    let (csrf_token, csrf_cookie) = betaclaw_core::auth::create_csrf_token(&fixture.secret, None);
    let out_fixture = serde_json::json!({
        "csrfToken": csrf_token,
        "csrfCookie": csrf_cookie,
        "_comment": "Generated by rust nextauth_parity test. Decrypted by next-auth in vitest.",
        "secret": fixture.secret,
        "token": token,
        "expectedUserId": "usr-rust-issued",
        "expectedName": "Rust User",
        "expectedEmail": "rust@example.com",
    });
    let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/rust-session-token.json");
    if std::env::var("BETACLAW_WRITE_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(
            &fixture_path,
            serde_json::to_string_pretty(&out_fixture).unwrap(),
        )
        .expect("write fixture");
    } else {
        let committed: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&fixture_path).expect("Rust fixture must be checked in"),
        )
        .unwrap();
        let decoded = decode_session_token(
            committed["token"].as_str().unwrap(),
            &fixture.secret,
            &fixture.cookie_name,
            1_700_000_000,
        )
        .expect("committed Rust token");
        assert_eq!(decoded.user_id, "usr-rust-issued");
        assert!(betaclaw_core::auth::verify_csrf_token(
            &fixture.secret,
            committed["csrfCookie"].as_str(),
            committed["csrfToken"].as_str()
        ));
    }

    let decoded =
        decode_session_token(&token, &fixture.secret, &fixture.cookie_name, 1_700_000_000)
            .expect("must decode rust-issued token");
    assert_eq!(decoded.user_id, "usr-rust-issued");
    assert_eq!(decoded.email.as_deref(), Some("rust@example.com"));
    assert_eq!(decoded.name.as_deref(), Some("Rust User"));
    assert_eq!(decoded.expires_at, Some(exp));
}
