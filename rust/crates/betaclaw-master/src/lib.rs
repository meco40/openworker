//! Master: runs, approvals, notes, reminders, delegation and connectors.
//!
//! Split out of `betaclaw-core` so a change here rebuilds only this crate and
//! its dependents. Each module names the TypeScript source it mirrors.

// Sibling modules keep their `crate::` paths from the single-crate layout.
use betaclaw_base::auth;
use betaclaw_base::db;
use betaclaw_base::js;
use betaclaw_model_hub::model_hub;
use betaclaw_store::personas;

pub mod master;
