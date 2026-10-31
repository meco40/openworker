//! Port of `AgentSessionHandle` from `src/server/agent-v2/types.ts`, and the session
//! types of `src/server/agent-v2/session/types.ts`.
//!
//! The other session types are already in [`crate::agent_v2::types`]:
//! `EnqueueCommandParams` is [`EnqueueAgentCommandInput`], `EnqueueCommandResult` is
//! [`EnqueueAgentCommandResult`] (a superset), and `ReplaySessionEventsInput` is
//! [`ReplayEventsInput`]. `StartSessionInput`, the `Enqueue*Params` of the manager
//! facade and `EmitEphemeralEventParams` belong to the ports that use them.

use crate::agent_v2::types::AgentSessionSnapshot;

/// `AgentSessionHandle`: the cached snapshot of one session and its owner.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentSessionHandle {
    pub session_id: String,
    pub user_id: String,
    pub snapshot: AgentSessionSnapshot,
}
