//! Smaller domains: agents, agent room, agent v2, automation, clawhub, debug, proactive and tasks.
//!
//! Split out of `betaclaw-core` so a change here rebuilds only this crate and
//! its dependents. Each module names the TypeScript source it mirrors.

// Sibling modules keep their `crate::` paths from the single-crate layout.
use betaclaw_base::db;
use betaclaw_base::js;
use betaclaw_base::safe_error_message;
use betaclaw_store::messages_store;
use betaclaw_store::stats;

pub mod agent_room;
pub mod agent_v2;
pub mod agents;
pub mod automation;
pub mod clawhub;
pub mod debug;
pub mod proactive;
pub mod tasks;
