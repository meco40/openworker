//! Port of `src/server/agent-v2/extensions/security.ts`.
//!
//! Ported: the allowlist format, the allowlist key, the manifest and signature
//! digests, the canonical manifest payload, the order of the checks in
//! `validateExtensionManifest`, and the signature check.
//!
//! The TypeScript calls `crypto.createVerify('sha256')` with a PEM public key and
//! verifies the base64 signature over the canonical payload. The port reads the key
//! from the PEM and verifies with `ring`: RSA PKCS#1 v1.5 for RSA keys, ECDSA (DER)
//! for P-256 and P-384 keys. Node hashes with SHA-256 for every key type, so the
//! P-384 check uses SHA-256 too. Every other input fails closed, see
//! [`verify_manifest_signature`].

use std::collections::{HashMap, HashSet};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ring::signature::{
    UnparsedPublicKey, VerificationAlgorithm, ECDSA_P256_SHA256_ASN1, ECDSA_P384_SHA256_ASN1,
    RSA_PKCS1_2048_8192_SHA256,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::types::{ExtensionManifestV1, SigningKeyRecord, SigningKeyStatus};

/// What a validation run needs. The caller loads it from the repository.
#[derive(Debug, Clone, Default)]
pub struct ExtensionValidationContext {
    pub signing_keys: HashMap<String, SigningKeyRecord>,
    pub revoked_signature_digests: HashSet<String>,
    pub allowlist: HashSet<String>,
}

/// `parseExtensionAllowlistFromEnv` reads `AGENT_V2_EXTENSION_ALLOWLIST`.
pub fn parse_extension_allowlist_from_env() -> HashSet<String> {
    parse_extension_allowlist(&std::env::var("AGENT_V2_EXTENSION_ALLOWLIST").unwrap_or_default())
}

/// A comma-separated list. Entries are trimmed and empty ones dropped.
pub fn parse_extension_allowlist(raw: &str) -> HashSet<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

/// `buildAllowlistKey`: `id@version@digest`.
pub fn build_allowlist_key(manifest: &ExtensionManifestV1) -> String {
    format!("{}@{}@{}", manifest.id, manifest.version, manifest.digest)
}

/// `computeManifestDigest`: SHA-256 hex of the canonical payload.
pub fn compute_manifest_digest(manifest: &ExtensionManifestV1) -> String {
    sha256_hex(canonical_manifest_payload(manifest).as_bytes())
}

/// `computeSignatureDigest`: SHA-256 hex of the signature text.
pub fn compute_signature_digest(signature: &str) -> String {
    sha256_hex(signature.as_bytes())
}

/// `validateExtensionManifest`. The first failing check gives the error text; the
/// checks run in the TypeScript order.
pub fn validate_extension_manifest(
    manifest: &ExtensionManifestV1,
    ctx: &ExtensionValidationContext,
) -> Result<(), String> {
    let key = build_allowlist_key(manifest);
    if !ctx.allowlist.contains(&key) {
        return Err(format!("Extension not allowlisted: {key}"));
    }

    let key_record = match ctx.signing_keys.get(&manifest.key_id) {
        Some(record) if record.status == SigningKeyStatus::Active => record,
        _ => return Err(format!("Signing key is not active: {}", manifest.key_id)),
    };

    if compute_manifest_digest(manifest) != manifest.digest {
        return Err(format!(
            "Manifest digest mismatch for {}@{}.",
            manifest.id, manifest.version
        ));
    }

    if ctx
        .revoked_signature_digests
        .contains(&compute_signature_digest(&manifest.signature))
    {
        return Err(format!(
            "Signature has been revoked for {}@{}.",
            manifest.id, manifest.version
        ));
    }

    if !verify_manifest_signature(manifest, &key_record.public_key_pem) {
        return Err(format!(
            "Signature verification failed for {}@{}.",
            manifest.id, manifest.version
        ));
    }

    Ok(())
}

/// `verifyManifestSignature`. Checks the base64 signature over the canonical payload
/// with a `PUBLIC KEY` (SPKI) or `RSA PUBLIC KEY` (PKCS#1) PEM key. Like the
/// TypeScript `catch`, every failure gives `false`: a missing or broken PEM, an
/// unsupported key type, or a signature that does not verify.
pub fn verify_manifest_signature(manifest: &ExtensionManifestV1, public_key_pem: &str) -> bool {
    let Some(key) = parse_public_key_pem(public_key_pem) else {
        return false;
    };
    let Some(signature) = decode_base64(&manifest.signature) else {
        return false;
    };
    let payload = canonical_manifest_payload(manifest);
    let (algorithm, key_bytes): (&dyn VerificationAlgorithm, &[u8]) = match &key {
        PublicKey::Rsa(der) => (&RSA_PKCS1_2048_8192_SHA256, der.as_slice()),
        PublicKey::EcP256(point) => (&ECDSA_P256_SHA256_ASN1, point.as_slice()),
        PublicKey::EcP384(point) => (&ECDSA_P384_SHA256_ASN1, point.as_slice()),
    };
    UnparsedPublicKey::new(algorithm, key_bytes)
        .verify(payload.as_bytes(), &signature)
        .is_ok()
}

/// A verification key in the form `ring` takes it: PKCS#1 DER for RSA, the
/// uncompressed SEC1 point for ECDSA.
enum PublicKey {
    Rsa(Vec<u8>),
    EcP256(Vec<u8>),
    EcP384(Vec<u8>),
}

/// Reads a `PUBLIC KEY` (SPKI) or `RSA PUBLIC KEY` (PKCS#1) block. Other labels,
/// including `EC PUBLIC KEY` and certificates, are rejected. Node throws on the EC
/// label too.
fn parse_public_key_pem(pem: &str) -> Option<PublicKey> {
    let rest = pem.trim().strip_prefix("-----BEGIN ")?;
    let (label, rest) = rest.split_once("-----")?;
    let body = rest.strip_suffix(&format!("-----END {label}-----"))?;
    let der = decode_base64(body)?;
    match label {
        "PUBLIC KEY" => parse_spki(&der),
        "RSA PUBLIC KEY" => Some(PublicKey::Rsa(der)),
        _ => None,
    }
}

const OID_RSA_ENCRYPTION: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_PRIME256V1: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_SECP384R1: &[u8] = &[0x2b, 0x81, 0x04, 0x00, 0x22];

/// Walks a `SubjectPublicKeyInfo`. The algorithm OID picks the key type, the named
/// curve picks the EC curve, and the BIT STRING holds the key.
fn parse_spki(der: &[u8]) -> Option<PublicKey> {
    let (spki, trailing) = der_read(der, 0x30)?;
    let (algorithm, rest) = der_read(spki, 0x30)?;
    let (oid, params) = der_read(algorithm, 0x06)?;
    let (bits, rest) = der_read(rest, 0x03)?;
    if !trailing.is_empty() || !rest.is_empty() {
        return None;
    }
    let (&unused_bits, key) = bits.split_first()?;
    if unused_bits != 0 {
        return None;
    }
    match oid {
        OID_RSA_ENCRYPTION => Some(PublicKey::Rsa(key.to_vec())),
        OID_EC_PUBLIC_KEY => match der_read(params, 0x06)?.0 {
            OID_PRIME256V1 => Some(PublicKey::EcP256(key.to_vec())),
            OID_SECP384R1 => Some(PublicKey::EcP384(key.to_vec())),
            _ => None,
        },
        _ => None,
    }
}

/// Reads one DER element with `tag` from the front of `input`. Returns its content and
/// the bytes after it.
fn der_read(input: &[u8], tag: u8) -> Option<(&[u8], &[u8])> {
    let (&found, rest) = input.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first < 0x80 {
        (usize::from(first), rest)
    } else {
        let width = usize::from(first & 0x7f);
        if width == 0 || width > 4 || rest.len() < width {
            return None;
        }
        let len = rest[..width]
            .iter()
            .fold(0usize, |acc, &byte| (acc << 8) | usize::from(byte));
        (len, &rest[width..])
    };
    if found != tag || rest.len() < len {
        return None;
    }
    Some(rest.split_at(len))
}

/// Standard base64 with padding. Whitespace is skipped, as Node skips it.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let compact: String = text.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    STANDARD.decode(compact).ok()
}

