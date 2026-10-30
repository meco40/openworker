//! Port of `src/server/channels/messages/service/approval/` (S8).

pub mod handler;

pub use handler::{
    respond_tool_approval, ApprovalHandlerDeps, ApprovalOutcome, ApprovalParams, ApprovalStatus,
};
