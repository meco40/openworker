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
//! | [`providers`] | `Models/<provider>/index.ts` (7 of 15 adapters) |
//! | [`openai_compatible`] | `Models/shared/openai-compatible/` |
//! | [`http`] | `Models/shared/http.ts` |
//! | [`env`] | the `process.env` reads of the above |
//! | [`repository`] | `repository.ts` |
//! | [`sqlite`] | `repositories/sqliteModelHubRepository.ts` |
//!
//! Still missing in S4a and deliberately out of this slice: `gateway.ts`
//! (`dispatchGatewayRequest`), `service/**` (`dispatchWithFallback`,
//! `dispatchEmbedding`, `getUsableAccountById`, `listPipeline`), `modelFetcher.ts`
//! and `connectivity.ts`. They need `reqwest` (the transport lives in
//! `betaclaw-gateway`) and the stats/prompt-dispatch side effects, so they follow
//! in S4b once the HTTP client is wired up.
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