/// `canonicalManifestPayload`: `JSON.stringify` of the fields in this order, with
/// both stage lists sorted, a missing fail-closed list as `[]` and a missing
/// timeout as `null`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalPayload<'a> {
    schema_version: &'a str,
    id: &'a str,
    version: &'a str,
    key_id: &'a str,
    module_path: &'a str,
    hook_stages: Vec<&'static str>,
    fail_closed_stages: Vec<&'static str>,
    timeout_ms: Option<u64>,
}

fn canonical_manifest_payload(manifest: &ExtensionManifestV1) -> String {
    let mut hook_stages: Vec<&'static str> = manifest
        .hook_stages
        .iter()
        .map(|stage| stage.as_str())
        .collect();
    hook_stages.sort_unstable();

    let mut fail_closed_stages: Vec<&'static str> = manifest
        .fail_closed_stages
        .iter()
        .flatten()
        .map(|stage| stage.as_str())
        .collect();
    fail_closed_stages.sort_unstable();

    let payload = CanonicalPayload {
        schema_version: &manifest.schema_version,
        id: &manifest.id,
        version: &manifest.version,
        key_id: &manifest.key_id,
        module_path: &manifest.module_path,
        hook_stages,
        fail_closed_stages,
        timeout_ms: manifest.timeout_ms,
    };
    serde_json::to_string(&payload).expect("a struct of strings and integers always serializes")
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_v2::types::LifecycleHookStage;

    /// A manifest whose digest field is the real digest, as a signed one would be.
    fn with_digest(mut manifest: ExtensionManifestV1) -> ExtensionManifestV1 {
        manifest.digest = compute_manifest_digest(&manifest);
        manifest
    }

    fn full_manifest() -> ExtensionManifestV1 {
        ExtensionManifestV1 {
            schema_version: "1".into(),
            id: "demo-ext".into(),
            version: "1.0.0".into(),
            name: "Demo".into(),
            description: "d".into(),
            author: "a".into(),
            digest: String::new(),
            key_id: "key-1".into(),
            signature: "sig-abc".into(),
            module_path: "dist/index.js".into(),
            hook_stages: vec![
                LifecycleHookStage::ToolAfterExecute,
                LifecycleHookStage::SessionBeforeStart,
            ],
            fail_closed_stages: Some(vec![LifecycleHookStage::SessionBeforeStart]),
            timeout_ms: Some(2500),
        }
    }

    fn minimal_manifest() -> ExtensionManifestV1 {
        ExtensionManifestV1 {
            schema_version: "1".into(),
            id: "min-ext".into(),
            version: "0.1.0".into(),
            name: "Min".into(),
            description: "d".into(),
            author: "a".into(),
            digest: String::new(),
            key_id: "k".into(),
            signature: "x".into(),
            module_path: "m.js".into(),
            hook_stages: vec![LifecycleHookStage::CommandBeforeEnqueue],
            fail_closed_stages: None,
            timeout_ms: None,
        }
    }

    // Reference values from Node's JSON.stringify and crypto.createHash('sha256') over
    // the same payload layout as canonicalManifestPayload in security.ts.
    #[test]
    fn canonical_payload_and_digests_match_the_typescript_reference() {
        assert_eq!(
            canonical_manifest_payload(&full_manifest()),
            r#"{"schemaVersion":"1","id":"demo-ext","version":"1.0.0","keyId":"key-1","modulePath":"dist/index.js","hookStages":["session.before_start","tool.after_execute"],"failClosedStages":["session.before_start"],"timeoutMs":2500}"#
        );
        assert_eq!(
            compute_manifest_digest(&full_manifest()),
            "8d9beeff75eccb2be64fc9d142704be82b23349b97f772717853e4a0005eaf18"
        );
        assert_eq!(
            compute_manifest_digest(&minimal_manifest()),
            "f78b8933691aa55abf68e8f49eb7936b1b1196a4e71ced337bc374dc09cc6578"
        );
        assert_eq!(
            compute_signature_digest("sig-abc"),
            "845ed3481ddbfc748428119cd6a2d848cfff097e6aa97a71aaf85a2e3fd63c46"
        );
    }

    #[test]
    fn allowlist_entries_are_trimmed_and_empty_ones_dropped() {
        let parsed = parse_extension_allowlist(" a@1@d , ,b@2@e,");
        assert_eq!(parsed.len(), 2);
        assert!(parsed.contains("a@1@d"));
        assert!(parsed.contains("b@2@e"));
    }

    /// A context that allowlists `manifest` and knows its key with `status`.
    fn context_for(
        manifest: &ExtensionManifestV1,
        status: SigningKeyStatus,
    ) -> ExtensionValidationContext {
        let mut ctx = ExtensionValidationContext::default();
        ctx.allowlist.insert(build_allowlist_key(manifest));
        ctx.signing_keys.insert(
            "key-1".into(),
            SigningKeyRecord {
                key_id: "key-1".into(),
                algorithm: "RSA-SHA256".into(),
                public_key_pem: "pem".into(),
                status,
                created_at: "t".into(),
                rotated_at: None,
                revoked_at: None,
            },
        );
        ctx
    }

    #[test]
    fn checks_run_in_order_and_an_unverifiable_signature_is_rejected() {
        let manifest = with_digest(full_manifest());

        let mut not_listed = context_for(&manifest, SigningKeyStatus::Active);
        not_listed.allowlist.clear();
        assert_eq!(
            validate_extension_manifest(&manifest, &not_listed).unwrap_err(),
            format!(
                "Extension not allowlisted: {}",
                build_allowlist_key(&manifest)
            )
        );

        let inactive = context_for(&manifest, SigningKeyStatus::Revoked);
        assert_eq!(
            validate_extension_manifest(&manifest, &inactive).unwrap_err(),
            "Signing key is not active: key-1"
        );

        // The digest is still the old one, so the canonical payload no longer matches.
        let mut tampered = manifest.clone();
        tampered.module_path = "evil.js".into();
        let ctx = context_for(&tampered, SigningKeyStatus::Active);
        assert_eq!(
            validate_extension_manifest(&tampered, &ctx).unwrap_err(),
            "Manifest digest mismatch for demo-ext@1.0.0."
        );

        let mut revoked = context_for(&manifest, SigningKeyStatus::Active);
        revoked
            .revoked_signature_digests
            .insert(compute_signature_digest("sig-abc"));
        assert_eq!(
            validate_extension_manifest(&manifest, &revoked).unwrap_err(),
            "Signature has been revoked for demo-ext@1.0.0."
        );

        // Every earlier check passes. "pem" is not a PEM key, so the signature check rejects it.
        let valid_so_far = context_for(&manifest, SigningKeyStatus::Active);
        assert_eq!(
            validate_extension_manifest(&manifest, &valid_so_far).unwrap_err(),
            "Signature verification failed for demo-ext@1.0.0."
        );
    }

    /// `full_manifest()` carrying `signature`. The signature is not part of the payload,
    /// so the digest does not change.
    fn signed_with(signature: &str) -> ExtensionManifestV1 {
        let mut manifest = full_manifest();
        manifest.signature = signature.into();
        manifest
    }

    #[test]
    fn accepts_valid_rsa_and_ecdsa_signatures() {
        assert!(verify_manifest_signature(
            &signed_with(RSA_SIGNATURE),
            RSA_SPKI_PEM
        ));
        assert!(verify_manifest_signature(
            &signed_with(RSA_SIGNATURE),
            RSA_PKCS1_PEM
        ));
        assert!(verify_manifest_signature(
            &signed_with(P256_SIGNATURE),
            P256_SPKI_PEM
        ));
        assert!(verify_manifest_signature(
            &signed_with(P384_SIGNATURE),
            P384_SPKI_PEM
        ));
    }

    #[test]
    fn accepted_signature_passes_every_validation_check() {
        let manifest = with_digest(signed_with(RSA_SIGNATURE));
        let mut ctx = context_for(&manifest, SigningKeyStatus::Active);
        ctx.signing_keys.get_mut("key-1").unwrap().public_key_pem = RSA_SPKI_PEM.into();
        assert_eq!(validate_extension_manifest(&manifest, &ctx), Ok(()));
    }

    #[test]
    fn rejects_a_signature_over_another_payload() {
        let mut other = signed_with(RSA_SIGNATURE);
        other.module_path = "evil.js".into();
        assert!(!verify_manifest_signature(&other, RSA_SPKI_PEM));
    }

    #[test]
    fn rejects_a_corrupted_signature() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let mut raw = STANDARD.decode(P256_SIGNATURE).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        let corrupted = STANDARD.encode(raw);
        assert!(!verify_manifest_signature(
            &signed_with(&corrupted),
            P256_SPKI_PEM
        ));
    }

    #[test]
    fn rejects_a_signature_under_a_key_of_another_type() {
        assert!(!verify_manifest_signature(
            &signed_with(P256_SIGNATURE),
            P384_SPKI_PEM
        ));
        assert!(!verify_manifest_signature(
            &signed_with(RSA_SIGNATURE),
            P256_SPKI_PEM
        ));
    }

    #[test]
    fn rejects_a_missing_or_broken_key() {
        let manifest = signed_with(P256_SIGNATURE);
        let no_end = P256_SPKI_PEM.replace("-----END PUBLIC KEY-----", "");
        let ec_label = P256_SPKI_PEM.replace("PUBLIC KEY", "EC PUBLIC KEY");
        let bad_body = "-----BEGIN PUBLIC KEY-----\n!!!!\n-----END PUBLIC KEY-----";
        for pem in [
            "",
            "not a pem",
            bad_body,
            no_end.as_str(),
            ec_label.as_str(),
        ] {
            assert!(
                !verify_manifest_signature(&manifest, pem),
                "accepted {pem:?}"
            );
        }
    }

    // Vectors from OpenSSL 3.0.18 in the rust:1.94-bookworm image. The key pairs were
    // generated there. Each signature is SHA-256 over the canonical payload of
    // `full_manifest()`, base64-encoded, DER for ECDSA.
    const RSA_SPKI_PEM: &str = "-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz7fnatQTkx5N4YLLo6Oa
