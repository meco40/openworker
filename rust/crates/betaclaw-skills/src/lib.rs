//! Skill handlers, exec approvals, file access policy and the network guard.
//!
//! Split out of `betaclaw-core` so a change here rebuilds only this crate and
//! its dependents. Each module names the TypeScript source it mirrors.

// Sibling modules keep their `crate::` paths from the single-crate layout.
use betaclaw_base::db;
use betaclaw_base::safe_error_message;
use betaclaw_model_hub::model_hub;
use betaclaw_store::personas;
use betaclaw_store::stats;

pub mod net_guard;
pub mod security;
pub mod skills;
