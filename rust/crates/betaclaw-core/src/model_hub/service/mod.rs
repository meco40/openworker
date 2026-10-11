//! The Model Hub service layer: pipeline reads, account resolution and the
//! dispatch entry points.
//!
//! Mirrors `src/server/model-hub/service/` plus `gateway.ts`:
//!
//! | Rust            | TypeScript                                        |
//! | --------------- | ------------------------------------------------- |
//! | [`types`]       | `service/types.ts` + constants of `service/utils.ts` |
//! | [`utils`]       | `service/utils.ts`                                |
//! | [`pipeline`]    | `service/pipeline/get.ts`                         |
//! | [`refresh`]     | `service/provider/refresh.ts`                     |
//! | [`chat`]        | `service/dispatch/chat.ts`                        |
//! | [`embedding`]   | `service/dispatch/embedding.ts` + `service/embedding/*` |
//! | [`gateway`]     | `gateway.ts` (`dispatchGatewayRequest`)           |
//!
//! [`gateway`] also carries [`DispatchObserver`], the seam that replaces the
//! six `src/server/stats` imports of `gateway.ts:12-25` and breaks the
//! S4 <-> S12 dependency cycle: the default implementation is a no-op, so a
//! statistics failure can never abort a dispatch.
//!
//! # Why the service is injected, not constructed
//!
//! `betaclaw-core` deliberately owns no HTTP client. The transport, the
//! attachment reader, the statistics observer and the Codex token refresher are
//! all trait objects assembled by the caller, so the dispatch logic stays
//! testable without a network and without the crates that would pull `reqwest`
//! into this crate. [`ServiceDependencies`] is that assembly.

use std::sync::Arc;

use crate::model_hub::env::EnvOverrides;
use crate::model_hub::http::{HttpError, HttpTransport};
use crate::model_hub::model_fetcher::{fetch_models_for_account, FetchPurpose};
use crate::model_hub::openai_compatible::utils::AttachmentStore;
use crate::model_hub::providers::ProviderCall;
use crate::model_hub::repository::ModelHubRepository;
use crate::model_hub::types::{
    CreatePipelineModelInput, FetchedModel, GatewayRequest, GatewayResponse, PipelineModelEntry,
    PipelineStatus, ProviderAccountRecord, ProviderAccountView,
};

pub use gateway::DispatchObserver;

use gateway::NoopObserver;
use provider::{connect_provider_account, disconnect_provider_account};
use refresh::{maybe_refresh_open_ai_codex_account, CodexTokenRefresher};
use types::{ConnectProviderAccountInput, DispatchWithFallbackOptions, EmbeddingInput};

/// Everything the dispatch path needs from the outside world.
///
/// The TypeScript service reaches for module singletons and `fetch` directly;
/// Rust cannot, so the same seams are named explicitly here. The fields borrow
/// from the caller, which is what keeps the call sites free of `Box::new`
/// noise and lets a test hand in a stub by reference.
pub struct ServiceDependencies<'a> {
    /// The HTTP client. `UnreachableTransport` in tests.
    pub transport: &'a dyn HttpTransport,
    /// Reads stored attachment buffers (`readStoredAttachmentBuffer`).
    pub attachments: &'a dyn AttachmentStore,
    /// Receives token-usage and prompt-dispatch events. No-op by default.
    pub observer: &'a dyn DispatchObserver,
    /// Environment lookups, so no code reads `process.env` directly.
    pub env: &'a EnvOverrides,
    /// Refreshes an expiring OpenAI Codex token before dispatch.
    pub codex: &'a dyn CodexTokenRefresher,
}

impl<'a> ServiceDependencies<'a> {
    /// The wiring used by the tests in this module.
    pub fn for_test(
        transport: &'a impl HttpTransport,
        attachments: &'a impl AttachmentStore,
    ) -> Self {
        static NO_OBSERVER: NoopObserver = NoopObserver;
        static NO_CODEX: refresh::NoCodexRefresh = refresh::NoCodexRefresh;
        static ENV: std::sync::OnceLock<EnvOverrides> = std::sync::OnceLock::new();
        Self {
            transport,
            attachments,
            observer: &NO_OBSERVER,
            env: ENV.get_or_init(EnvOverrides::new),
            codex: &NO_CODEX,
        }
    }

    /// Swaps in a recording observer, for the tests that assert statistics.
    pub fn with_observer(mut self, observer: &'a dyn DispatchObserver) -> Self {
        self.observer = observer;
        self
    }

