//! Port of `src/server/master/connectors/gmail/oauth.ts:1-33`.
//!
//! Loads the stored Gmail OAuth token: a `null` return when nothing is stored or
//! the secret is revoked, otherwise the decrypted access token plus its
//! timestamps, with a `read` audit event in between.

use crate::master::connectors::secret_store::{
    decrypt_connector_secret, json_string, ConnectorSecretError, SecretKeyResolver,
};
use crate::master::repository::audit_store::MasterAuditEventInput;
use crate::master::repository::MasterRepository;
use crate::master::types::WorkspaceScope;

/// `GmailOAuthState` from `oauth.ts:5-10`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GmailOAuthState {
    pub access_token: String,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
}

/// The `keyRef = 'default'` default of `oauth.ts:15`.
pub const DEFAULT_GMAIL_KEY_REF: &str = "default";

/// `loadGmailOAuthState` — `oauth.ts:12-33`.
pub fn load_gmail_oauth_state(
    repo: &dyn MasterRepository,
    scope: &WorkspaceScope,
    resolver: &SecretKeyResolver,
    key_ref: &str,
) -> Result<Option<GmailOAuthState>, ConnectorSecretError> {
    let Some(secret) = repo.get_connector_secret(scope, "gmail", key_ref)? else {
        return Ok(None);
    };
    if secret.revoked_at.is_some() {
        return Ok(None);
    }
    let metadata = format!(
        "{{\"provider\":\"gmail\",\"keyRef\":{}}}",
        json_string(key_ref)
    );
    repo.append_audit_event(
        scope,
        &MasterAuditEventInput {
            category: "connector_secret".to_string(),
            action: "read".to_string(),
            metadata,
        },
    )?;
    Ok(Some(GmailOAuthState {
        access_token: decrypt_connector_secret(resolver, &secret.encrypted_payload)?,
        issued_at: secret.issued_at,
        expires_at: secret.expires_at,
        revoked_at: secret.revoked_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::master::connectors::secret_policies::{
        revoke_connector_secret, rotate_connector_secret, RevokeConnectorSecretInput,
        RotateConnectorSecretInput,
    };
    use crate::master::feature_flags::MasterEnv;
    use crate::master::repository::sqlite_master_repository::SqliteMasterRepository;

    fn scope() -> WorkspaceScope {
        WorkspaceScope {
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
        }
    }

    fn resolver() -> SecretKeyResolver {
        let mut env = MasterEnv::new();
        env.insert(
            "BETACLAW_MASTER_SECRET_KEY".to_string(),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
        );
        SecretKeyResolver::new(&env, "/ws")
    }

    fn store_token(repo: &SqliteMasterRepository, token: &str) {
        rotate_connector_secret(
            repo,
            &scope(),
            &resolver(),
            &RotateConnectorSecretInput {
                provider: "gmail".to_string(),
                key_ref: DEFAULT_GMAIL_KEY_REF.to_string(),
                next_plain_text: token.to_string(),
                expires_at: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn nothing_stored_is_none() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        let state =
            load_gmail_oauth_state(&repo, &scope(), &resolver(), DEFAULT_GMAIL_KEY_REF).unwrap();
        assert!(state.is_none());
    }

    #[test]
    fn a_stored_token_is_decrypted_and_audited() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store_token(&repo, "access-xyz");
        let state =
            load_gmail_oauth_state(&repo, &scope(), &resolver(), DEFAULT_GMAIL_KEY_REF).unwrap();
        assert_eq!(state.expect("state").access_token, "access-xyz");
        let audit = repo.list_audit_events(&scope(), 10).unwrap();
        let read = audit
            .iter()
            .find(|event| event.action == "read")
            .expect("read event");
        assert_eq!(
            read.metadata,
            "{\"provider\":\"gmail\",\"keyRef\":\"default\"}"
        );
    }

    #[test]
    fn a_revoked_token_is_none() {
        let repo = SqliteMasterRepository::open(":memory:").unwrap();
        store_token(&repo, "access-xyz");
        revoke_connector_secret(
            &repo,
            &scope(),
            &RevokeConnectorSecretInput {
                provider: "gmail".to_string(),
                key_ref: DEFAULT_GMAIL_KEY_REF.to_string(),
            },
        )
        .unwrap();
        let state =
            load_gmail_oauth_state(&repo, &scope(), &resolver(), DEFAULT_GMAIL_KEY_REF).unwrap();
        assert!(state.is_none());
    }
}
