//! Port of `src/server/channels/messages/service/subagent/lifecycle/`.

pub mod start;

pub use start::{start_subagent_run, WorkspaceRef, WorkspaceResolver};