    /// Swaps in a transport that always fails.
    pub fn with_transport(mut self, transport: &'a impl HttpTransport) -> Self {
        self.transport = transport;
        self
    }
}

/// Errors of the service layer.
///
/// The variants exist to keep the TypeScript failure mode visible at the call
/// site: `gateway.ts` catches everything and reports a flat message, and the
/// routes map the result to a status code. Nothing in this enum is a
/// `panic` path.
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    /// Secret encryption or decryption failed.
    #[error("{0}")]
    Crypto(String),
    /// The provider call failed at the transport layer.
    #[error("{0}")]
    Transport(String),
}

impl From<crate::model_hub::crypto::CryptoError> for ServiceError {
    fn from(error: crate::model_hub::crypto::CryptoError) -> Self {
        ServiceError::Crypto(error.to_string())
    }
}

impl From<HttpError> for ServiceError {
    fn from(error: HttpError) -> Self {
        ServiceError::Transport(error.to_string())
    }
}

impl From<crate::model_hub::repository::RepositoryError> for ServiceError {
    fn from(error: crate::model_hub::repository::RepositoryError) -> Self {
        ServiceError::Transport(error.to_string())
    }
}

/// Shared alias so the observer helpers can be passed around cheaply.
pub type SharedObserver = Arc<dyn DispatchObserver>;

/// `ModelHubService` from `service/index.ts:45-165`.
///
/// The TypeScript class holds a repository and reaches for module singletons; the
/// port holds the repository plus the [`ServiceDependencies`] seam, so every
/// method is a thin delegation to the already-ported free functions. No state is
/// cached — `service/index.ts` is stateless apart from the repository, and the
/// process-wide singleton of `runtime.ts` is `get_model_hub_service`.
pub struct ModelHubService<'a> {
    repository: &'a dyn ModelHubRepository,
    dependencies: ServiceDependencies<'a>,
}

impl<'a> ModelHubService<'a> {
    pub fn new(
        repository: &'a dyn ModelHubRepository,
        dependencies: ServiceDependencies<'a>,
    ) -> Self {
        Self {
            repository,
            dependencies,
        }
    }

    pub fn repository(&self) -> &'a dyn ModelHubRepository {
        self.repository
    }

    /// The `ProviderCall` every adapter and fetcher consumes.
    fn provider_call(&self) -> ProviderCall<'_> {
        ProviderCall {
            transport: self.dependencies.transport,
            attachments: self.dependencies.attachments,
            env: self.dependencies.env,
        }
    }

    /// `getUsableAccountByIdInternal` from `service/index.ts:48-55`.
    pub async fn get_usable_account_by_id(
        &self,
        account_id: &str,
        encryption_key: &str,
    ) -> Result<Option<ProviderAccountRecord>, ServiceError> {
        let Some(account) = self.repository.get_account_record_by_id(account_id)? else {
            return Ok(None);
        };
        Ok(Some(
            maybe_refresh_open_ai_codex_account(
                self.repository,
                &account,
                encryption_key,
                self.dependencies.codex,
            )
            .await?,
        ))
    }

    /// `connectAccount(input)` from `service/index.ts:66-68`.
    pub fn connect_account(
        &self,
        input: ConnectProviderAccountInput,
    ) -> Result<ProviderAccountView, ServiceError> {
        connect_provider_account(self.repository, input)
    }

    /// `listAccounts()` from `service/index.ts:70-72`.
    pub fn list_accounts(&self) -> Result<Vec<ProviderAccountView>, ServiceError> {
        Ok(self.repository.list_accounts()?)
    }

    /// `getAccountById(accountId)` from `service/index.ts:74-76`.
    pub fn get_account_by_id(
        &self,
        account_id: &str,
    ) -> Result<Option<ProviderAccountRecord>, ServiceError> {
        Ok(self.repository.get_account_record_by_id(account_id)?)
    }

    /// `updateHealth(accountId, ok, message)` from `service/index.ts:78-80`.
    pub fn update_health(
        &self,
        account_id: &str,
        ok: bool,
        message: Option<&str>,
    ) -> Result<(), ServiceError> {
        Ok(self.repository.set_health_status(account_id, ok, message)?)
    }

    /// `deleteAccount(accountId)` from `service/index.ts:82-84`.
    pub fn delete_account(&self, account_id: &str) -> Result<bool, ServiceError> {
        disconnect_provider_account(self.repository, account_id)
    }

    /// `fetchModelsForAccount(accountId, encryptionKey)` from
    /// `service/index.ts:88-90`.
    pub async fn fetch_models_for_account(
        &self,
        account_id: &str,
        encryption_key: &str,
    ) -> Result<Vec<FetchedModel>, ServiceError> {
        self.fetch_models_for_account_by_purpose(account_id, encryption_key, FetchPurpose::General)
            .await
    }

    /// `fetchModelsForAccountByPurpose(accountId, encryptionKey, purpose)` from
    /// `service/index.ts:92-100`.
    pub async fn fetch_models_for_account_by_purpose(
        &self,
        account_id: &str,
        encryption_key: &str,
        purpose: FetchPurpose,
    ) -> Result<Vec<FetchedModel>, ServiceError> {
        let Some(account) = self
            .get_usable_account_by_id(account_id, encryption_key)
            .await?
        else {
            return Ok(Vec::new());
        };
        let call = self.provider_call();
        fetch_models_for_account(&call, &account, encryption_key, purpose).await
    }
}

