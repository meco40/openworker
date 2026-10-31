//! SQLite provider of the memory store.
//!
//! | TypeScript                                     | Rust                     |
//! | ---------------------------------------------- | ------------------------ |
//! | `sqliteMemoryRepository.ts`                    | [`repository`]           |
//! | `sqliteMemoryClient.ts`                        | [`client`]               |
//! | (`migrate()` of the repository)                | [`migrations`]           |
//!
//! The repository owns the two tables `memory_nodes` and `memory_node_history`;
//! the client wraps it in the provider contract (`Mem0Client`) that the memory
//! service consumes. Splitting the two is deliberate: the repository has no
//! provider semantics, and the client is where the tenant scope and the
//! workspace matching live.

pub mod client;
pub mod migrations;
pub mod repository;

pub use client::{default_memory_db_path, SqliteMemoryClient};
pub use migrations::{has_column, run_migrations};
pub use repository::SqliteMemoryRepository;
