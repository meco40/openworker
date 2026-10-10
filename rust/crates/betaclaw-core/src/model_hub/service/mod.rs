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
use crate::model_hub::openai_compatible::utils::AttachmentStore;

pub use gateway::DispatchObserver;

use gateway::NoopObserver;
use refresh::CodexTokenRefresher;

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

pub mod chat;
pub mod gateway;
pub mod pipeline;
pub mod refresh;
pub mod types;
pub mod utils;

#[cfg(test)]
mod test_doubles;
