//! Slice S4 (Model Hub).
//!
//! Port of `src/server/model-hub/`. The directory layout mirrors the TypeScript
//! tree so a reviewer can diff one Rust file against its TypeScript original:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`crypto`] | `crypto.ts` |
//! | [`codex_auth`] | `codexAuth.ts` |
//! | [`oauth`] | `oauth.ts` |
//! | [`url_origin`] | `urlOrigin.ts` |
//! | [`types`] | `../shared/contracts/modelHub.ts` + `Models/types.ts` + `repository.ts` |
//! | [`provider_catalog`] | `providerCatalog.ts` |
//! | [`providers`] | `Models/<provider>/index.ts` (16 of 16 adapters) |
//! | [`openai_compatible`] | `Models/shared/openai-compatible/` |
//! | [`http`] | `Models/shared/http.ts` |
//! | [`env`] | the `process.env` reads of the above |
//! | [`repository`] | `repository.ts` |
//! | [`sqlite`] | `repositories/sqliteModelHubRepository.ts` |
//! | [`connectivity`] | `connectivity.ts` |
//! | [`model_fetcher`] | `modelFetcher.ts` |
//! | [`runtime`] | `runtime.ts` |
//! | [`service`] | `gateway.ts` + `service/**` (`index.ts`, `dispatch/chat.ts`, `dispatch/embedding.ts`, `embedding/*`, `pipeline/get.ts`, `pipeline/update.ts`, `provider/connect.ts`, `provider/disconnect.ts`, `provider/refresh.ts`, `types.ts`, `utils.ts`) |
//!
//! The account-level orchestration (`modelFetcher.ts`, `connectivity.ts`) and the
//! service façade (`service/index.ts`) are ported over the injected
//! [`http::HttpTransport`] and [`service::ServiceDependencies`] seams, so no
//! `reqwest` is needed inside `betaclaw-core`. The production transport lives in
//! `betaclaw-gateway` (`model_hub_transport.rs`), which is where OP-16 is closed.
//!
//! [`tests`] holds the shared test doubles; it is compiled only for `cargo test`.

pub mod codex_auth;
pub mod connectivity;
pub mod crypto;
pub mod env;
pub mod http;
pub mod model_fetcher;
pub mod oauth;
pub mod openai_compatible;
pub mod provider_catalog;
pub mod providers;
pub mod repository;
pub mod runtime;
pub mod service;
pub mod sqlite;
pub mod types;
pub mod url_origin;

#[cfg(test)]
mod tests;
