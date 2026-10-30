//! Port of `src/server/channels/messages/service/execution/subagentExecution.ts`.
//!
//! The TypeScript wrapper rebuilds the executor's dependency object and adds
//! `runModelToolLoop`. The Rust executor already holds those ports, so the
//! functions here forward to [`executor`] and add nothing.

use serde_json::{Map, Value};

use crate::channels::messages::service::execution::ports::{ConversationLookup, PortResult};
use crate::channels::messages::service::subagent::executor;
use crate::channels::messages::service::subagent::types::{RunSubagentParams, SubagentManagerDeps};

pub use crate::channels::messages::service::subagent::executor::{
    SubagentExecutorDeps as SubagentExecutionDeps, SubagentToolCall,
};

/// `runSubagent` of `subagentExecution.ts`.
pub async fn run_subagent(
    deps: &SubagentExecutionDeps,
    params: RunSubagentParams,
) -> PortResult<()> {
    executor::run_subagent(deps, params).await
}

/// `invokeSubagentToolCall` of `subagentExecution.ts`.
pub fn invoke_subagent_tool_call(
    deps: &SubagentExecutionDeps,
    lookup: &ConversationLookup,
    command_deps: &dyn SubagentManagerDeps,
    call: &SubagentToolCall,
) -> PortResult<Map<String, Value>> {
    executor::invoke_subagent_tool_call(deps, lookup, command_deps, call)
}
