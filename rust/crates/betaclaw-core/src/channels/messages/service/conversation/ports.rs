//! Ports of `src/server/channels/messages/repository.ts` (`MessageRepository`) and of
//! `src/server/channels/messages/sessionManager.ts` (`SessionManager`), as the conversation,
//! maintenance and command modules use them. The SQLite/PostgreSQL store (`messages_store/`, S3)
//! and the session manager implement these traits.
//!
//! The TS optional methods (`getMessage?`, `deleteMessage?`, `isAgentRoomConversation?`,
//! `getChannelBinding?`, `updateChannelBindingPersona?`) have default bodies that return the value
//! the TS guard returns when the method is missing.

use serde_json::{Map, Value};

use crate::auth::LEGACY_LOCAL_USER_ID;
use crate::channels::messages::service::execution::ports::PortError;
use crate::channels::messages::service::ports::{
    ConversationContext, NewConversation, NewProject, ProjectRecord, ProjectState,
};
use crate::messages_store::types::{
    ChannelBinding, ChannelType, Conversation, InboxItemRecord, InboxListInput, InboxListResult,
    StoredMessage,
};

/// Eingabe für `repo.saveMessage` (`SaveMessageInput` in TS, mit owned Feldern).
#[derive(Debug, Clone, PartialEq)]
pub struct NewMessage {
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub platform: ChannelType,
    pub metadata: Option<Map<String, Value>>,
}

