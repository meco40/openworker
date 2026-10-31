//! Revision hash of a gateway config.
//!
//! `computeGatewayConfigRevision` is defined inline in
//! `src/server/config/gateway/gatewayConfig.ts:23-26`: SHA-256 over
//! `JSON.stringify(config)`, truncated to the first 16 hex characters.
//!
//! This module is the single definition. The config store and the
//! `policy-explain` route both call [`compute_revision`].

use serde_json::Value;
use sha2::{Digest, Sha256};

/// `computeGatewayConfigRevision` from `gatewayConfig.ts:23-26`.
pub fn compute_revision(config: &Value) -> String {
    let normalized = serde_json::to_string(config).unwrap_or_default();
    let digest = Sha256::digest(normalized.as_bytes());
    let hex: String = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    hex[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway_config::constants::default_gateway_config;

    #[test]
    fn revision_is_sixteen_lowercase_hex_chars() {
        let revision = compute_revision(&default_gateway_config());
        assert_eq!(revision.len(), 16);
        assert!(revision
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn matches_the_sha256_prefix_of_the_json_text() {
        // Recomputed independently of `compute_revision` so the test fails if the
        // implementation ever changes what is hashed.
        let config = default_gateway_config();
        let serialized = serde_json::to_string(&config).expect("serialize");
        let expected = Sha256::digest(serialized.as_bytes());
        let expected_hex: String = expected.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(compute_revision(&config), expected_hex[..16]);
    }

    #[test]
    fn key_order_changes_the_revision() {
        // `JSON.stringify` follows insertion order, so a reordered object is a
        // different revision. This is what makes the stale-write guard sensitive.
        let mut first = serde_json::Map::new();
        first.insert("a".into(), Value::from(1));
        first.insert("b".into(), Value::from(2));
        let mut second = serde_json::Map::new();
        second.insert("b".into(), Value::from(2));
        second.insert("a".into(), Value::from(1));

        assert_ne!(
            compute_revision(&Value::Object(first)),
            compute_revision(&Value::Object(second))
        );
    }

    #[test]
    fn identical_content_produces_an_identical_revision() {
        assert_eq!(
            compute_revision(&default_gateway_config()),
            compute_revision(&default_gateway_config())
        );
    }

    #[test]
    fn agrees_with_the_gateway_crate_implementation() {
        // Reference copy of the hash (SHA-256, first 16 hex chars) that the gateway
        // used to compute in its own `revision_of`, removed in the S2 follow-up.
        // The gateway now takes the revision from `compute_revision` via
        // `GatewayConfigStore::load`. The route-level check that the revision is
        // 16 characters long is `get_returns_defaults_with_redacted_secrets` in
        // betaclaw-gateway/src/routes/config.rs.
        fn revision_of(config: &Value) -> String {
            let serialized = serde_json::to_string(config).unwrap_or_default();
            let digest = Sha256::digest(serialized.as_bytes());
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            hex[..16].to_string()
        }
        assert_eq!(
            compute_revision(&default_gateway_config()),
            revision_of(&default_gateway_config())
        );
    }
}
