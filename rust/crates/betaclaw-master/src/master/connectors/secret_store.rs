//! Port of `src/server/master/connectors/secretStore.ts:1-85`.
//!
//! AES-256-GCM at-rest encryption for connector secrets. The payload format is
//! `enc:v2:<iv>:<tag>:<ciphertext>` (all base64url) with a 12-byte IV and a
//! detached 16-byte tag; the legacy `enc:v1:` format is a plain base64url blob.
//!
//! # Key resolution and the S4 crypto primitives (OP-S9-18)
//!
//! `resolveSecretKey` (`secretStore.ts:10-29`) reads
//! `BETACLAW_MASTER_SECRET_KEY`, tries a 32-byte base64, then a 32-byte hex and
//! finally hashes the string; with no key configured it hashes
//! `betaclaw-master:<cwd>`. Node's `Buffer.from(x, 'base64'/'hex')` are *lenient*
//! — invalid characters are skipped and a trailing lone character is dropped —
//! so [`node_base64_decode`] and [`node_hex_decode`] reproduce that instead of a
//! strict decoder. The `aes_gcm` cipher, the CSPRNG ([`random_bytes`]) and the
//! base64url encoder ([`to_base64_url`]) are the S4 Model-Hub primitives, so the
//! crate gains no second crypto path.

use std::sync::OnceLock;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::master::feature_flags::MasterEnv;
use crate::master::repository::helpers::now_iso;
use crate::master::repository::secrets_store::MasterConnectorSecretInput;
use crate::master::repository::MasterRepository;
use crate::master::types::{MasterConnectorSecret, WorkspaceScope};
use crate::model_hub::crypto::{random_bytes, to_base64_url, CryptoError};

/// `SECRET_PREFIX` from `secretStore.ts:5`.
const SECRET_PREFIX: &str = "enc:v1:";
/// `SECRET_PREFIX_V2` from `secretStore.ts:6`.
const SECRET_PREFIX_V2: &str = "enc:v2:";

