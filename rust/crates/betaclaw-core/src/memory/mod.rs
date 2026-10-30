//! Slice S5 (Memory).
//!
//! Port of `src/server/memory/`. The directory layout mirrors the TypeScript
//! tree so a reviewer can diff one Rust file against its TypeScript original:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`types`] | `src/core/memory/types.ts` + `types.ts` + `mem0/types.ts` |
//! | [`constants`] | `constants.ts` |
//! | [`core_memory`] | `src/core/memory/gemini.ts` + `src/core/memory/index.ts` |
//! | [`errors`] | `errors.ts` + `utils/errorDetection.ts` |
//! | [`formatters`] | `formatters/contextFormatter.ts` |
//! | [`lifecycle`] | `lifecycle.ts` |
//! | [`mappers`] | `mappers/nodeMappers.ts` |
//! | [`mem0`] | `mem0/client.ts`, `mem0/index.ts`, `mem0/operations/*`, `mem0/utils/*`, `mem0/sync.ts`, `mem0/constants.ts` |
//! | [`mem0_embedder_sync`] | `mem0EmbedderSync.ts` |
//! | [`poisoning`] | `security/memoryPoisoningGuard.ts` |
//! | [`postgres`] | `postgresMemoryClient.ts` + `world-model/retrieval/vector.ts` |
//! | [`repository`] | `repository.ts` (the provider contract) |
//! | [`runtime`] | `runtime.ts` |
//! | [`api`] | `api/**` (the five `/api/memory` handlers as service functions) |
//! | [`service`] | `service.ts`, `operations/*`, `userScope.ts`, `world-model/mem0Policy.ts` |
//! | [`subject`] | `subject/detector.ts` |
//! | [`utils`] | `idempotency.ts`, `utils/queryUtils.ts`, `utils/scoring.ts`, `utils/timestamp.ts` |
//! | [`validators`] | `validators/typeValidators.ts` |
//! | [`sqlite`] | `sqliteMemoryRepository.ts` + `sqliteMemoryClient.ts` |
//!
//! Still open in S5: nothing mounts the `/api/memory` routes. [`api`] is the
//! service layer and returns the status and body a route forwards; the route
//! itself is the gateway's (open point OP-10). [`runtime`] takes its client from an
//! injected factory, so the gateway decides which provider is built. [`postgres`]
//! is a port of the pgvector client, but it runs through an injected executor:
//! `betaclaw-core` owns no PostgreSQL driver until the World Model slice (S6)
//! brings one, so the live driver is supplied by the caller — see that module's
//! header for what has to be provided.
//!
//! # Where the provider contracts live
//!
//! [`Mem0Client`] and [`MemoryRepository`] are the provider contracts the rest of
//! S5 consumes. They live in provider-neutral modules, matching the TypeScript
//! layout: [`MemoryRepository`] in [`repository`] (`repository.ts`) and
//! [`Mem0Client`] in [`types`] (`mem0/types.ts`). Both are re-exported from their
//! original `sqlite` paths ([`sqlite::client::Mem0Client`],
//! [`sqlite::repository::MemoryRepository`]) so nothing that imported them there
//! breaks, and here so callers do not have to reach through the provider module
//! (open point OP-15).

pub mod api;
pub mod constants;
pub mod core_memory;
pub mod errors;
pub mod formatters;
pub mod lifecycle;
pub mod mappers;
pub mod mem0;
pub mod mem0_embedder_sync;
pub mod poisoning;
pub mod postgres;
pub mod repository;
pub mod runtime;
pub mod service;
pub mod sqlite;
pub mod subject;
pub mod types;
pub mod utils;
pub mod validators;

pub use repository::MemoryRepository;
pub use types::Mem0Client;
