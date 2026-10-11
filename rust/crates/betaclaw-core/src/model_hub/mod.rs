//! Slice S4 (Model Hub).
//!
//! Port of `src/server/model-hub/`. The directory layout mirrors the TypeScript
//! tree so a reviewer can diff one Rust file against its TypeScript original:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`crypto`] | `crypto.ts` |
//! | [`types`] | `../shared/contracts/modelHub.ts` + `Models/types.ts` + `repository.ts` |
//! | [`provider_catalog`] | `providerCatalog.ts` |
//! | [`providers`] | `Models/<provider>/index.ts` (15 of 15 adapters) |
//! | [`openai_compatible`] | `Models/shared/openai-compatible/` |
//! | [`http`] | `Models/shared/http.ts` |
//! | [`env`] | the `process.env` reads of the above |
//! | [`repository`] | `repository.ts` |
//! | [`sqlite`] | `repositories/sqliteModelHubRepository.ts` |
//! | [`service`] | `gateway.ts` + `service/**` (`dispatch/chat.ts`, `dispatch/embedding.ts`, `embedding/*`, `pipeline/get.ts`, `provider/refresh.ts`, `types.ts`, `utils.ts`) |
//!
//! Still missing and deliberately out of this slice: `modelFetcher.ts`
//! (`fetchModelsForAccount`, `src/server/model-hub/modelFetcher.ts:43`) and
//! `connectivity.ts` (`testProviderAccountConnectivity`,
//! `src/server/model-hub/connectivity.ts:12`) — the account-level orchestration
//! layered on top of the already ported provider adapters. Those two still need
//! `reqwest` (the transport lives in `betaclaw-gateway`) and the
//! stats/prompt-dispatch side effects. That reasoning no longer holds for
//! `gateway.ts` and `service/**`: both are ported through injected seams, see
//! [`service`].
//!
//! [`tests`] holds the shared test doubles; it is compiled only for `cargo test`.

pub mod crypto;
pub mod env;
pub mod http;
pub mod openai_compatible;
pub mod provider_catalog;
pub mod providers;
pub mod repository;
pub mod service;
pub mod sqlite;
pub mod types;

#[cfg(test)]
mod tests;
