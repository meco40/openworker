//! Port of `src/server/master/connectors/secretPolicies.ts:1-50`.
//!
//! Rotate and revoke around [`store_connector_secret`]. A rotation is a store
//! plus a `rotate` audit event; a revocation rewrites the row with
//! `revokedAt = now` (keeping the ciphertext) and appends a `revoke` event, and
//! is a no-op when nothing is stored.

use crate::master::connectors::secret_store::{
    expires_at_json, json_string, store_connector_secret, ConnectorSecretError, SecretKeyResolver,
    StoreConnectorSecretInput,
};
use crate::master::repository::audit_store::MasterAuditEventInput;
use crate::master::repository::helpers::now_iso;
use crate::master::repository::secrets_store::MasterConnectorSecretInput;
use crate::master::repository::MasterRepository;
use crate::master::types::WorkspaceScope;

/// `input` of `rotateConnectorSecret` — `secretPolicies.ts:8`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RotateConnectorSecretInput {
    pub provider: String,
    pub key_ref: String,
    pub next_plain_text: String,
    pub expires_at: Option<String>,
}

/// `rotateConnectorSecret` — `secretPolicies.ts:5-25`.
pub fn rotate_connector_secret(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    resolver: &SecretKeyResolver,
    input: &RotateConnectorSecretInput,
) -> Result<(), ConnectorSecretError> {
    store_connector_secret(
        repo,
        scope,
        resolver,
        &StoreConnectorSecretInput {
            provider: input.provider.clone(),
            key_ref: input.key_ref.clone(),
            plain_text: input.next_plain_text.clone(),
            expires_at: input.expires_at.clone(),
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
        &MasterAuditEventInput {
            category: "connector_secret".to_string(),
            action: "rotate".to_string(),
            metadata,
        },
    )?;
    Ok(())
}

/// `input` of `revokeConnectorSecret` — `secretPolicies.ts:30`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevokeConnectorSecretInput {
    pub provider: String,
    pub key_ref: String,
}

/// `revokeConnectorSecret` — `secretPolicies.ts:27-50`.
pub fn revoke_connector_secret(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    input: &RevokeConnectorSecretInput,
) -> Result<(), ConnectorSecretError> {
    let Some(existing) = repo.get_connector_secret(scope, &input.provider, &input.key_ref)? else {
        return Ok(());
    };
    repo.upsert_connector_secret(
        scope,
        &MasterConnectorSecretInput {
            provider: existing.provider,
            key_ref: existing.key_ref,
            encrypted_payload: existing.encrypted_payload,
            issued_at: existing.issued_at,
            expires_at: existing.expires_at,
            revoked_at: Some(now_iso()),
        },
    )?;
    let metadata = format!(
        "{{\"provider\":{},\"keyRef\":{}}}",
        json_string(&input.provider),
        json_string(&input.key_ref),
    );
    repo.append_audit_event(
        scope,
        &MasterAuditEventInput {
            category: "connector_secret".to_string(),
            action: "revoke".to_string(),
            metadata,
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn resolver() -> SecretKeyResolver {
        let mut env = crate::master::feature_flags::MasterEnv::new();
        env.insert(
            "BETACLAW_MASTER_SECRET_KEY".to_string(),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
        );
        SecretKeyResolver::new(&env, "/ws")
    }

    fn rotate(repo: &SqliteMasterRepository) {
        rotate_connector_secret(
            repo,
            &scope(),
            &resolver(),
            &RotateConnectorSecretInput {
                provider: "gmail".to_string(),
                key_ref: "default".to_string(),
                next_plain_text: "token".to_string(),
                expires_at: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn rotate_stores_and_records_the_rotate_event() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        rotate(&repo);
        assert!(repo
            .get_connector_secret(&scope, "gmail", "default")
            .unwrap()
            .is_some());
        let audit = repo.list_audit_events(&scope, 10).unwrap();
        let actions: Vec<&str> = audit.iter().map(|event| event.action.as_str()).collect();
        assert!(actions.contains(&"store"));
        assert!(actions.contains(&"rotate"));
    }

    #[test]
    fn revoke_stamps_revoked_at_and_records_the_event() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        rotate(&repo);
        revoke_connector_secret(
            &repo,
            &scope,
            &RevokeConnectorSecretInput {
                provider: "gmail".to_string(),
                key_ref: "default".to_string(),
            },
        )
        .unwrap();
        let stored = repo
            .get_connector_secret(&scope, "gmail", "default")
            .unwrap()
            .expect("stored");
        assert!(stored.revoked_at.is_some());
        let audit = repo.list_audit_events(&scope, 10).unwrap();
        let events: Vec<&str> = audit.iter().map(|event| event.action.as_str()).collect();
        assert!(events.contains(&"revoke"));
    }

    #[test]
    fn revoking_a_missing_secret_is_a_no_op() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let scope = scope();
        revoke_connector_secret(
            &repo,
            &scope,
            &RevokeConnectorSecretInput {
                provider: "gmail".to_string(),
                key_ref: "default".to_string(),
            },
        )
        .unwrap();
        assert!(repo.list_audit_events(&scope, 10).unwrap().is_empty());
    }
}
