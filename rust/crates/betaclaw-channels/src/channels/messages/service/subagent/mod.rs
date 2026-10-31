//! Port of `src/server/channels/messages/service/subagent/` (S8).
//!
//! `index.ts` is the `SubagentManager` class and lives in [`manager`]. The
//! registry of runs (`@/server/agents/subagentRegistry`) is a trait port here and
//! is implemented by S12.

pub mod actions;
pub mod agent_profiles;
pub mod constants;
pub mod executor;
pub mod lifecycle;
pub mod manager;
pub mod registry;
pub mod types;
pub mod utils;

pub use executor::{
    invoke_subagent_tool_call, run_subagent, SubagentExecutorDeps, SubagentToolCall,
};
pub use manager::SubagentManager;
pub use registry::{SubagentRegistry, SubagentRunRecord, SubagentRunStatus};
pub use types::{ActionResult, SubagentManagerDeps};
