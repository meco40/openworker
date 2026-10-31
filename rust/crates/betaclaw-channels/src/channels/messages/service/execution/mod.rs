//! Port of `src/server/channels/messages/service/execution/` (S8).
//!
//! [`ports`] holds the cross-slice contracts that the other S8 modules use.

pub mod build_execution;
pub mod ports;
pub mod subagent_execution;
pub mod tool_approval;

#[cfg(test)]
pub(crate) mod test_doubles;
