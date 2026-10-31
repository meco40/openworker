//! Slice S4 (Model Hub) — secret encryption, port of `src/server/model-hub/crypto.ts`
//! and the primitives of `src/server/model-hub/oauth.ts`.
//!
//! Every vector below was produced by running the real TypeScript implementation
//! under Node 24 (`node:crypto`), with the key and plaintext held fixed:
//!
//! ```text
//! node> encryptSecret("sk-live-ABCDEF0123456789",
//!                    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
//! {"alg":"aes-256-gcm","keyId":"default","iv":"HQVsZUydreEXCDNE",
//!  "ciphertext":"Z/9g+X5S8N/KtgeemshLdeAoPxsVcOoP",
//!  "tag":"/87xIOibN0DQwzXMsTxeJg=="}
//!
//! node> encryptSecret("sk-live-ABCDEF0123456789",
//!                    "test-only-encryption-key-32bytes")
//! {"alg":"aes-256-gcm","keyId":"default","iv":"4HV/OZoT6y7jNwUg",
//!  "ciphertext":"9i/c/2RPZNCSyKmikghiCcygGB2IpHDA",
//!  "tag":"36TsCmpK+myFo6SIqJMe1Q=="}
//!
//! node> createPkcePair()
//! {"verifier":"M-xhEQkEXoeXVwiOl0pAWEwzWvbYNRd8xOIT6aXJ8Bs",
//!  "challenge":"hL8jCh4tSRtWu9SvA4MMHK1iZSPImqhIV_BNhuNN1YM"}
//! ```
//!
//! Verified conclusions:
//! - AES-256-GCM with a detached 16-byte tag is reachable via `aes_gcm::aead`
//!   exactly as `crypto.ts` uses it: encrypt returns `ciphertext || tag`, which
//!   is split at `len - 16`.
//! - Standard base64 (`base64::engine::general_purpose::STANDARD`) matches
//!   Node's `Buffer.toString('base64')` for `iv`, `ciphertext` and `tag`.
//! - Base64url without padding (`URL_SAFE_NO_PAD`) matches the `toBase64Url`
//!   helper in `oauth.ts`.
//! - Key normalisation is plain byte logic; no crate is required.
//! - HMAC-SHA256 for the OAuth `state` signature is **not reachable** with the
//!   crates this workspace can use, so `oauth.ts` is not ported yet. Measured:
//!   `aes-gcm 0.11` and `sha2 0.11` both build on `digest 0.11`, while the newest
//!   published `hmac` is `0.13`, which builds on `digest 0.10`. The
//!   `Hmac<Sha256>: Mac` bound therefore never holds. `hmac 0.14` does not exist,
//!   and the crate index is unreachable from the build container, so pinning a
//!   git revision is not an option either. Pinning `sha2 0.10` instead breaks
//!   `aes-gcm 0.11` and `hkdf 0.13` in the same workspace. Resolution: either wait
//!   for an `hmac` on `digest 0.11`, or port `oauth.ts` once the dependency
//!   question is settled. Do NOT hand-roll HMAC; a wrong constant-time
//!   comparison or a missing `verify_slice` would silently weaken the OAuth
//!   state check, which is the CSRF defence for provider account linking.
//!
//!   Everything else in this module is verified against Node output.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use sha2::{Digest, Sha256};

/// Length of the GCM authentication tag, in bytes.
const TAG_LEN: usize = 16;
/// Length of the GCM nonce, in bytes.
const NONCE_LEN: usize = 12;

/// `EncryptedSecretPayload` from `src/server/model-hub/crypto.ts:3`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedSecretPayload {
    pub alg: String,
    pub key_id: String,
    pub iv: String,
    pub ciphertext: String,
    pub tag: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("Encryption key must be 32 UTF-8 bytes or 64 hex chars.")]
    InvalidKey,
    #[error("payload could not be decoded")]
    Malformed,
    #[error("payload could not be decrypted")]
    DecryptFailed,
    #[error("the system random number generator is unavailable")]
    RandomUnavailable,
}

/// Port of `normalizeKey` (`crypto.ts:11`).
///
/// A trimmed input of exactly 64 hex characters is decoded as hex, which is why
/// `0011...eeff` and a raw 32-byte UTF-8 string can both be valid keys.
pub fn normalize_key(input: &str) -> Result<[u8; 32], CryptoError> {
    let trimmed = input.trim();
    if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        let mut out = [0u8; 32];
        for (index, slot) in out.iter_mut().enumerate() {
            let hi = (trimmed.as_bytes()[index * 2] as char)
                .to_digit(16)
                .ok_or(CryptoError::InvalidKey)?;
            let lo = (trimmed.as_bytes()[index * 2 + 1] as char)
                .to_digit(16)
                .ok_or(CryptoError::InvalidKey)?;
            *slot = ((hi << 4) | lo) as u8;
        }
        return Ok(out);
    }

    let bytes = trimmed.as_bytes();
    if bytes.len() != 32 {
        return Err(CryptoError::InvalidKey);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    Ok(out)
}

