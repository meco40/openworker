//! Port of `src/server/model-hub/service/provider/connect.ts` (1-22).
//!
//! `connectProviderAccount` encrypts the secret (and the optional refresh token)
//! and stores the account view. The IV is drawn by
//! [`crate::model_hub::crypto::encrypt_secret`], matching `crypto.randomBytes(12)`
//! in `crypto.ts:30`.

use crate::model_hub::crypto::{encrypt_secret, mask_secret};
use crate::model_hub::repository::ModelHubRepository;
use crate::model_hub::types::{
    CreateProviderAccountInput, EncryptedSecretPayloadJson, ProviderAccountView,
};

use super::super::types::ConnectProviderAccountInput;
use super::super::ServiceError;

/// `connectProviderAccount(repository, input)` from `provider/connect.ts:5-22`.
pub fn connect_provider_account(
    repository: &dyn ModelHubRepository,
    input: ConnectProviderAccountInput,
) -> Result<ProviderAccountView, ServiceError> {
    let encrypted_secret = EncryptedSecretPayloadJson::from_payload(&encrypt_secret(
        &input.secret,
        &input.encryption_key,
    )?);
    // `input.refreshToken ? encryptSecret(...) : null` — an empty string is falsy
    // in JavaScript, so it also yields `null`.
    let encrypted_refresh_token = match input.refresh_token.as_deref() {
        Some(refresh_token) if !refresh_token.is_empty() => {
            Some(EncryptedSecretPayloadJson::from_payload(&encrypt_secret(
                refresh_token,
                &input.encryption_key,
            )?))
        }
        _ => None,
    };

    let account = repository.create_account(CreateProviderAccountInput {
        provider_id: input.provider_id,
        label: input.label,
        auth_method: input.auth_method,
        encrypted_secret,
        encrypted_refresh_token,
        secret_masked: mask_secret(&input.secret),
    })?;
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::crypto::decrypt_secret;
    use crate::model_hub::sqlite::SqliteModelHubRepository;
    use crate::model_hub::types::ProviderAuthMethod;

    const KEY: &str = "test-only-encryption-key-32bytes";

    fn input(secret: &str, refresh_token: Option<&str>) -> ConnectProviderAccountInput {
        ConnectProviderAccountInput {
            provider_id: "openai".to_string(),
            label: "My OpenAI".to_string(),
            auth_method: ProviderAuthMethod::ApiKey,
            secret: secret.to_string(),
            refresh_token: refresh_token.map(str::to_string),
            encryption_key: KEY.to_string(),
        }
    }

    /// `provider/connect.ts:14-21`: the stored view masks the secret and the
    /// stored ciphertext decrypts back to it.
    #[test]
    fn connect_stores_a_decryptable_secret() {
        let repository = SqliteModelHubRepository::in_memory().expect("in-memory database");
        let view =
            connect_provider_account(&repository, input("sk-live-ABCD", None)).expect("connect");

        assert_eq!(view.provider_id, "openai");
        assert_eq!(view.label, "My OpenAI");
        assert_eq!(view.secret_masked, mask_secret("sk-live-ABCD"));
        assert!(!view.has_refresh_token);

        let record = repository
            .get_account_record_by_id(&view.id)
            .expect("read")
            .expect("row");
        assert_eq!(
            decrypt_secret(&record.encrypted_secret_payload(), KEY).expect("decrypt"),
            "sk-live-ABCD"
        );
        assert!(record.encrypted_refresh_token.is_none());
    }

    /// `provider/connect.ts:10-12`: a refresh token is encrypted and flagged.
    #[test]
    fn connect_stores_a_refresh_token_when_present() {
        let repository = SqliteModelHubRepository::in_memory().expect("in-memory database");
        let view =
            connect_provider_account(&repository, input("sk", Some("refresh-1"))).expect("connect");
        assert!(view.has_refresh_token);

        let record = repository
            .get_account_record_by_id(&view.id)
            .expect("read")
            .expect("row");
        let refresh = record
            .encrypted_refresh_token
            .expect("refresh token stored");
        assert_eq!(
            decrypt_secret(&refresh.to_payload(), KEY).expect("decrypt"),
            "refresh-1"
        );
    }

    /// An empty `refreshToken` is falsy in TypeScript and stores `null`.
    #[test]
    fn an_empty_refresh_token_is_not_stored() {
        let repository = SqliteModelHubRepository::in_memory().expect("in-memory database");
        let view = connect_provider_account(&repository, input("sk", Some(""))).expect("connect");
        assert!(!view.has_refresh_token);
    }
}
