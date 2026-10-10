//! Port of `src/server/model-hub/repository.ts`.
//!
//! The TypeScript module declares the two input shapes plus the
//! `ModelHubRepository` interface; [`crate::model_hub::sqlite`] is the only
//! implementation and is a 1:1 translation of
//! `src/server/model-hub/repositories/sqliteModelHubRepository.ts`.
//!
//! The interface is modelled as a Rust trait so the service can be exercised
//! against an in-memory double, mirroring `createMockRepository` in
//! `tests/unit/model-hub/service-core.test.ts`.

use crate::model_hub::types::{
    EncryptedSecretPayloadJson, PipelineModelEntry, PipelineStatus, ProviderAccountRecord,
    ProviderAccountView,
};

/// Re-exported so a caller of [`ModelHubRepository`] can name the input shapes
/// without depending on the layout of [`crate::model_hub::types`].
pub use crate::model_hub::types::{
    CreatePipelineModelInput, CreateProviderAccountInput, PipelineReasoningEffort,
    ProviderAuthMethod, UpdateAccountCredentialsInput,
};

/// Failures of [`ModelHubRepository`].
///
/// The TypeScript class throws `Error` in exactly three places; both
/// `Failed to read inserted …` throws become [`RepositoryError::MissingRow`] with
/// the same message so the app/api layer can forward it verbatim.
#[derive(Debug, thiserror::Error)]
pub enum RepositoryError {
    /// `better-sqlite3` rejected the statement.
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    /// `JSON.parse` failed on a stored `encrypted_secret` /
    /// `encrypted_refresh_token` column.
    #[error("stored secret is not valid JSON: {0}")]
    MalformedSecret(String),
    /// `` throw new Error(`Failed to read inserted account ${id}`) `` and
    /// `` throw new Error(`Failed to read inserted pipeline model ${id}`) ``.
    #[error("{0}")]
    MissingRow(String),
}

impl RepositoryError {
    pub fn inserted_account_not_readable(id: &str) -> Self {
        RepositoryError::MissingRow(format!("Failed to read inserted account {id}"))
    }

    pub fn inserted_pipeline_model_not_readable(id: &str) -> Self {
        RepositoryError::MissingRow(format!("Failed to read inserted pipeline model {id}"))
    }
}

/// `ModelHubRepository` from `repository.ts:55-75`.
pub trait ModelHubRepository: Send + Sync {
    fn create_account(
        &self,
        input: CreateProviderAccountInput,
    ) -> Result<ProviderAccountView, RepositoryError>;

    fn list_accounts(&self) -> Result<Vec<ProviderAccountView>, RepositoryError>;

    fn get_account_record_by_id(
        &self,
        id: &str,
    ) -> Result<Option<ProviderAccountRecord>, RepositoryError>;

    fn update_account_credentials(
        &self,
        input: UpdateAccountCredentialsInput,
    ) -> Result<(), RepositoryError>;

    fn set_health_status(
        &self,
        id: &str,
        ok: bool,
        message: Option<&str>,
    ) -> Result<(), RepositoryError>;

    fn delete_account(&self, id: &str) -> Result<bool, RepositoryError>;

    // Pipeline persistence.

    fn list_pipeline_models(
        &self,
        profile_id: &str,
    ) -> Result<Vec<PipelineModelEntry>, RepositoryError>;

    fn add_pipeline_model(
        &self,
        input: CreatePipelineModelInput,
    ) -> Result<PipelineModelEntry, RepositoryError>;

    fn remove_pipeline_model(&self, id: &str) -> Result<bool, RepositoryError>;

    fn update_pipeline_model_status(
        &self,
        id: &str,
        status: PipelineStatus,
    ) -> Result<(), RepositoryError>;

    fn update_pipeline_model_priority(
        &self,
        id: &str,
        priority: i64,
    ) -> Result<(), RepositoryError>;

    fn replace_pipeline(
        &self,
        profile_id: &str,
        models: &[CreatePipelineModelInput],
    ) -> Result<Vec<PipelineModelEntry>, RepositoryError>;
}

/// Convenience: the JSON mirror of the payload is what `connectProviderAccount`
/// hands to `createAccount`.
pub fn encrypted_secret_input(
    alg: &str,
    key_id: &str,
    iv: &str,
    ciphertext: &str,
    tag: &str,
) -> EncryptedSecretPayloadJson {
    EncryptedSecretPayloadJson {
        alg: alg.to_string(),
        key_id: key_id.to_string(),
        iv: iv.to_string(),
        ciphertext: ciphertext.to_string(),
        tag: tag.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inserted_row_errors_match_the_typescript_messages() {
        assert_eq!(
            RepositoryError::inserted_account_not_readable("acc-1").to_string(),
            "Failed to read inserted account acc-1"
        );
        assert_eq!(
            RepositoryError::inserted_pipeline_model_not_readable("p1").to_string(),
            "Failed to read inserted pipeline model p1"
        );
    }
}