ZhxSkQWGeTxVeeUC+ICmystQSyOX65BTA9ublhEZIgChfgARy1KLIT8CBNJlNdn2
HMY+FI1HzCzfS5G+Jb3a6ZGjmQFTsk5ubNGIQ9shKYMyZQemW0o6H9dsJI+fRGDw
g+kNimCJmIWuRswz2EHp7AJ+RSCGxuq4T2s8ERTXZgaSNbkhngyQ2NI6AzW2sXOm
iYW/20pqNMnKwdW1xSiQSQisMGUFdVW+AxUKcVYXLsDY/aVxPS1BUzyGrGCBXVCl
wiDhgwvJL1kgkT4WSzgB3PLO8iT32pU8MnflAPoHPohUH0gSRlpeCAC1lRkFs013
IwIDAQAB
-----END PUBLIC KEY-----";
    const RSA_PKCS1_PEM: &str = "-----BEGIN RSA PUBLIC KEY-----
MIIBCgKCAQEAz7fnatQTkx5N4YLLo6OaZhxSkQWGeTxVeeUC+ICmystQSyOX65BT
A9ublhEZIgChfgARy1KLIT8CBNJlNdn2HMY+FI1HzCzfS5G+Jb3a6ZGjmQFTsk5u
bNGIQ9shKYMyZQemW0o6H9dsJI+fRGDwg+kNimCJmIWuRswz2EHp7AJ+RSCGxuq4
T2s8ERTXZgaSNbkhngyQ2NI6AzW2sXOmiYW/20pqNMnKwdW1xSiQSQisMGUFdVW+
AxUKcVYXLsDY/aVxPS1BUzyGrGCBXVClwiDhgwvJL1kgkT4WSzgB3PLO8iT32pU8
MnflAPoHPohUH0gSRlpeCAC1lRkFs013IwIDAQAB
-----END RSA PUBLIC KEY-----";
    const RSA_SIGNATURE: &str = "yT0elbajkFeq9znvWuyEvZ7xnP7vdX8tFPNB3ZcDHSsnyM4lUktajx//ZZAlP0je3wgAwd6dUnnoIhOkjSJrm8jABgbBG+6tAqEYoZ69FgVYL/4AiKLU7iHPJCfeDBz0jBQAZk4N46/J/WvFthYdvMVJsDLuFFmDSmZ7rDoPzyNwD+MudUqXjJGQVSFpdjqSd9P6+TNZNVbaawUfSCTnA1IIy7LBlL5yMSDn5k0SdNUZOiDcxMswztZ3bjbw/HdaGwCnOKG6Mxg1+ZV00zGQmDKjw6+YOOkstVwBC+xqde9vWUjWtjujUY59uPscx5htri+Y+2GNVb10AuEVjH8iJg==";
    const P256_SPKI_PEM: &str = "-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEexYWht9a5iXZz22TW+boR+gA99oX
