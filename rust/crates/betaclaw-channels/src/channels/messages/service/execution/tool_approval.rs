//! Port of `src/server/channels/messages/service/execution/toolApproval.ts`.
//!
//! The TypeScript wrapper injects `runModelToolLoop` into the handler. In Rust the
//! loop is a port on [`ApprovalHandlerDeps`], so this module is a forwarder.

use crate::channels::messages::service::approval::handler;
pub use crate::channels::messages::service::approval::{
    ApprovalHandlerDeps as ToolApprovalDeps, ApprovalOutcome as ToolApprovalResult, ApprovalParams,
};
use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::ports::SendResponse;

/// `respondToolApproval(deps, sendResponse, params)` of `toolApproval.ts`.
pub async fn respond_tool_approval(
    deps: &ToolApprovalDeps,
    sink: &dyn SendResponse,
    params: &ApprovalParams,
) -> PortResult<ToolApprovalResult> {
    handler::respond_tool_approval(deps, sink, params).await
}
