//! Ports for the WS methods that have no core port yet.
//!
//! The S8 methods use the traits in `betaclaw_core::channels::ws::ports`. The
//! traits here cover the Agent Room swarm (`agent-v2/registerSwarmMethods.ts`) and
//! `inbox.list` (`channels.ts`). The family implementations of these traits are
//! the integrator's job.

use betaclaw_core::channels::ws::helpers::HandlerError;
use betaclaw_core::messages_store::{InboxListInput, InboxListResult};
use serde_json::{Map, Value};

/// Agent Room swarm persistence (`getSwarmRepository()` in `agent-v2/helpers.ts`).
///
/// Swarms are JSON objects with the field names of the TypeScript repository
/// (`id`, `userId`, `title`, `task`, `leadPersonaId`, `units`, `currentPhase`,
/// `status`, `artifact`, `artifactHistory`, `phaseBuffer`, `updatedAt`, ...). The
/// handlers read and write those fields directly, so the wire shape stays the same.
pub trait SwarmStore: Send + Sync {
    /// `messageService.isAgentRoomConversation(id, userId)`.
    fn is_agent_room_conversation(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<bool, HandlerError>;

    /// `repo.createAgentRoomSwarm(input)`. `input` is the full record without `id`
    /// and `updatedAt`. Returns the stored record.
    fn create(&self, input: Value) -> Result<Value, HandlerError>;

    /// `repo.listAgentRoomSwarms(userId, limit)`.
    fn list(&self, user_id: &str, limit: u64) -> Result<Vec<Value>, HandlerError>;

    /// `repo.getAgentRoomSwarm(id, userId)`.
    fn get(&self, id: &str, user_id: &str) -> Result<Option<Value>, HandlerError>;

    /// `repo.updateAgentRoomSwarm(id, userId, patch)`. `patch` holds only the keys to
    /// change. Returns the updated record, or `None` when the swarm does not exist.
    fn update(
        &self,
        id: &str,
        user_id: &str,
        patch: Map<String, Value>,
    ) -> Result<Option<Value>, HandlerError>;

    /// `repo.deleteAgentRoomSwarm(id, userId)`. `false` when nothing was deleted.
    fn delete(&self, id: &str, user_id: &str) -> Result<bool, HandlerError>;
}

/// `service.listInbox(...)`: one page of the user's conversations.
pub trait InboxStore: Send + Sync {
    fn list_inbox(&self, input: InboxListInput<'_>) -> Result<InboxListResult, HandlerError>;
}

/// `consumeInboxRateLimit(transport, key)` from `channels/inbox/rateLimit.ts`.
pub trait InboxRateLimit: Send + Sync {
    /// `true` when the request is allowed.
    fn allow(&self, transport: &str, key: &str) -> bool;
}
