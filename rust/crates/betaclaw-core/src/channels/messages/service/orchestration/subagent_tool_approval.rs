//! Port of `src/server/channels/messages/service/orchestration/subagentToolApproval.ts`.
//!
//! The TypeScript file wires subagent runs, the subagent tool call and tool
//! approvals to the service's dependency bags. In Rust the wiring is explicit:
//! [`SubagentCommandDeps`] is the `CommandHandlerDeps` slice that the subagent
//! actions need, and the `*_operation` functions forward to the executor and the
//! approval handler.

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::channels::messages::service::approval::handler::{
    respond_tool_approval, ApprovalHandlerDeps, ApprovalOutcome, ApprovalParams,
};
use crate::channels::messages::service::execution::ports::{ConversationLookup, PortResult};
use crate::channels::messages::service::ports::SendResponse;
use crate::channels::messages::service::subagent::executor::{
    invoke_subagent_tool_call, run_subagent, SubagentExecutorDeps, SubagentToolCall,
};
use crate::channels::messages::service::subagent::manager::SubagentManager;
use crate::channels::messages::service::subagent::registry::SubagentRunRecord;
use crate::channels::messages::service::subagent::types::{
    RunSubagentParams, StartSubagentRunParams, SubagentManagerDeps,
};

/// `buildCommandHandlerDeps(deps, runSubagentImpl)`, reduced to the subagent part.
/// `startSubagentRun` delegates to the manager. `runSubagent` starts the run on
/// the Tokio runtime without waiting for it, as `void deps.runSubagent(...)` does.
pub struct SubagentCommandDeps {
    manager: Arc<SubagentManager>,
    executor: Arc<SubagentExecutorDeps>,
}

impl SubagentCommandDeps {
    pub fn new(manager: Arc<SubagentManager>, executor: Arc<SubagentExecutorDeps>) -> Self {
        Self { manager, executor }
    }
}

impl SubagentManagerDeps for SubagentCommandDeps {
    fn start_subagent_run(&self, params: StartSubagentRunParams) -> PortResult<SubagentRunRecord> {
        self.manager.start_subagent_run(params)
    }

    fn run_subagent(&self, params: RunSubagentParams) {
        let executor = Arc::clone(&self.executor);
        tokio::spawn(async move {
            if let Err(error) = run_subagent(&executor, params).await {
                tracing::error!(error = %error, "subagent run ended with an error");
            }
        });
    }
}

/// `runSubagentOperation(deps, params)`.
pub async fn run_subagent_operation(
    deps: &SubagentExecutorDeps,
    params: RunSubagentParams,
) -> PortResult<()> {
    run_subagent(deps, params).await
}

/// `invokeSubagentToolCallOperation(deps, getCommandHandlerDeps, params)`. The TS
/// getter is a lazy closure. Rust passes the value, which is cheap to build.
pub fn invoke_subagent_tool_call_operation(
    deps: &SubagentExecutorDeps,
    lookup: &ConversationLookup,
    command_deps: &dyn SubagentManagerDeps,
    call: &SubagentToolCall,
) -> PortResult<Map<String, Value>> {
    invoke_subagent_tool_call(deps, lookup, command_deps, call)
}

/// `respondToolApprovalOperation(deps, params)`.
pub async fn respond_tool_approval_operation(
    deps: &ApprovalHandlerDeps,
    sink: &dyn SendResponse,
    params: &ApprovalParams,
) -> PortResult<ApprovalOutcome> {
    respond_tool_approval(deps, sink, params).await
}
