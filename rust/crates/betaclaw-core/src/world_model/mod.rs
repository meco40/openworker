//! Slice S6 (World Model).
//!
//! Port of `src/server/world-model/`. The directory layout mirrors the
//! TypeScript tree so a reviewer can diff one Rust file against its TypeScript
//! original:
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`mode`] | `mode.ts` |
//! | [`scope`] | `scope.ts` |
//! | [`types`] | `types.ts` |
//! | [`config`] | `config.ts` |
//! | [`db`] | `db.ts` |
//! | [`driver`] | `db.ts` (the `pg` `Pool`/`PoolClient` side) |
//! | [`migrations`] | `db.ts:130-202` + `migrations/*.sql` |
//! | [`production_guard`] | `productionGuard.ts` |
//! | [`mem0_policy`] | `mem0Policy.ts` |
//! | [`consolidation`] | `consolidation/policy.ts`, `consolidation/service.ts` |
//! | [`runtime`] | `runtime/*.ts` |
//! | [`repositories`] | `repositories/*.ts` |
//! | [`retrieval`] | `retrieval/*.ts` |
//! | [`graphiti`] | `graphiti/*.ts` |
//! | [`projector`] | `projector/*.ts` |
//! | [`services`] | `services/*.ts` |
//! | [`embeddings`] | `embeddings/*.ts` |
//! | [`bridge`] | `bridge.ts` |
//! | [`live_chat_bridge`] | `liveChatBridge.ts` |
//! | [`outbox_dispatcher`] | `outboxDispatcher.ts` |
//! | [`metrics`] | `metrics.ts` |
//!
//! # What S6 owns
//!
//! `docs/RUST_MIGRATION.md:85` defines the slice as "pg-Repos, Retrieval,
//! Projector, Outbox, Graphiti-Client". Two consequences are built into this
//! module and are the reason it is not a pure translation:
//!
//! * **The PostgreSQL driver lands here.** `docs/RUST_MIGRATION.md:64` chooses
//!   sqlx, `:546-547` states that `betaclaw-core` owns no PostgreSQL driver
//!   before S6, and the seam comment of `memory/postgres.rs:62-67` promises that
//!   `PgExecutor` and the statement types move next to the world-model module
//!   when S6 lands. [`db`] is that new home, [`driver`] is the one productive
//!   implementation of it, and `memory::postgres` now re-exports the seam
//!   instead of declaring it. No ported behaviour changed with the move.
//! * **The ambient scope becomes an explicit parameter.** The TypeScript uses an
//!   `AsyncLocalStorage` (`db.ts:11`, `:51-60`) that Rust does not have. Every
//!   ported function that reads `getWorldModelScope()` receives the
//!   [`WorldModelScope`](scope::WorldModelScope) as an argument instead. The SQL,
//!   the statement order and the `BEGIN` → `world_model_set_scope` → `COMMIT`
//!   contract (`docs/RUST_MIGRATION.md:199-201`) are unchanged.
//!
//! Still missing in S6: the `api/**` handlers of `/api/world-model`. They carry
//! no slice assignment beyond "the World Model slice"; the routes belong to the
//! `/api/**` migration and stay behind the reverse proxy. `worldModel.ts` is a
//! pure re-export barrel with no `createWorldModel` factory in the source (the
//! earlier note claiming one was wrong); it is ported as [`world_model`], which
//! re-exports the `export *` sources and the ported vocabulary and lists the
//! still-deferred barrel groups.

pub mod bridge;
pub mod config;
pub mod consolidation;
pub mod data_lifecycle;
pub mod db;
pub mod driver;
pub mod embeddings;
pub mod graphiti;
pub mod live_chat_bridge;
pub mod mem0_policy;
pub mod metrics;
pub mod migrations;
pub mod mode;
pub mod outbox_dispatcher;
pub mod production_guard;
pub mod projector;
pub mod repositories;
pub mod retrieval;
pub mod runtime;
pub mod scope;
pub mod services;
pub mod types;
// The TypeScript barrel is `worldModel.ts`, so the port file is
// `world_model/world_model.rs`; the deliberate name clash with its parent
// module is the port contract, not an accident.
#[allow(clippy::module_inception)]
pub mod world_model;
