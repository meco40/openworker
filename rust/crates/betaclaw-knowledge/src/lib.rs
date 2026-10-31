//! Knowledge: ingestion, retrieval and repositories.
//!
//! Split out of `betaclaw-core` so a change here rebuilds only this crate and
//! its dependents. Each module names the TypeScript source it mirrors.

// Sibling modules keep their `crate::` paths from the single-crate layout.
use betaclaw_base::db;
use betaclaw_base::js;
use betaclaw_memory::memory;
use betaclaw_store::messages_store;
use betaclaw_store::personas;
use betaclaw_world_model::world_model;

pub mod knowledge;
