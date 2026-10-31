//! In-memory test doubles for the message repository and session ports (test builds only).

use std::collections::HashMap;
use std::sync::Mutex;

use crate::channels::messages::service::conversation::ports::{
    MessageRepositoryPort, NewMessage, SessionPort,
};
use crate::channels::messages::service::execution::ports::PortError;
use crate::channels::messages::service::ports::{
    NewConversation, NewProject, ProjectRecord, ProjectState,
};
use crate::messages_store::types::{
    ChannelBinding, ChannelType, Conversation, InboxItemRecord, InboxListInput, InboxListResult,
    StoredMessage, LEGACY_LOCAL_USER_ID,
};

pub fn conversation(
    id: &str,
    user_id: &str,
    persona_id: Option<&str>,
    channel: &str,
) -> Conversation {
    Conversation {
        id: id.to_string(),
        channel_type: channel.to_string(),
        external_chat_id: None,
        user_id: user_id.to_string(),
        workspace_id: None,
        title: format!("Chat {id}"),
        model_override: None,
        persona_id: persona_id.map(str::to_string),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

pub fn stored_message(id: &str, conversation_id: &str, role: &str, content: &str) -> StoredMessage {
    StoredMessage {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        seq: None,
        role: role.to_string(),
        content: content.to_string(),
        platform: "WebChat".to_string(),
        external_msg_id: None,
        sender_name: None,
        metadata: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

pub fn channel_binding(user_id: &str, channel: &str, persona_id: &str) -> ChannelBinding {
    ChannelBinding {
        user_id: user_id.to_string(),
        channel: channel.to_string(),
        status: "active".to_string(),
        external_peer_id: None,
        peer_name: None,
        transport: None,
        metadata: None,
        persona_id: Some(persona_id.to_string()),
        last_seen_at: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

/// Repository double. Optional TS methods that are not overridden keep the port defaults.
#[derive(Default)]
pub struct FakeRepo {
    pub conversations: Vec<Conversation>,
    pub messages: Vec<StoredMessage>,
    pub agent_room_ids: Vec<String>,
    /// Channel key (`ChannelType::as_str`) to persona id.
    pub bindings: Mutex<HashMap<String, String>>,
    pub seen_user_ids: Mutex<Vec<String>>,
    pub saved: Mutex<Vec<NewMessage>>,
    pub persona_updates: Mutex<Vec<(String, Option<String>)>>,
    pub deleted_conversations: Mutex<Vec<String>>,
    pub deleted_messages: Mutex<Vec<String>>,
    /// Project rows (`createProject` appends, deletion removes).
    pub projects: Mutex<Vec<ProjectRecord>>,
    /// `activeProjectId` of the single conversation the project tests use.
    pub active_project: Mutex<Option<String>>,
}

impl MessageRepositoryPort for FakeRepo {
    fn get_conversation(
        &self,
        id: &str,
        user_id: Option<&str>,
    ) -> Result<Option<Conversation>, PortError> {
        self.seen_user_ids
            .lock()
            .unwrap()
            .push(user_id.unwrap_or_default().to_string());
        Ok(self
            .conversations
            .iter()
            .find(|c| c.id == id && user_id.is_none_or(|u| c.user_id == u))
            .cloned())
    }

    fn get_conversation_by_external_chat(
        &self,
        _channel: ChannelType,
        _external_chat_id: &str,
        _user_id: Option<&str>,
    ) -> Result<Option<Conversation>, PortError> {
        Ok(None)
    }

    fn get_or_create_conversation(
        &self,
        channel: ChannelType,
        _external_chat_id: &str,
        _title: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Conversation, PortError> {
        Ok(conversation(
            "created",
            user_id.unwrap_or(LEGACY_LOCAL_USER_ID),
            None,
            channel.as_str(),
        ))
    }

    fn list_conversations(
        &self,
        _limit: Option<usize>,
        _user_id: Option<&str>,
    ) -> Result<Vec<Conversation>, PortError> {
        Ok(self.conversations.clone())
    }

    fn get_default_web_chat_conversation(
        &self,
        user_id: Option<&str>,
    ) -> Result<Conversation, PortError> {
        Ok(conversation(
            "web-default",
            user_id.unwrap_or(LEGACY_LOCAL_USER_ID),
            None,
            ChannelType::WebChat.as_str(),
        ))
    }

    fn list_messages(
        &self,
        conversation_id: &str,
        _limit: Option<usize>,
        _before: Option<&str>,
        _user_id: Option<&str>,
    ) -> Result<Vec<StoredMessage>, PortError> {
        Ok(self
            .messages
            .iter()
            .filter(|m| m.conversation_id == conversation_id)
            .cloned()
            .collect())
    }

    fn get_message(
        &self,
        id: &str,
        _user_id: Option<&str>,
    ) -> Result<Option<StoredMessage>, PortError> {
        Ok(self.messages.iter().find(|m| m.id == id).cloned())
    }

    fn save_message(&self, message: NewMessage) -> Result<StoredMessage, PortError> {
        let mut saved = self.saved.lock().unwrap();
        let id = format!("saved-{}", saved.len() + 1);
        let stored = stored_message(
            &id,
            &message.conversation_id,
            &message.role,
            &message.content,
        );
        saved.push(message);
        Ok(stored)
    }

    fn delete_message(&self, id: &str, _user_id: &str) -> Result<bool, PortError> {
        self.deleted_messages.lock().unwrap().push(id.to_string());
        Ok(true)
    }

    fn delete_conversation(&self, id: &str, _user_id: &str) -> Result<bool, PortError> {
        self.deleted_conversations
            .lock()
            .unwrap()
            .push(id.to_string());
        Ok(true)
    }

    fn update_persona_id(
        &self,
        id: &str,
        persona_id: Option<&str>,
        _user_id: &str,
    ) -> Result<(), PortError> {
        self.persona_updates
            .lock()
            .unwrap()
            .push((id.to_string(), persona_id.map(str::to_string)));
        Ok(())
    }

    fn is_agent_room_conversation(
        &self,
        id: &str,
        _user_id: Option<&str>,
    ) -> Result<bool, PortError> {
        Ok(self.agent_room_ids.iter().any(|room| room == id))
    }

    fn get_channel_binding(
        &self,
        user_id: &str,
        channel: ChannelType,
    ) -> Result<Option<ChannelBinding>, PortError> {
        Ok(self
            .bindings
            .lock()
            .unwrap()
            .get(channel.as_str())
            .map(|persona| channel_binding(user_id, channel.as_str(), persona)))
    }

    fn update_channel_binding_persona(
        &self,
        _user_id: &str,
        channel: ChannelType,
        persona_id: Option<&str>,
    ) -> Result<(), PortError> {
        let mut bindings = self.bindings.lock().unwrap();
        match persona_id {
            Some(persona) => bindings.insert(channel.as_str().to_string(), persona.to_string()),
            None => bindings.remove(channel.as_str()),
        };
        Ok(())
    }

    fn create_conversation(&self, input: &NewConversation) -> Result<Conversation, PortError> {
        Ok(conversation(
            "created",
            input.user_id.as_deref().unwrap_or(LEGACY_LOCAL_USER_ID),
            None,
            input.channel_type.as_str(),
        ))
    }

    fn update_model_override(
        &self,
        _id: &str,
        _model_override: Option<&str>,
        _user_id: &str,
    ) -> Result<(), PortError> {
        Ok(())
    }

    fn get_conversation_context(
        &self,
        _id: &str,
        _user_id: &str,
    ) -> Result<Option<crate::channels::messages::service::ports::ConversationContext>, PortError>
    {
        Ok(None)
    }

    fn upsert_conversation_context(
        &self,
        _id: &str,
        _summary_text: &str,
        _upto_seq: i64,
        _user_id: &str,
    ) -> Result<(), PortError> {
        Ok(())
    }

    fn get_conversation_project_state(
        &self,
        _id: &str,
        _user_id: &str,
    ) -> Result<ProjectState, PortError> {
        Ok(ProjectState {
            active_project_id: self.active_project.lock().unwrap().clone(),
            guard_approved_without_project: false,
        })
    }

    fn set_conversation_project_guard_approved(
        &self,
        _id: &str,
        _user_id: &str,
        _approved: bool,
    ) -> Result<(), PortError> {
        Ok(())
    }

    fn create_project(&self, input: &NewProject) -> Result<ProjectRecord, PortError> {
        let mut projects = self.projects.lock().unwrap();
        let record = ProjectRecord {
            id: format!("proj-{}", projects.len() + 1),
            name: input.name.clone(),
            slug: input.name.to_lowercase().replace(' ', "-"),
            workspace_path: input.workspace_path.clone(),
            workspace_relative_path: input.workspace_relative_path.clone(),
        };
        projects.push(record.clone());
        Ok(record)
    }

    fn list_projects_by_persona(
        &self,
        _persona_id: &str,
        _user_id: &str,
    ) -> Result<Vec<ProjectRecord>, PortError> {
        Ok(self.projects.lock().unwrap().clone())
    }

    fn get_project_by_id_or_slug(
        &self,
        _persona_id: &str,
        _user_id: &str,
        id_or_slug: &str,
    ) -> Result<Option<ProjectRecord>, PortError> {
        Ok(self
            .projects
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.id == id_or_slug || p.slug == id_or_slug)
            .cloned())
    }

    fn delete_project_by_id_or_slug(
        &self,
        persona_id: &str,
        user_id: &str,
        id_or_slug: &str,
    ) -> Result<Option<ProjectRecord>, PortError> {
        let found = self.get_project_by_id_or_slug(persona_id, user_id, id_or_slug)?;
        if let Some(project) = &found {
            self.projects.lock().unwrap().retain(|p| p.id != project.id);
        }
        Ok(found)
    }

    fn set_active_project_for_conversation(
        &self,
        _id: &str,
        _user_id: &str,
        project_id: Option<&str>,
    ) -> Result<(), PortError> {
        *self.active_project.lock().unwrap() = project_id.map(str::to_string);
        Ok(())
    }

    fn list_inbox(&self, _input: &InboxListInput<'_>) -> Result<InboxListResult, PortError> {
        unreachable!("not used by the conversation and project tests")
    }

    fn get_inbox_item(
        &self,
        _id: &str,
        _user_id: &str,
    ) -> Result<Option<InboxItemRecord>, PortError> {
        unreachable!("not used by the conversation and project tests")
    }
}

/// Session double: blank ids become the legacy user, as `SessionManager.resolveUserId` does.
pub struct FakeSession;

impl SessionPort for FakeSession {
    fn resolve_user_id(&self, user_id: Option<&str>) -> String {
        user_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(LEGACY_LOCAL_USER_ID)
            .to_string()
    }

    fn get_or_create_conversation(
        &self,
        channel: ChannelType,
        _external_chat_id: &str,
        _title: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<Conversation, PortError> {
        let resolved = self.resolve_user_id(user_id);
        Ok(conversation("created", &resolved, None, channel.as_str()))
    }

    fn resolve_conversation_for_web_chat(
        &self,
        _conversation_id: &str,
        _user_id: &str,
    ) -> Result<Conversation, PortError> {
        Err(PortError::Failed(
            "web chat resolution is not faked here".to_string(),
        ))
    }
}
