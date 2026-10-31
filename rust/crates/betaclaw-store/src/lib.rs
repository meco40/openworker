//! SQLite stores shared by most domains: stats, personas and messages.
//!
//! Split out of `betaclaw-core` so a change here rebuilds only this crate and
//! its dependents. Each module names the TypeScript source it mirrors.

// Sibling modules keep their `crate::` paths from the single-crate layout.
use betaclaw_base::db;
use betaclaw_base::gateway_config;
use betaclaw_base::safe_error_message;
use betaclaw_model_hub::model_hub;

pub mod messages_store;
pub mod personas;
pub mod stats;
