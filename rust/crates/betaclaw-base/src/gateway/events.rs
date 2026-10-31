//! Gateway event names.
//!
//! Direct copy of `GatewayEvents` in `src/shared/gatewayTypes.ts:57-87`. The
//! `hello-ok` payload advertises this list, so a client can discover what the
//! server supports.

/// Every event name in declaration order. The array order is part of the
/// `hello-ok` payload and therefore part of the contract.
pub const GATEWAY_EVENTS: &[&str] = &[
    "hello-ok",
    "chat.message",
    "chat.message.deleted",
    "chat.stream",
    "chat.aborted",
    "conversation.deleted",
    "conversation.reset",
    "persona.changed",
    "log.entry",
    "presence.update",
    "channels.status",
    "inbox.updated",
    "room.message",
    "room.member.status",
    "room.run.status",
    "room.intervention",
    "room.metrics",
    "agent.v2.session.updated",
    "agent.v2.command.queued",
    "agent.v2.command.started",
    "agent.v2.command.completed",
    "agent.v2.model.delta",
    "agent.v2.tool.started",
    "agent.v2.tool.completed",
    "agent.v2.approval.required",
    "agent.v2.session.completed",
    "agent.v2.error",
    "agent.room.swarm",
    "tick",
];

pub const HELLO_OK: &str = "hello-ok";
pub const CHAT_MESSAGE: &str = "chat.message";
pub const CHAT_MESSAGE_DELETED: &str = "chat.message.deleted";
pub const CHAT_STREAM: &str = "chat.stream";
pub const CHAT_ABORTED: &str = "chat.aborted";
pub const CONVERSATION_DELETED: &str = "conversation.deleted";
pub const CONVERSATION_RESET: &str = "conversation.reset";
pub const PERSONA_CHANGED: &str = "persona.changed";
pub const LOG_ENTRY: &str = "log.entry";
pub const PRESENCE_UPDATE: &str = "presence.update";
pub const CHANNELS_STATUS: &str = "channels.status";
pub const INBOX_UPDATED: &str = "inbox.updated";
pub const ROOM_MESSAGE: &str = "room.message";
pub const ROOM_MEMBER_STATUS: &str = "room.member.status";
pub const ROOM_RUN_STATUS: &str = "room.run.status";
pub const ROOM_INTERVENTION: &str = "room.intervention";
pub const ROOM_METRICS: &str = "room.metrics";
pub const AGENT_ROOM_SWARM: &str = "agent.room.swarm";
pub const TICK: &str = "tick";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_list_has_no_duplicates() {
        let mut sorted: Vec<&str> = GATEWAY_EVENTS.to_vec();
        sorted.sort_unstable();
        let count = sorted.len();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            count,
            "duplicate event name in GATEWAY_EVENTS"
        );
    }

    #[test]
    fn event_list_is_stable() {
        // Guards against accidental reordering, which changes the hello-ok payload.
        assert_eq!(GATEWAY_EVENTS.len(), 29);
        assert_eq!(GATEWAY_EVENTS[0], "hello-ok");
        assert_eq!(GATEWAY_EVENTS[28], "tick");
    }
}