pub trait MessageRepositoryPort: Send + Sync {
    fn get_conversation(
        &self,
        id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<Conversation>, PortError>;

    fn get_conversation_by_external_chat(
        &self,
        channel: ChannelType,
        external_chat_id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<Conversation>, PortError>;

    fn get_or_create_conversation(
        &self,
        channel: ChannelType,
        external_chat_id: &str,
        title: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Conversation, PortError>;

    fn list_conversations(
        &self,
        limit: Option<usize>,
        user_id: Option<&str>,
    ) -> Result<Vec<Conversation>, PortError>;

    fn get_default_web_chat_conversation(
        &self,
        user_id: Option<&str>,
    ) -> Result<Conversation, PortError>;

    fn list_messages(
        &self,
        conversation_id: &str,
        limit: Option<usize>,
        before: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Vec<StoredMessage>, PortError>;

    /// `getMessage?`: fehlt die Methode, liefert die TS-Seite `null`.
    fn get_message(
        &self,
        _id: &str,
        _user_id: Option<&str>,
    ) -> Result<Option<StoredMessage>, PortError> {
        Ok(None)
    }

    fn save_message(&self, message: NewMessage) -> Result<StoredMessage, PortError>;

    /// `deleteMessage?`: fehlt die Methode, liefert die TS-Seite `false`.
    fn delete_message(&self, _id: &str, _user_id: &str) -> Result<bool, PortError> {
        Ok(false)
    }

    fn delete_conversation(&self, id: &str, user_id: &str) -> Result<bool, PortError>;

    fn update_persona_id(
        &self,
        id: &str,
        persona_id: Option<&str>,
        user_id: &str,
    ) -> Result<(), PortError>;

    /// `isAgentRoomConversation?`: fehlt die Methode, gilt die Konversation nicht als Agent-Room.
    fn is_agent_room_conversation(
        &self,
        _id: &str,
        _user_id: Option<&str>,
    ) -> Result<bool, PortError> {
        Ok(false)
    }

    /// `getChannelBinding?`: fehlt die Methode, existiert keine Bindung.
    fn get_channel_binding(
        &self,
        _user_id: &str,
        _channel: ChannelType,
    ) -> Result<Option<ChannelBinding>, PortError> {
        Ok(None)
    }

    /// `updateChannelBindingPersona?`: fehlt die Methode, passiert nichts.
    fn update_channel_binding_persona(
        &self,
        _user_id: &str,
        _channel: ChannelType,
        _persona_id: Option<&str>,
    ) -> Result<(), PortError> {
        Ok(())
    }

    /// `repo.createConversation` (`routeCommandStage.ts:47`).
    fn create_conversation(&self, input: &NewConversation) -> Result<Conversation, PortError>;

    /// `repo.updateModelOverride` (`messageService.ts:513-515`).
    fn update_model_override(
        &self,
        id: &str,
        model_override: Option<&str>,
        user_id: &str,
    ) -> Result<(), PortError>;

    /// `repo.getConversationContext` (`summaryService.ts:73`).
    fn get_conversation_context(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<Option<ConversationContext>, PortError>;

    /// `repo.upsertConversationContext` (`summaryService.ts:107`).
    fn upsert_conversation_context(
        &self,
        id: &str,
        summary_text: &str,
        upto_seq: i64,
        user_id: &str,
    ) -> Result<(), PortError>;

    /// `repo.getConversationProjectState` (`projectManagement.ts:69,187`).
    fn get_conversation_project_state(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<ProjectState, PortError>;

    /// `repo.setConversationProjectGuardApproved` (`messageService.ts:427`).
    fn set_conversation_project_guard_approved(
        &self,
        id: &str,
        user_id: &str,
        approved: bool,
    ) -> Result<(), PortError>;

    /// `repo.createProject` (`projectManagement.ts:137`, `projectCommand.ts`).
    fn create_project(&self, input: &NewProject) -> Result<ProjectRecord, PortError>;

    /// `repo.listProjectsByPersona` (`projectManagement.ts:205`).
    fn list_projects_by_persona(
        &self,
        persona_id: &str,
        user_id: &str,
    ) -> Result<Vec<ProjectRecord>, PortError>;

    /// `repo.getProjectByIdOrSlug` (`projectManagement.ts:74`).
    fn get_project_by_id_or_slug(
        &self,
        persona_id: &str,
        user_id: &str,
        id_or_slug: &str,
    ) -> Result<Option<ProjectRecord>, PortError>;

    /// `repo.deleteProjectByIdOrSlug` (`projectCommand.ts`).
    fn delete_project_by_id_or_slug(
        &self,
        persona_id: &str,
        user_id: &str,
        id_or_slug: &str,
    ) -> Result<Option<ProjectRecord>, PortError>;

    /// `repo.setActiveProjectForConversation` (`projectManagement.ts:144`).
    fn set_active_project_for_conversation(
        &self,
        id: &str,
        user_id: &str,
        project_id: Option<&str>,
    ) -> Result<(), PortError>;

    /// `repo.listInbox` (`messageService.ts:187-208`).
    fn list_inbox(&self, input: &InboxListInput<'_>) -> Result<InboxListResult, PortError>;

    /// `repo.getInboxItem` (`messageService.ts:295-297`).
    fn get_inbox_item(&self, id: &str, user_id: &str)
        -> Result<Option<InboxItemRecord>, PortError>;
}

/// `sessionManager`: user and conversation resolution for the web chat and the channels.
pub trait SessionPort: Send + Sync {
    /// `sessionManager.resolveUserId`: leere oder fehlende Ids werden auf den Legacy-Nutzer gesetzt.
    fn resolve_user_id(&self, user_id: Option<&str>) -> String {
        match user_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => id.to_string(),
            None => LEGACY_LOCAL_USER_ID.to_string(),
        }
    }

    /// `sessionManager.getOrCreateConversation(repo, ...)`. The repository is owned by the
    /// adapter, as in [`SessionPort::resolve_conversation_for_web_chat`].
    fn get_or_create_conversation(
        &self,
        channel: ChannelType,
        external_chat_id: &str,
        title: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Conversation, PortError>;

    /// `resolveConversationForWebChat(repo, conversationId, userId)`. An empty
    /// `conversation_id` selects the default web chat. The repository is owned by
    /// the adapter, so it is not a parameter here.
    fn resolve_conversation_for_web_chat(
        &self,
        conversation_id: &str,
        user_id: &str,
    ) -> Result<Conversation, PortError>;
}