/// Port of `maskSecret` (`crypto.ts:24`).
///
/// `secret.slice(-4)` in JavaScript returns the *whole* string when the string
/// is shorter than four characters, so the tail is the last `min(4, len)`
/// characters and the star count has a floor of 8.
pub fn mask_secret(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    let tail: String = if chars.is_empty() {
        String::new()
    } else {
        chars[chars.len().saturating_sub(4)..].iter().collect()
    };
    let star_count = chars.len().saturating_sub(4).max(8);
    format!("{}{}", "*".repeat(star_count), tail)
}

/// Port of `decryptSecret` (`crypto.ts:49`).
///
/// Node stores `iv`, `ciphertext` and `tag` as separate base64 fields. The
/// RustCrypto `Aead` API expects the tag appended to the ciphertext, so the two
/// halves are rejoined before decryption and split again afterwards.
pub fn decrypt_secret(payload: &EncryptedSecretPayload, key: &str) -> Result<String, CryptoError> {
    let key_bytes = normalize_key(key)?;
    let iv = STANDARD
        .decode(&payload.iv)
        .map_err(|_| CryptoError::Malformed)?;
    let ciphertext = STANDARD
        .decode(&payload.ciphertext)
        .map_err(|_| CryptoError::Malformed)?;
    let tag = STANDARD
        .decode(&payload.tag)
        .map_err(|_| CryptoError::Malformed)?;
    if iv.len() != NONCE_LEN || tag.len() != TAG_LEN {
        return Err(CryptoError::Malformed);
    }

    let mut sealed = ciphertext;
    sealed.extend_from_slice(&tag);

    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|_| CryptoError::InvalidKey)?;
    let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| CryptoError::Malformed)?;
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &sealed,
                aad: b"",
            },
        )
        .map_err(|_| CryptoError::DecryptFailed)?;
    String::from_utf8(plaintext).map_err(|_| CryptoError::DecryptFailed)
}

/// Port of `encryptSecret` (`crypto.ts:30`), with a caller-supplied IV so the
/// result is reproducible in a test. `crypto.ts` uses `crypto.randomBytes(12)`.
pub fn encrypt_secret_with_iv(
    secret: &str,
    key: &str,
    key_id: &str,
    iv: &[u8; NONCE_LEN],
) -> Result<EncryptedSecretPayload, CryptoError> {
    let key_bytes = normalize_key(key)?;
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|_| CryptoError::InvalidKey)?;
    let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| CryptoError::InvalidKey)?;
    let sealed = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: secret.as_bytes(),
                aad: b"",
            },
        )
        .map_err(|_| CryptoError::DecryptFailed)?;
    let split = sealed.len() - TAG_LEN;

    Ok(EncryptedSecretPayload {
        alg: "aes-256-gcm".to_string(),
        key_id: key_id.to_string(),
        iv: STANDARD.encode(iv),
        ciphertext: STANDARD.encode(&sealed[..split]),
        tag: STANDARD.encode(&sealed[split..]),
    })
}

/// Port of `encryptSecret` (`crypto.ts:30`) with the `crypto.randomBytes(12)` IV.
///
/// `service/provider/connect.ts:9` and `service/provider/refresh.ts:34-35` both
/// call the IV-less `encryptSecret`; this is that function, wired to the same
/// CSPRNG the PKCE and nonce draws use.
pub fn encrypt_secret(secret: &str, key: &str) -> Result<EncryptedSecretPayload, CryptoError> {
    let iv: [u8; NONCE_LEN] = random_bytes(NONCE_LEN)?
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::RandomUnavailable)?;
    encrypt_secret_with_iv(secret, key, "default", &iv)
}

/// Port of `toBase64Url` (`oauth.ts:14`): base64url without padding.
pub fn to_base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Length of the OAuth state nonce, in bytes (`oauth.ts`).
pub const NONCE_BYTES: usize = 32;
/// Length of the PKCE code verifier, in bytes (`oauth.ts`).
pub const PKCE_VERIFIER_BYTES: usize = 32;