/// The two explicit `throw`s plus the wrapped S4/rusqlite errors.
#[derive(Debug, thiserror::Error)]
pub enum ConnectorSecretError {
    #[error("Unsupported secret format.")]
    UnsupportedFormat,
    #[error("payload could not be encrypted")]
    EncryptFailed,
    #[error("payload could not be decrypted")]
    DecryptFailed,
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    #[error(transparent)]
    Repository(#[from] rusqlite::Error),
}

/// The process-wide cached key of `resolveSecretKey` (`secretStore.ts:8,11`).
///
/// The environment and the working directory are captured once; the resolved key
/// is memoised exactly like the module-level `cachedSecretKey`.
pub struct SecretKeyResolver {
    configured: String,
    cwd: String,
    cached: OnceLock<[u8; 32]>,
}

impl SecretKeyResolver {
    /// Reads `BETACLAW_MASTER_SECRET_KEY` from `env` and `process.cwd()` from
    /// `cwd`.
    pub fn new(env: &MasterEnv, cwd: impl Into<String>) -> Self {
        Self {
            configured: env
                .get("BETACLAW_MASTER_SECRET_KEY")
                .map(String::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
            cwd: cwd.into(),
            cached: OnceLock::new(),
        }
    }

    /// `resolveSecretKey` — `secretStore.ts:10-29`.
    pub fn resolve(&self) -> [u8; 32] {
        *self.cached.get_or_init(|| {
            if !self.configured.is_empty() {
                let base64_candidate = node_base64_decode(&self.configured);
                if base64_candidate.len() == 32 {
                    return to_key(&base64_candidate);
                }
                let hex_candidate = node_hex_decode(&self.configured);
                if hex_candidate.len() == 32 {
                    return to_key(&hex_candidate);
                }
                return sha256(&self.configured);
            }
            sha256(&format!("betaclaw-master:{}", self.cwd))
        })
    }
}

fn to_key(bytes: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    key.copy_from_slice(bytes);
    key
}

fn sha256(value: &str) -> [u8; 32] {
    let digest = Sha256::digest(value.as_bytes());
    to_key(&digest)
}

/// `Buffer.from(input, 'base64').length` semantics, lenient like Node.
fn node_base64_decode(input: &str) -> Vec<u8> {
    let mut data: Vec<u8> = input
        .bytes()
        .filter(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
        .collect();
    if data.len() % 4 == 1 {
        data.pop();
    }
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(&data)
        .unwrap_or_default()
}

/// `Buffer.from(input, 'hex')` semantics: stop at the first non-hex character,
/// drop a trailing lone nibble.
fn node_hex_decode(input: &str) -> Vec<u8> {
    let mut nibbles = Vec::new();
    for byte in input.bytes() {
        let Some(value) = (byte as char).to_digit(16) else {
            break;
        };
        nibbles.push(value as u8);
    }
    nibbles
        .chunks_exact(2)
        .map(|pair| (pair[0] << 4) | pair[1])
        .collect()
}

/// `Buffer.from(input, 'base64url')` semantics, lenient like Node.
fn node_base64url_decode(input: &str) -> Vec<u8> {
    let mut data: Vec<u8> = input
        .bytes()
        .filter(|byte| byte.is_ascii_alphanumeric() || *byte == b'-' || *byte == b'_')
        .collect();
    if data.len() % 4 == 1 {
        data.pop();
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&data)
        .unwrap_or_default()
}

/// `JSON.stringify(value)` for a string, used by the audit metadata.
pub(crate) fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// `JSON.stringify(expiresAt)` where `undefined`/`null` render as `null`.
pub(crate) fn expires_at_json(expires_at: Option<&str>) -> String {
    match expires_at {
        Some(value) => json_string(value),
        None => "null".to_string(),
    }
}

/// `encryptConnectorSecret` — `secretStore.ts:31-38`.
pub fn encrypt_connector_secret(
    resolver: &SecretKeyResolver,
    plain_text: &str,
) -> Result<String, ConnectorSecretError> {
    let key = resolver.resolve();
    let iv = random_bytes(12)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| ConnectorSecretError::EncryptFailed)?;
    let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| ConnectorSecretError::EncryptFailed)?;
    let sealed = cipher
        .encrypt(&nonce, plain_text.as_bytes())
        .map_err(|_| ConnectorSecretError::EncryptFailed)?;
    let split = sealed.len().saturating_sub(16);
    let (ciphertext, tag) = sealed.split_at(split);
    Ok(format!(
        "{SECRET_PREFIX_V2}{}:{}:{}",
        to_base64_url(&iv),
        to_base64_url(tag),
        to_base64_url(ciphertext)
    ))
}

/// `decryptConnectorSecret` — `secretStore.ts:40-60`.
///
/// The `enc:v2` branch splits the payload on `:` and requires exactly three
/// parts; anything else is the source's `Unsupported secret format.` The legacy
/// `enc:v1` branch is a plain base64url payload, not encrypted.
pub fn decrypt_connector_secret(
    resolver: &SecretKeyResolver,
    cipher_text: &str,
) -> Result<String, ConnectorSecretError> {
    if let Some(payload) = cipher_text.strip_prefix(SECRET_PREFIX_V2) {
        let parts: Vec<&str> = payload.split(':').collect();
        if parts.len() != 3 {
            return Err(ConnectorSecretError::UnsupportedFormat);
        }
        let iv = node_base64url_decode(parts[0]);
        let tag = node_base64url_decode(parts[1]);
        let encrypted = node_base64url_decode(parts[2]);
        if iv.len() != 12 {
            return Err(ConnectorSecretError::DecryptFailed);
        }
        let cipher = Aes256Gcm::new_from_slice(&resolver.resolve())
            .map_err(|_| ConnectorSecretError::DecryptFailed)?;
        let nonce =
            Nonce::try_from(iv.as_slice()).map_err(|_| ConnectorSecretError::DecryptFailed)?;
        let mut joined = encrypted;
        joined.extend_from_slice(&tag);
        let decrypted = cipher
            .decrypt(&nonce, joined.as_ref())
            .map_err(|_| ConnectorSecretError::DecryptFailed)?;
        return Ok(String::from_utf8_lossy(&decrypted).into_owned());
    }

    if !cipher_text.starts_with(SECRET_PREFIX) {
        return Err(ConnectorSecretError::UnsupportedFormat);
    }
    let decoded = node_base64url_decode(&cipher_text[SECRET_PREFIX.len()..]);
    Ok(String::from_utf8_lossy(&decoded).into_owned())
}

/// `input` of `storeConnectorSecret` — `secretStore.ts:62-65`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreConnectorSecretInput {
    pub provider: String,
    pub key_ref: String,
    pub plain_text: String,
    pub expires_at: Option<String>,
}