bJIXEb0q8yfSL1AWz9vC574ec+FqOiQDOoddI+4DgXJvM6kzSNIPzPfzsg==
-----END PUBLIC KEY-----";
    const P256_SIGNATURE: &str = "MEYCIQCmmuNfHvUjCAyYkm1U+Vi/omeyGGRd+ekqvX5kR+p4tAIhANtfQbGPkLj4dKrOOo8XpLArMXqQLCzYvl5YuxqkJ06c";
    const P384_SPKI_PEM: &str = "-----BEGIN PUBLIC KEY-----
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEuJY6Fp8wasIsMBYEgCST+7/EP/szSq4q
XuPhGH+DEJ6c7PyJtuHnblWM5cQfeQzwO54xzx4nsYbm4Ph3zUT4fzuEUstHRIaL
tpBoyV9gr/T3KEv0k//WCf818yo9klQE
-----END PUBLIC KEY-----";
    const P384_SIGNATURE: &str = "MGYCMQCYRlf/7UCGC6u5NZGP5oih+j3UQWJuG4wUZFnabTKI87otDr5hhYT1cL5acz2p77QCMQC7zx/+mEGtTSD8+Jp4GgtwdQwJAmUVMkiKRDbXkXko0YRNYqhaM5WPLC7TCB320PY=";
}
