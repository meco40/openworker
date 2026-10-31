//! Model Hub: providers, pipeline, account crypto and embeddings.
//!
//! Split out of `betaclaw-core` so a change here rebuilds only this crate and
//! its dependents. Each module names the TypeScript source it mirrors.

// Sibling modules keep their `crate::` paths from the single-crate layout.
use betaclaw_base::db;

pub mod model_hub;
