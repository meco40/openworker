//! Port of `src/server/model-hub/service/provider/disconnect.ts` (1-8).
//!
//! A one-line delegation to `repository.deleteAccount`; `true` when a row was
//! removed, `false` when the id was unknown.

use crate::model_hub::repository::ModelHubRepository;

use super::super::ServiceError;

/// `disconnectProviderAccount(repository, accountId)` from `disconnect.ts:3-8`.
pub fn disconnect_provider_account(
    repository: &dyn ModelHubRepository,
    account_id: &str,
) -> Result<bool, ServiceError> {
    Ok(repository.delete_account(account_id)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::sqlite::SqliteModelHubRepository;

    /// `disconnect.ts:7`: an unknown id reports `false`, a known one `true`.
    #[test]
    fn disconnect_reports_whether_a_row_was_removed() {
        let repository = SqliteModelHubRepository::in_memory().expect("in-memory database");
        assert!(!disconnect_provider_account(&repository, "missing").expect("delete"));

        let view = repository
            .create_account(crate::model_hub::types::CreateProviderAccountInput {
                provider_id: "openai".to_string(),
                label: "acc".to_string(),
                auth_method: crate::model_hub::types::ProviderAuthMethod::ApiKey,
                encrypted_secret: crate::model_hub::repository::encrypted_secret_input(
                    "aes-256-gcm",
                    "default",
                    "iv",
                    "cipher",
                    "tag",
                ),
                encrypted_refresh_token: None,
                secret_masked: "****".to_string(),
            })
            .expect("create");

        assert!(disconnect_provider_account(&repository, &view.id).expect("delete"));
        assert!(!disconnect_provider_account(&repository, &view.id).expect("delete again"));
    }
}
