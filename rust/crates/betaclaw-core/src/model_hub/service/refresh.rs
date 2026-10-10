//! Port of `src/server/model-hub/service/provider/refresh.ts`.
//!
//! `maybeRefreshOpenAICodexAccount` is the only part of `service/provider/`
//! the four dispatched methods touch: every account lookup goes through it
//! before it reaches a provider adapter.
//!
//! The TypeScript function reaches for two implicit collaborators — the JWT
//! expiry check and the token refresh, both from `src/server/model-hub/codexAuth.ts`.
//! That module is not ported yet (it is an HTTP client for the OpenAI Codex
//! token endpoint and belongs with the `openai-codex` adapter), so both are
//! injected through [`CodexTokenRefresher`] instead of being duplicated here.
//! The default implementation reports "not expiring soon", which makes the port
//! behave exactly like TypeScript in the overwhelmingly common case of an
//! account whose access token is still valid; a refresh-capable implementation
//! drops in without touching the control flow below.

use crate::model_hub::crypto::{decrypt_secret, encrypt_secret_with_iv, mask_secret, random_bytes};
use crate::model_hub::repository::ModelHubRepository;
use crate::model_hub::types::{
    EncryptedSecretPayloadJson, ProviderAccountRecord, ProviderAuthMethod,
    UpdateAccountCredentialsInput,
};

use super::ServiceError;

/// Length of the GCM nonce `crypto.ts` draws with `crypto.randomBytes(12)`.
const IV_BYTES: usize = 12;

/// The result of `refreshOpenAICodexToken` (`codexAuth.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshedCodexToken {
    pub access_token: String,
    pub refresh_token: String,
}

/// The two `src/server/model-hub/codexAuth.ts` collaborators.
///
/// Both methods mirror the TypeScript surface exactly: `is_jwt_expiring_soon`
/// never throws in TypeScript (a malformed token simply reports as expiring),
/// and `refresh` rejects with a message the caller swallows, so a failure is
/// reported as a string rather than a typed error.
pub trait CodexTokenRefresher: Send + Sync {
    /// `isJwtExpiringSoon(accessToken)`.
    fn is_jwt_expiring_soon(&self, access_token: &str) -> bool;

    /// `refreshOpenAICodexToken(refreshToken)`.
    fn refresh(&self, refresh_token: &str) -> Result<RefreshedCodexToken, String>;
}

/// The default: no refresh happens, because `codexAuth.ts` is not ported.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoCodexRefresh;

impl CodexTokenRefresher for NoCodexRefresh {
    fn is_jwt_expiring_soon(&self, _access_token: &str) -> bool {
        false
    }

    fn refresh(&self, _refresh_token: &str) -> Result<RefreshedCodexToken, String> {
        Err("OpenAI Codex token refresh is not available in this build.".to_string())
    }
}

/// `maybeRefreshOpenAICodexAccount` from `provider/refresh.ts:5-42`.
///
/// Every guard from the original is preserved in order: the provider and auth
/// method, the presence of a refresh token, a decryptable and non-empty access
/// token, the expiry window, and a decryptable and non-empty refresh token. A
/// failing refresh returns the *original* account instead of propagating, and a
/// re-read failure falls back to it as well (`?? account`).
pub async fn maybe_refresh_open_ai_codex_account(
    repository: &dyn ModelHubRepository,
    account: &ProviderAccountRecord,
    encryption_key: &str,
    refresher: &dyn CodexTokenRefresher,
) -> Result<ProviderAccountRecord, ServiceError> {
    if account.provider_id != "openai-codex" || account.auth_method != ProviderAuthMethod::Oauth {
        return Ok(account.clone());
    }
    let Some(refresh_payload) = account.encrypted_refresh_token.as_ref() else {
        return Ok(account.clone());
    };

    let current_access_token = decrypt_secret(&account.encrypted_secret_payload(), encryption_key)?;
    if current_access_token.trim().is_empty() {
        return Ok(account.clone());
    }
    if !refresher.is_jwt_expiring_soon(&current_access_token) {
        return Ok(account.clone());
    }

    let current_refresh_token = decrypt_secret(&refresh_payload.to_payload(), encryption_key)?;
    if current_refresh_token.trim().is_empty() {
        return Ok(account.clone());
    }

    let refreshed = match refresher.refresh(&current_refresh_token) {
        Ok(refreshed) => refreshed,
        // `catch { return account }` — a failed refresh is never fatal.
        Err(_) => return Ok(account.clone()),
    };

    repository.update_account_credentials(UpdateAccountCredentialsInput {
        id: account.id.clone(),
        // `encrypt_with_fresh_iv` already returns the JSON wire shape, so no
        // second conversion is needed here.
        encrypted_secret: encrypt_with_fresh_iv(&refreshed.access_token, encryption_key)?,
        encrypted_refresh_token: Some(encrypt_with_fresh_iv(
            &refreshed.refresh_token,
            encryption_key,
        )?),
        secret_masked: mask_secret(&refreshed.access_token),
    })?;

    Ok(repository
        .get_account_record_by_id(&account.id)?
        .unwrap_or_else(|| account.clone()))
}

