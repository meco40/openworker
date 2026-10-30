//! Port of `src/server/channels/messages/service/orchestration/` (S8).

pub mod subagent_tool_approval;

pub use subagent_tool_approval::{
    invoke_subagent_tool_call_operation, respond_tool_approval_operation, run_subagent_operation,
    SubagentCommandDeps,
};
