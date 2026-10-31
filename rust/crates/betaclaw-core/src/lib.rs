//! Shared backend primitives for the Rust control plane.
//!
//! Everything in this crate is a port of an existing TypeScript module and must
//! stay behaviour-compatible. Each module names the TypeScript source it mirrors
//! so contract drift is traceable in review.
//!
//! The domains live in their own crates so a change rebuilds only the crate it
//! touches and its dependents. This crate re-exports them under their old
//! `betaclaw_core::<module>` paths and keeps the two modules that depend on
//! nearly every domain.

pub use betaclaw_base::{
    auth, config, db, gateway, gateway_config, js, logging, safe_error_message,
};
pub use betaclaw_channels::channels;
pub use betaclaw_features::{
    agent_room, agent_v2, agents, automation, clawhub, debug, proactive, tasks,
};
pub use betaclaw_knowledge::knowledge;
pub use betaclaw_master::master;
pub use betaclaw_memory::memory;
pub use betaclaw_model_hub::model_hub;
pub use betaclaw_skills::{net_guard, security, skills};
pub use betaclaw_store::{messages_store, personas, stats};
pub use betaclaw_world_model::world_model;

pub mod diagnostics;
pub mod migration_runner;