/// `storeConnectorSecret` — `secretStore.ts:62-85`.
///
/// Encrypts, upserts with `issuedAt = now` and `revokedAt = null`, and appends
/// the `store` audit event whose metadata is `{ provider, keyRef, expiresAt }`.
pub fn store_connector_secret(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    resolver: &SecretKeyResolver,
    input: &StoreConnectorSecretInput,
) -> Result<MasterConnectorSecret, ConnectorSecretError> {
    let stored = repo.upsert_connector_secret(
        scope,
        &MasterConnectorSecretInput {
            provider: input.provider.clone(),
            key_ref: input.key_ref.clone(),
            encrypted_payload: encrypt_connector_secret(resolver, &input.plain_text)?,
            issued_at: Some(now_iso()),
            expires_at: input.expires_at.clone(),
            revoked_at: None,
        },
    )?;
    let metadata = format!(
        "{{\"provider\":{},\"keyRef\":{},\"expiresAt\":{}}}",
        json_string(&input.provider),
        json_string(&input.key_ref),
        expires_at_json(input.expires_at.as_deref()),
    );
    repo.append_audit_event(
        scope,
        &crate::master::repository::audit_store::MasterAuditEventInput {
            category: "connector_secret".to_string(),
            action: "store".to_string(),
            metadata,
        },
    )?;
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn resolver_from(key: &str) -> SecretKeyResolver {
        let mut env = MasterEnv::new();
        env.insert("BETACLAW_MASTER_SECRET_KEY".to_string(), key.to_string());
        SecretKeyResolver::new(&env, "/ws")
    }

    fn fixed_key() -> [u8; 32] {
        let mut key = [0u8; 32];
        for (index, slot) in key.iter_mut().enumerate() {
            *slot = index as u8;
        }
        key
    }

    fn encoded_key() -> String {
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(fixed_key())
    }

    #[test]
    fn a_base64_key_resolves_to_its_bytes() {
        assert_eq!(resolver_from(&encoded_key()).resolve(), fixed_key());
    }

    #[test]
    fn a_hex_key_resolves_to_its_bytes() {
        let encoded = fixed_key()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(resolver_from(&encoded).resolve(), fixed_key());
    }

    #[test]
    fn without_a_key_it_hashes_the_cwd_fallback() {
        let resolver = SecretKeyResolver::new(&MasterEnv::new(), "/ws");
        let expected: [u8; 32] = Sha256::digest(b"betaclaw-master:/ws").into();
        assert_eq!(resolver.resolve(), expected);
    }

    #[test]
    fn encrypt_then_decrypt_round_trips() {
        let resolver = resolver_from(&encoded_key());
        let payload = encrypt_connector_secret(&resolver, "hunter2").unwrap();
        assert!(payload.starts_with("enc:v2:"));
        assert_eq!(
            decrypt_connector_secret(&resolver, &payload).unwrap(),
            "hunter2"
        );
    }

    #[test]
    fn the_legacy_v1_payload_is_plain_base64url() {
        let resolver = SecretKeyResolver::new(&MasterEnv::new(), "/ws");
        let payload = format!(
            "enc:v1:{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("legacy")
        );
        assert_eq!(
            decrypt_connector_secret(&resolver, &payload).unwrap(),
            "legacy"
        );
    }

    #[test]
    fn the_unsupported_format_message_is_verbatim() {
        let resolver = SecretKeyResolver::new(&MasterEnv::new(), "/ws");
        assert_eq!(
            decrypt_connector_secret(&resolver, "plain text")
                .unwrap_err()
                .to_string(),
            "Unsupported secret format."
        );
        assert_eq!(
            decrypt_connector_secret(&resolver, "enc:v2:a:b")
                .unwrap_err()
                .to_string(),
            "Unsupported secret format."
        );
    }

    #[test]
    fn a_tampered_payload_fails_to_decrypt() {
        let resolver = resolver_from(&encoded_key());
        let payload = encrypt_connector_secret(&resolver, "hunter2").unwrap();
        let mut tampered: Vec<char> = payload.chars().collect();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == 'A' { 'B' } else { 'A' };
        let tampered: String = tampered.into_iter().collect();
        assert!(decrypt_connector_secret(&resolver, &tampered).is_err());
    }

    #[test]
    fn node_lenient_decoders_skip_invalid_characters() {
        // `Buffer.from('AQ ID', 'base64')` drops the space.
        assert_eq!(node_base64_decode("AQ ID"), vec![1, 2, 3]);
        // A lone trailing character carries no byte.
        assert_eq!(node_base64_decode("AQIDB"), vec![1, 2, 3]);
        // Hex stops at the first non-hex character and drops a lone nibble.
        assert_eq!(node_hex_decode("0102zz"), vec![1, 2]);
        assert_eq!(node_hex_decode("01020"), vec![1, 2]);
    }

    #[test]
    fn store_writes_the_row_and_the_audit_event() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let resolver = resolver_from(&encoded_key());
        let stored = store_connector_secret(
            &repo,
            &scope,
            &resolver,
            &StoreConnectorSecretInput {
                provider: "gmail".to_string(),
                key_ref: "default".to_string(),
                plain_text: "token".to_string(),
                expires_at: Some("2026-01-02T00:00:00.000Z".to_string()),
            },
        )
        .unwrap();
        assert!(stored.encrypted_payload.starts_with("enc:v2:"));
        assert!(stored.issued_at.is_some());
        assert!(stored.revoked_at.is_none());
        let read = repo
            .get_connector_secret(&scope, "gmail", "default")
            .unwrap()
            .expect("stored");
        assert_eq!(
            decrypt_connector_secret(&resolver, &read.encrypted_payload).unwrap(),
            "token"
        );
        let audit = repo.list_audit_events(&scope, 10).unwrap();
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].category, "connector_secret");
        assert_eq!(audit[0].action, "store");
        assert_eq!(
            audit[0].metadata,
            "{\"provider\":\"gmail\",\"keyRef\":\"default\",\"expiresAt\":\"2026-01-02T00:00:00.000Z\"}"
        );
    }

    #[test]
    fn store_without_expiry_writes_null() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        let resolver = resolver_from(&encoded_key());
        store_connector_secret(
            &repo,
            &scope,
            &resolver,
            &StoreConnectorSecretInput {
                provider: "gmail".to_string(),
                key_ref: "default".to_string(),
                plain_text: "token".to_string(),
                expires_at: None,
            },
        )
        .unwrap();
        let audit = repo.list_audit_events(&scope, 10).unwrap();
        assert_eq!(
            audit[0].metadata,
            "{\"provider\":\"gmail\",\"keyRef\":\"default\",\"expiresAt\":null}"
        );
    }
}
