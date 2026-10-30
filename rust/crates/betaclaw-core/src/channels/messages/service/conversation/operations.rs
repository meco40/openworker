//! Port of `src/server/channels/messages/service/conversation/operations.ts` (S8).
//!
//! Thin wrappers: every read resolves the user id through the session port first, as the TS
//! functions do. `isAgentRoomConversationRecord` from `routing/modelRouting.ts` is ported here,
//! because the conversation operations are its only caller in this slice.

use crate::channels::messages::service::conversation::ports::{MessageRepositoryPort, SessionPort};
use crate::channels::messages::service::execution::ports::PortError;
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};

/// `ConversationOperationDeps` from `operations.ts:10-13`.
pub struct ConversationDeps<'a> {
    pub repo: &'a dyn MessageRepositoryPort,
    pub session: &'a dyn SessionPort,
}

pub fn list_conversations(
    deps: &ConversationDeps<'_>,
    user_id: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<Conversation>, PortError> {
    let resolved = deps.session.resolve_user_id(user_id);
    deps.repo.list_conversations(limit, Some(&resolved))
}

pub fn get_or_create_conversation(
    deps: &ConversationDeps<'_>,
    channel: ChannelType,
    external_chat_id: &str,
    title: Option<&str>,
    user_id: Option<&str>,
) -> Result<Conversation, PortError> {
    deps.session
        .get_or_create_conversation(channel, external_chat_id, title, user_id)
}

pub fn get_default_web_chat_conversation(
    deps: &ConversationDeps<'_>,
    user_id: Option<&str>,
) -> Result<Conversation, PortError> {
    let resolved = deps.session.resolve_user_id(user_id);
    deps.repo.get_default_web_chat_conversation(Some(&resolved))
}

pub fn get_conversation(
    deps: &ConversationDeps<'_>,
    conversation_id: &str,
    user_id: Option<&str>,
) -> Result<Option<Conversation>, PortError> {
    let resolved = deps.session.resolve_user_id(user_id);
    deps.repo.get_conversation(conversation_id, Some(&resolved))
}

pub fn get_conversation_by_external_chat(
    deps: &ConversationDeps<'_>,
    channel: ChannelType,
    external_chat_id: &str,
    user_id: Option<&str>,
) -> Result<Option<Conversation>, PortError> {
    let resolved = deps.session.resolve_user_id(user_id);
    deps.repo
        .get_conversation_by_external_chat(channel, external_chat_id, Some(&resolved))
}

/// `isAgentRoomConversation` from `operations.ts:67-75`.
pub fn is_agent_room_conversation(
    deps: &ConversationDeps<'_>,
    conversation_id: &str,
    user_id: Option<&str>,
) -> Result<bool, PortError> {
    match get_conversation(deps, conversation_id, user_id)? {
        None => Ok(false),
        Some(conversation) => is_agent_room_conversation_record(&conversation, deps.repo),
    }
}

/// `isAgentRoomConversationRecord` from `routing/modelRouting.ts:48-57`.
pub fn is_agent_room_conversation_record(
    conversation: &Conversation,
    repo: &dyn MessageRepositoryPort,
) -> Result<bool, PortError> {
    if conversation.channel_type == ChannelType::AgentRoom.as_str() {
        return Ok(true);
    }
    repo.is_agent_room_conversation(&conversation.id, Some(&conversation.user_id))
}

pub fn list_messages(
    deps: &ConversationDeps<'_>,
    conversation_id: &str,
    user_id: Option<&str>,
    limit: Option<usize>,
    before: Option<&str>,
) -> Result<Vec<StoredMessage>, PortError> {
    let resolved = deps.session.resolve_user_id(user_id);
    deps.repo
        .list_messages(conversation_id, limit, before, Some(&resolved))
}

pub fn get_message(
    deps: &ConversationDeps<'_>,
    message_id: &str,
    user_id: Option<&str>,
) -> Result<Option<StoredMessage>, PortError> {
    let resolved = deps.session.resolve_user_id(user_id);
    deps.repo.get_message(message_id, Some(&resolved))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::conversation::fakes::{
        conversation, FakeRepo, FakeSession,
    };
    use crate::messages_store::types::LEGACY_LOCAL_USER_ID;

    #[test]
    fn reads_resolve_a_blank_user_id_before_the_repository_call() {
        let repo = FakeRepo {
            conversations: vec![conversation("c1", "user-1", None, "WebChat")],
            ..FakeRepo::default()
        };
        let session = FakeSession;
        let deps = ConversationDeps {
            repo: &repo,
            session: &session,
        };

        let found = get_conversation(&deps, "c1", Some("   ")).unwrap();

        assert!(found.is_none());
        assert_eq!(
            repo.seen_user_ids.lock().unwrap().clone(),
            vec![LEGACY_LOCAL_USER_ID.to_string()]
        );
    }

    #[test]
    fn agent_room_channel_short_circuits_before_the_repository() {
        let repo = FakeRepo::default();
        let room = conversation("room-1", "user-1", None, "AgentRoom");

        assert!(is_agent_room_conversation_record(&room, &repo).unwrap());
    }

    #[test]
    fn agent_room_flag_of_the_repository_is_used_for_other_channels() {
        let repo = FakeRepo {
            agent_room_ids: vec!["c9".to_string()],
            ..FakeRepo::default()
        };
        let session = FakeSession;
        let deps = ConversationDeps {
            repo: &repo,
            session: &session,
        };
        let web = conversation("c9", "user-1", None, "WebChat");
        let other = conversation("c8", "user-1", None, "WebChat");

        assert!(is_agent_room_conversation_record(&web, &repo).unwrap());
        assert!(!is_agent_room_conversation_record(&other, &repo).unwrap());
        assert!(!is_agent_room_conversation(&deps, "missing", None).unwrap());
    }
}