/// The pipeline and dispatch half of `service/index.ts:104-165`.
impl<'a> ModelHubService<'a> {
    /// `listPipeline(profileId)` from `service/index.ts:104-106`.
    pub fn list_pipeline(&self, profile_id: &str) -> Result<Vec<PipelineModelEntry>, ServiceError> {
        Ok(pipeline::list_pipeline(self.repository, profile_id)?)
    }

    /// `addModelToPipeline(input)` from `service/index.ts:108-110`.
    pub fn add_model_to_pipeline(
        &self,
        input: CreatePipelineModelInput,
    ) -> Result<PipelineModelEntry, ServiceError> {
        Ok(pipeline::add_model_to_pipeline(self.repository, input)?)
    }

    /// `removeModelFromPipeline(modelId)` from `service/index.ts:112-114`.
    pub fn remove_model_from_pipeline(&self, model_id: &str) -> Result<bool, ServiceError> {
        Ok(pipeline::remove_model_from_pipeline(
            self.repository,
            model_id,
        )?)
    }

    /// `updateModelStatus(modelId, status)` from `service/index.ts:116-118`.
    pub fn update_model_status(
        &self,
        model_id: &str,
        status: PipelineStatus,
    ) -> Result<(), ServiceError> {
        Ok(pipeline::update_model_status(
            self.repository,
            model_id,
            status,
        )?)
    }

    /// `movePipelineModel(profileId, modelId, direction)` from
    /// `service/index.ts:120-122`.
    pub fn move_pipeline_model(
        &self,
        profile_id: &str,
        model_id: &str,
        direction: pipeline::update::PipelineDirection,
    ) -> Result<bool, ServiceError> {
        pipeline::update::move_pipeline_model(self.repository, profile_id, model_id, direction)
    }

    /// `replacePipeline(profileId, models)` from `service/index.ts:124-126`.
    pub fn replace_pipeline(
        &self,
        profile_id: &str,
        models: &[CreatePipelineModelInput],
    ) -> Result<Vec<PipelineModelEntry>, ServiceError> {
        pipeline::update::replace_pipeline(self.repository, profile_id, models)
    }

    /// `dispatchChat(accountId, encryptionKey, request)` from
    /// `service/index.ts:130-146`.
    pub async fn dispatch_chat(
        &self,
        account_id: &str,
        encryption_key: &str,
        request: &GatewayRequest,
    ) -> Result<GatewayResponse, ServiceError> {
        chat::dispatch_chat(
            self.repository,
            account_id,
            encryption_key,
            request,
            &self.dependencies,
        )
        .await
    }

    /// `dispatchWithFallback(profileId, encryptionKey, request, options)` from
    /// `service/index.ts:148-155`.
    pub async fn dispatch_with_fallback(
        &self,
        profile_id: &str,
        encryption_key: &str,
        request: &GatewayRequest,
        options: Option<&DispatchWithFallbackOptions>,
    ) -> Result<GatewayResponse, ServiceError> {
        chat::dispatch_with_fallback(
            self.repository,
            profile_id,
            encryption_key,
            request,
            options,
            &self.dependencies,
        )
        .await
    }

    /// `dispatchEmbedding(encryptionKey, input)` from `service/index.ts:159-164`.
    pub async fn dispatch_embedding(
        &self,
        encryption_key: &str,
        input: &EmbeddingInput,
    ) -> Result<serde_json::Value, ServiceError> {
        embedding::dispatch_embedding(self.repository, encryption_key, input, &self.dependencies)
            .await
    }
}

pub mod chat;
pub mod embedding;
pub mod gateway;
pub mod pipeline;
pub mod provider;
pub mod refresh;
pub mod types;
pub mod utils;

#[cfg(test)]
mod test_doubles;
