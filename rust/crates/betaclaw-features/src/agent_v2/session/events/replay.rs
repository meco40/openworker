//! Port of `src/server/agent-v2/session/events/replay.ts`.
//!
//! The replay window and the expiry error are in `event_repository.rs`
//! ([`AgentV2Repository::replay_events`]). These functions pass the call through.

use crate::agent_v2::errors::AgentV2Error;
use crate::agent_v2::repository::AgentV2Repository;
use crate::agent_v2::types::{EventEnvelope, ReplayEventsInput};

/// `replaySessionEvents`.
pub fn replay_session_events(
    repository: &AgentV2Repository,
    input: &ReplayEventsInput,
) -> Result<Vec<EventEnvelope>, AgentV2Error> {
    repository.replay_events(input)
}

/// `getCommandResult`: the terminal event of a command. It is found without the seq
/// cursor, so it works when the session's `lastSeq` is stale.
pub fn get_command_result(
    repository: &AgentV2Repository,
    command_id: &str,
    session_id: &str,
) -> Result<Option<EventEnvelope>, AgentV2Error> {
    repository.get_command_result(command_id, session_id)
}