/// `encryptSecret(value, key)` with the `keyId` default and a CSPRNG nonce.
fn encrypt_with_fresh_iv(
    secret: &str,
    encryption_key: &str,
) -> Result<EncryptedSecretPayloadJson, ServiceError> {
    let iv: [u8; IV_BYTES] = random_bytes(IV_BYTES)?
        .as_slice()
        .try_into()
        .expect("random_bytes returns the requested length");
    Ok(EncryptedSecretPayloadJson::from_payload(
        &encrypt_secret_with_iv(secret, encryption_key, "default", &iv)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::crypto::EncryptedSecretPayload;
    use crate::model_hub::service::test_doubles::StubRepository;

    const KEY: &str = "test-only-encryption-key-32bytes";
    const IV: [u8; 12] = [3u8; 12];

    /// Real GCM payloads, so `decryptSecret` succeeds exactly as it does in
    /// Node — a hand-written base64 stub would fail the tag check.
    fn encrypted(secret: &str) -> EncryptedSecretPayloadJson {
        EncryptedSecretPayloadJson::from_payload(
            &encrypt_secret_with_iv(secret, KEY, "default", &IV).expect("encrypt"),
        )
    }

    fn codex_account(with_refresh: bool) -> ProviderAccountRecord {
        ProviderAccountRecord {
            id: "acc-codex".to_string(),
            provider_id: "openai-codex".to_string(),
            label: "codex".to_string(),
            auth_method: ProviderAuthMethod::Oauth,
            secret_masked: "****".to_string(),
            has_refresh_token: with_refresh,
            created_at: String::new(),
            updated_at: String::new(),
            last_check_at: None,
            last_check_ok: None,
            last_check_message: None,
            encrypted_secret: encrypted("access-token"),
            encrypted_refresh_token: with_refresh.then(|| encrypted("refresh-token")),
        }
    }

    /// Every non-codex account is returned untouched, without a decrypt.
    #[tokio::test]
    async fn a_non_codex_account_is_returned_unchanged() {
        let repository = StubRepository::default();
        let mut account = codex_account(true);
        account.provider_id = "openai".to_string();

        let result =
            maybe_refresh_open_ai_codex_account(&repository, &account, KEY, &NoCodexRefresh)
                .await
                .expect("no repository failure");

        assert_eq!(result, account);
        assert_eq!(repository.credential_updates(), 0);
    }

    /// An api_key codex account never reaches the expiry check either.
    #[tokio::test]
    async fn a_codex_account_without_oauth_is_returned_unchanged() {
        let repository = StubRepository::default();
        let mut account = codex_account(true);
        account.auth_method = ProviderAuthMethod::ApiKey;

        let result =
            maybe_refresh_open_ai_codex_account(&repository, &account, KEY, &NoCodexRefresh)
                .await
                .expect("no repository failure");

        assert_eq!(result, account);
        assert_eq!(repository.credential_updates(), 0);
    }

    /// An oauth-codex account without a refresh token keeps the historical
    /// `if (!account.encryptedRefreshToken) return account;` short-circuit.
    #[tokio::test]
    async fn a_codex_account_without_refresh_token_is_returned_unchanged() {
        let repository = StubRepository::default();
        let account = codex_account(false);

        let result =
            maybe_refresh_open_ai_codex_account(&repository, &account, KEY, &NoCodexRefresh)
                .await
                .expect("no repository failure");

        assert_eq!(result, account);
        assert_eq!(repository.credential_updates(), 0);
    }

    /// A token that is not expiring soon keeps the account untouched.
    #[tokio::test]
    async fn a_valid_token_is_returned_unchanged() {
        let repository = StubRepository::default();
        let account = codex_account(true);

        let result =
            maybe_refresh_open_ai_codex_account(&repository, &account, KEY, &NoCodexRefresh)
                .await
                .expect("no repository failure");

        assert_eq!(result, account);
        assert_eq!(repository.credential_updates(), 0);
    }

    /// A refresh that reports "expiring soon" writes new credentials and returns
    /// the re-read record.
    #[tokio::test]
    async fn an_expiring_token_is_rewritten_and_reread() {
        struct Expiring;
        impl CodexTokenRefresher for Expiring {
            fn is_jwt_expiring_soon(&self, _access_token: &str) -> bool {
                true
            }
            fn refresh(&self, _refresh_token: &str) -> Result<RefreshedCodexToken, String> {
                Ok(RefreshedCodexToken {
                    access_token: "new-access".to_string(),
                    refresh_token: "new-refresh".to_string(),
                })
            }
        }

        let repository = StubRepository::default();
        let account = codex_account(true);

        let result = maybe_refresh_open_ai_codex_account(&repository, &account, KEY, &Expiring)
            .await
            .expect("no repository failure");

        assert_eq!(repository.credential_updates(), 1);
        // `secretMasked: maskSecret(refreshed.accessToken)`.
        let written = &repository.recorded_credentials()[0];
        assert_eq!(written.secret_masked, mask_secret("new-access"));
        assert!(written.encrypted_secret.alg == "aes-256-gcm");
        // The re-read record (or the original, if the read yields nothing).
        assert_eq!(result.id, account.id);
    }

    /// A failing refresh keeps the original account and writes nothing.
    #[tokio::test]
    async fn a_failing_refresh_keeps_the_original_account() {
        struct Failing;
        impl CodexTokenRefresher for Failing {
            fn is_jwt_expiring_soon(&self, _access_token: &str) -> bool {
                true
            }
            fn refresh(&self, _refresh_token: &str) -> Result<RefreshedCodexToken, String> {
                Err("refresh failed".to_string())
            }
        }

        let repository = StubRepository::default();
        let account = codex_account(true);

        let result = maybe_refresh_open_ai_codex_account(&repository, &account, KEY, &Failing)
            .await
            .expect("a failed refresh is not an error");

        assert_eq!(result, account);
        assert_eq!(repository.credential_updates(), 0);
    }

    /// `decryptSecret` throws on a malformed payload in TypeScript, so the port
    /// surfaces a crypto failure instead of pretending the account is usable.
    #[tokio::test]
    async fn an_undecryptable_secret_is_reported() {
        let repository = StubRepository::default();
        let mut account = codex_account(true);
        account.encrypted_secret = EncryptedSecretPayloadJson {
            alg: "aes-256-gcm".to_string(),
            key_id: "default".to_string(),
            iv: "not-base64!".to_string(),
            ciphertext: "cipher".to_string(),
            tag: "tag".to_string(),
        };

        let error =
            maybe_refresh_open_ai_codex_account(&repository, &account, KEY, &NoCodexRefresh)
                .await
                .expect_err("malformed payload");

        assert!(matches!(error, ServiceError::Crypto(_)), "{error:?}");
    }

    /// `random_bytes` feeds the same 12-byte GCM nonce `crypto.ts` draws.
    #[test]
    fn encrypted_with_fresh_iv_produces_a_readable_payload() {
        let payload = encrypt_with_fresh_iv("sk-live", KEY).expect("encrypt");
        assert_eq!(payload.alg, "aes-256-gcm");
        assert_eq!(payload.key_id, "default");
        assert_ne!(
            payload,
            encrypt_with_fresh_iv("sk-live", KEY).expect("encrypt"),
            "every draw uses a fresh nonce"
        );
        let sealed = EncryptedSecretPayload {
            alg: payload.alg.clone(),
            key_id: payload.key_id.clone(),
            iv: payload.iv.clone(),
            ciphertext: payload.ciphertext.clone(),
            tag: payload.tag.clone(),
        };
        assert_eq!(decrypt_secret(&sealed, KEY).expect("decrypt"), "sk-live");
    }
}
