//! Slice S5 (Memory).
//!
//! Port of `src/server/memory/`. The directory layout mirrors the TypeScript
//! tree so a reviewer can diff one Rust file against its TypeScript original:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`types`] | `src/core/memory/types.ts` + `types.ts` + `mem0/types.ts` |
//! | [`constants`] | `constants.ts` |
//! | [`errors`] | `errors.ts` + `utils/errorDetection.ts` |
//! | [`formatters`] | `formatters/contextFormatter.ts` |
//! | [`lifecycle`] | `lifecycle.ts` |
//! | [`mappers`] | `mappers/nodeMappers.ts` |
//! | [`mem0`] | `mem0/client.ts`, `mem0/index.ts`, `mem0/operations/*`, `mem0/utils/*`, `mem0/sync.ts`, `mem0/constants.ts` |
//! | [`poisoning`] | `security/memoryPoisoningGuard.ts` |
//! | [`postgres`] | `postgresMemoryClient.ts` + `world-model/retrieval/vector.ts` |
//! | [`service`] | `service.ts`, `operations/*`, `userScope.ts`, `world-model/mem0Policy.ts` |
//! | [`subject`] | `subject/detector.ts` |
//! | [`utils`] | `idempotency.ts`, `utils/queryUtils.ts`, `utils/scoring.ts`, `utils/timestamp.ts` |
//! | [`validators`] | `validators/typeValidators.ts` |
//! | [`sqlite`] | `sqliteMemoryRepository.ts` + `sqliteMemoryClient.ts` |
//!
//! Still missing in S5 and deliberately out of this slice: `runtime.ts` (the
//! provider selection that binds a client to the service) and `api/**` (the
//! `/api/memory` handlers). Neither carries a slice assignment in the migration
//! plan: `docs/RUST_MIGRATION.md:84` defines S5 as the postgres/sqlite/mem0
//! providers, and the only memory references there (`:175-176`, `:272-274`)
//! assign `/api/health*`, `/api/doctor` and `/api/events/stream` to S5-S7 —
//! `/api/memory` is never assigned. Both are thin wiring layers, so this module
//! is not yet routed. [`postgres`] is a port of the pgvector client, but it runs
//! through an injected executor: `betaclaw-core` owns no PostgreSQL driver until
//! the World Model slice (S6) brings one, so the live driver is supplied by the
//! caller — see that module's header for what has to be provided.
//!
//! # Where the provider contracts live
//!
//! [`Mem0Client`] and [`MemoryRepository`] are the provider contracts the rest of
//! S5 consumes. They currently sit next to their first implementation in
//! [`sqlite`] because that is the module that needed them; the TypeScript layout
//! puts them in the provider-agnostic `repository.ts` and `mem0/types.ts`. Moving
//! them is a follow-up that must not change their shape. They are re-exported here
//! so callers do not have to reach through the provider module.

pub mod constants;
pub mod errors;
pub mod formatters;
pub mod lifecycle;
pub mod mappers;
pub mod mem0;
pub mod poisoning;
pub mod postgres;
pub mod service;
pub mod sqlite;
pub mod subject;
pub mod types;
pub mod utils;
pub mod validators;

pub use sqlite::client::Mem0Client;
pub use sqlite::repository::MemoryRepository;
