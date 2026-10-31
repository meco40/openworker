//! Channels: chat dispatch, recall, pairing, bridges and the WebSocket protocol.
//!
//! Split out of `betaclaw-core` so a change here rebuilds only this crate and
//! its dependents. Each module names the TypeScript source it mirrors.

// Sibling modules keep their `crate::` paths from the single-crate layout.
use betaclaw_base::auth;
use betaclaw_base::gateway;
use betaclaw_base::safe_error_message;
use betaclaw_memory::memory;
use betaclaw_model_hub::model_hub;
use betaclaw_skills::skills;
use betaclaw_store::messages_store;
use betaclaw_store::personas;
use betaclaw_world_model::world_model;

pub mod channels;