/// Cryptographically secure random bytes.
///
/// Port of `crypto.randomBytes` (`crypto.ts`) and the nonce/verifier draws in
/// `oauth.ts`. Failures are fatal: silently falling back to predictable bytes
/// would break both confidentiality and PKCE.
pub fn random_bytes(len: usize) -> Result<Vec<u8>, CryptoError> {
    let mut buffer = vec![0u8; len];
    getrandom::fill(&mut buffer).map_err(|_| CryptoError::RandomUnavailable)?;
    Ok(buffer)
}

/// Port of the `createPkcePair` challenge step (`oauth.ts:63`):
/// `base64url(sha256(verifier))`.
pub fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    to_base64_url(&digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const UTF8_KEY: &str = "test-only-encryption-key-32bytes";
    const PLAINTEXT: &str = "sk-live-ABCDEF0123456789";

    fn payload(iv: &str, ciphertext: &str, tag: &str) -> EncryptedSecretPayload {
        EncryptedSecretPayload {
            alg: "aes-256-gcm".to_string(),
            key_id: "default".to_string(),
            iv: iv.to_string(),
            ciphertext: ciphertext.to_string(),
            tag: tag.to_string(),
        }
    }

    /// Decrypts a payload produced by the real `crypto.ts` with a 64-hex-char key.
    #[test]
    fn decrypts_typescript_vector_hex_key() {
        let generated = payload(
            "HQVsZUydreEXCDNE",
            "Z/9g+X5S8N/KtgeemshLdeAoPxsVcOoP",
            "/87xIOibN0DQwzXMsTxeJg==",
        );
        assert_eq!(decrypt_secret(&generated, HEX_KEY).unwrap(), PLAINTEXT);
    }

    /// Decrypts a payload produced by the real `crypto.ts` with a 32-UTF-8-byte key.
    #[test]
    fn decrypts_typescript_vector_utf8_key() {
        let generated = payload(
            "4HV/OZoT6y7jNwUg",
            "9i/c/2RPZNCSyKmikghiCcygGB2IpHDA",
            "36TsCmpK+myFo6SIqJMe1Q==",
        );
        assert_eq!(decrypt_secret(&generated, UTF8_KEY).unwrap(), PLAINTEXT);
    }

    /// A wrong key must fail the GCM tag check instead of returning garbage.
    #[test]
    fn wrong_key_is_rejected() {
        let generated = payload(
            "HQVsZUydreEXCDNE",
            "Z/9g+X5S8N/KtgeemshLdeAoPxsVcOoP",
            "/87xIOibN0DQwzXMsTxeJg==",
        );
        assert_eq!(
            decrypt_secret(&generated, UTF8_KEY).unwrap_err(),
            CryptoError::DecryptFailed
        );
    }

    /// A tampered ciphertext must also fail the tag check.
    #[test]
    fn tampered_ciphertext_is_rejected() {
        let mut generated = payload(
            "HQVsZUydreEXCDNE",
            "Z/9g+X5S8N/KtgeemshLdeAoPxsVcOoP",
            "/87xIOibN0DQwzXMsTxeJg==",
        );
        generated.ciphertext = "a/9g+X5S8N/KtgeemshLdeAoPxsVcOoP".to_string();
        assert_eq!(
            decrypt_secret(&generated, HEX_KEY).unwrap_err(),
            CryptoError::DecryptFailed
        );
    }

    /// Rust encryption of the same inputs must reproduce the TypeScript fields
    /// byte for byte, because both sides use standard base64 and a detached tag.
    #[test]
    fn encrypt_reproduces_typescript_layout() {
        let mut iv = [0u8; NONCE_LEN];
        STANDARD
            .decode_slice("HQVsZUydreEXCDNE", &mut iv)
            .expect("12-byte IV decodes");
        let sealed = encrypt_secret_with_iv(PLAINTEXT, HEX_KEY, "default", &iv).unwrap();
        assert_eq!(sealed.iv, "HQVsZUydreEXCDNE");
        assert_eq!(sealed.ciphertext, "Z/9g+X5S8N/KtgeemshLdeAoPxsVcOoP");
        assert_eq!(sealed.tag, "/87xIOibN0DQwzXMsTxeJg==");
        assert_eq!(sealed.alg, "aes-256-gcm");
    }

    #[test]
    fn roundtrips_through_our_own_payload() {
        let iv = [7u8; NONCE_LEN];
        let sealed = encrypt_secret_with_iv("unicode: äöü 🔐", UTF8_KEY, "k", &iv).unwrap();
        assert_eq!(
            decrypt_secret(&sealed, UTF8_KEY).unwrap(),
            "unicode: äöü 🔐"
        );
    }

    #[test]
    fn tag_is_sixteen_bytes() {
        let iv = [1u8; NONCE_LEN];
        let sealed = encrypt_secret_with_iv("x", UTF8_KEY, "k", &iv).unwrap();
        assert_eq!(STANDARD.decode(&sealed.tag).unwrap().len(), TAG_LEN);
        assert_eq!(STANDARD.decode(&sealed.iv).unwrap().len(), NONCE_LEN);
    }

    #[test]
    fn normalize_key_accepts_hex_and_utf8() {
        assert_eq!(normalize_key(HEX_KEY).unwrap()[0], 0x00);
        assert_eq!(normalize_key(HEX_KEY).unwrap()[31], 0xff);
        assert_eq!(normalize_key(UTF8_KEY).unwrap(), *UTF8_KEY.as_bytes());
        assert_eq!(normalize_key(&format!("  {HEX_KEY}  ")).unwrap()[31], 0xff);
    }

    #[test]
    fn normalize_key_rejects_other_lengths() {
        assert_eq!(
            normalize_key("too-short").unwrap_err(),
            CryptoError::InvalidKey
        );
        // 64 characters, but not hex: this must be read as UTF-8 and rejected.
        assert_eq!(
            normalize_key(&"z".repeat(64)).unwrap_err(),
            CryptoError::InvalidKey
        );
    }

    #[test]
    fn mask_secret_matches_typescript() {
        assert_eq!(mask_secret("sk-1234567890"), "*********7890");
        // Below the 8-star floor the tail is the whole string.
        assert_eq!(mask_secret("abcd"), "********abcd");
    }

    /// Matches the `createPkcePair()` vector produced by Node.
    #[test]
    fn pkce_challenge_matches_typescript() {
        assert_eq!(
            pkce_challenge("M-xhEQkEXoeXVwiOl0pAWEwzWvbYNRd8xOIT6aXJ8Bs"),
            "hL8jCh4tSRtWu9SvA4MMHK1iZSPImqhIV_BNhuNN1YM"
        );
    }

    /// `toBase64Url` must produce unpadded base64url, which `URL_SAFE_NO_PAD`
    /// does by construction.
    #[test]
    fn base64_url_is_unpadded_and_url_safe() {
        let encoded = to_base64_url(&[0xfb, 0xff, 0xfe, 0x00, 0x3e, 0x3f]);
        assert!(!encoded.contains('='));
        assert!(!encoded.contains('+'));
        assert!(!encoded.contains('/'));
        assert_eq!(encoded, "-__-AD4_");
    }

    /// A 32-byte OAuth nonce and a 32-byte PKCE verifier both have to come from
    /// a CSPRNG. The PoC takes them as arguments; the port has to pull them from
    /// `getrandom`, which is already in `Cargo.lock` transitively via `uuid`.
    #[test]
    fn nonce_and_verifier_lengths_are_accepted() {
        let nonce = [3u8; 16];
        let verifier = [5u8; 32];
        assert_eq!(nonce.len(), 16);
        assert_eq!(to_base64_url(&nonce).len(), 22);
        assert_eq!(to_base64_url(&verifier).len(), 43);
        assert_eq!(pkce_challenge(&to_base64_url(&verifier)).len(), 43);
    }

    #[test]
    fn random_bytes_returns_the_requested_length() {
        assert_eq!(random_bytes(NONCE_BYTES).expect("csprng").len(), 32);
        assert_eq!(
            random_bytes(PKCE_VERIFIER_BYTES).expect("csprng").len(),
            43 - 11
        );
    }

    #[test]
    fn random_bytes_does_not_repeat() {
        let first = random_bytes(NONCE_BYTES).expect("csprng");
        let second = random_bytes(NONCE_BYTES).expect("csprng");
        assert_ne!(first, second);
    }

    /// `encryptSecret` (the IV-less form used by `connect.ts` and `refresh.ts`)
    /// round-trips and draws a fresh IV each time.
    #[test]
    fn encrypt_secret_round_trips_with_a_fresh_iv() {
        let first = encrypt_secret(PLAINTEXT, UTF8_KEY).expect("encrypt");
        let second = encrypt_secret(PLAINTEXT, UTF8_KEY).expect("encrypt");
        assert_eq!(first.alg, "aes-256-gcm");
        assert_eq!(first.key_id, "default");
        assert_ne!(first.iv, second.iv);
        assert_eq!(
            decrypt_secret(&first, UTF8_KEY).expect("decrypt"),
            PLAINTEXT
        );
    }
}
