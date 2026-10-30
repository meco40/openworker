//! Chat history and the model context: the `ChatStore` port.
//!
//! Port of `src/server/channels/messages/historyManager.ts`, `contextBuilder.ts` and the
//! binding step of `channelBindingPersona.ts`.

use std::sync::Arc;

use betaclaw_core::channels::messages::attachments::extract_stored_attachments_from_metadata;
use betaclaw_core::channels::messages::service::commands::persona::channel_binding_persona_id;
use betaclaw_core::channels::messages::service::conversation::ports::MessageRepositoryPort;
use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::ports::{ChatStore, UserMessageOptions};
use betaclaw_core::messages_store::types::{
    ChannelType, Conversation, MessageRole, SaveMessageInput, StoredMessage,
};
use betaclaw_core::model_hub::types::{GatewayMessage, GatewayRole};
use serde_json::Value;

use super::persona::PersonaStore;
use super::repo::MessagesRepo;
use super::{failed, to_i64};

pub struct History {
    repo: Arc<MessagesRepo>,
    personas: Arc<PersonaStore>,
}

impl History {
    pub fn new(repo: Arc<MessagesRepo>, personas: Arc<PersonaStore>) -> Self {
        Self { repo, personas }
    }
}

fn is_set(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|text| !text.is_empty())
}

impl ChatStore for History {
    fn append_user_message(
        &self,
        conversation_id: &str,
        platform: ChannelType,
        content: &str,
        options: UserMessageOptions,
    ) -> PortResult<StoredMessage> {
        let metadata = options.metadata;
        self.repo.run(|s| {
            s.save_message(&SaveMessageInput {
                conversation_id,
                role: MessageRole::User,
                content,
                platform: platform.as_str(),
                external_msg_id: options.external_msg_id.as_deref(),
                sender_name: options.sender_name.as_deref(),
                metadata: metadata.as_ref(),
                client_message_id: options.client_message_id.as_deref(),
            })
        })
    }

    fn append_agent_message(
        &self,
        conversation_id: &str,
        platform: ChannelType,
        content: &str,
        metadata: Option<Value>,
    ) -> PortResult<StoredMessage> {
        self.repo.run(|s| {
            s.save_message(&SaveMessageInput {
                conversation_id,
                role: MessageRole::Agent,
                content,
                platform: platform.as_str(),
                external_msg_id: None,
                sender_name: None,
                metadata: metadata.as_ref(),
                client_message_id: None,
            })
        })
    }

    fn list_recent_messages(
        &self,
        conversation_id: &str,
        user_id: &str,
        limit: usize,
    ) -> PortResult<Vec<StoredMessage>> {
        self.repo
            .run(|s| s.list_messages(conversation_id, to_i64(limit), None, Some(user_id)))
    }

    fn build_gateway_messages(
        &self,
        conversation_id: &str,
        user_id: &str,
        limit: usize,
        persona_id: Option<&str>,
    ) -> PortResult<Vec<GatewayMessage>> {
        let context = self
            .repo
            .run(|s| s.get_conversation_context(conversation_id, Some(user_id)))?;
        let history = self
            .repo
            .run(|s| s.list_messages(conversation_id, to_i64(limit), None, Some(user_id)))?;

        let mut prefix = Vec::new();
        // contextBuilder.ts: the persona instruction first. A failed lookup is skipped, as
        // the TypeScript try/catch does.
        if let Some(persona_id) = persona_id.filter(|id| !id.is_empty()) {
            match self
                .personas
                .run(|repository| repository.persona_system_instruction(persona_id))
            {
                Ok(Some(instruction)) if !instruction.is_empty() => {
                    prefix.push(GatewayMessage::new(GatewayRole::System, instruction));
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::debug!(%error, "persona system instruction unavailable; skipped");
                }
            }
        }

        if let Some(context) = &context {
            let summary = context.summary_text.trim();
            if !summary.is_empty() {
                prefix.push(GatewayMessage::new(
                    GatewayRole::System,
                    format!("Conversation summary: {summary}"),
                ));
            }
        }

        for message in &history {
            // Messages covered by the summary are left out. Messages without a seq stay in.
            if let (Some(context), Some(seq)) = (&context, message.seq) {
                if seq <= context.summary_upto_seq {
                    continue;
                }
            }
            let role = match message.role.as_str() {
                "agent" => GatewayRole::Assistant,
                "system" => GatewayRole::System,
                _ => GatewayRole::User,
            };
            // contextBuilder.ts: the stored attachments travel with the message; the model hub
            // reads them. `attachments` stays absent when the message has none.
            let attachments = extract_stored_attachments_from_metadata(message.metadata.as_deref());
            let mut gateway_message = GatewayMessage::new(role, message.content.clone());
            if !attachments.is_empty() {
                gateway_message.attachments = Some(attachments);
            }
            prefix.push(gateway_message);
        }
        Ok(prefix)
    }

    fn apply_channel_binding_persona(
        &self,
        conversation: &Conversation,
        platform: ChannelType,
    ) -> PortResult<Conversation> {
        // channelBindingPersona.ts: WebChat keeps its own persona, and a conversation that
        // already has one keeps it.
        if platform == ChannelType::WebChat || is_set(&conversation.persona_id) {
            return Ok(conversation.clone());
        }
        let binding = channel_binding_persona_id(&*self.repo, &conversation.user_id, platform)?
            .filter(|id| !id.is_empty());
        let Some(persona_id) = binding else {
            return Ok(conversation.clone());
        };
        self.repo
            .update_persona_id(&conversation.id, Some(&persona_id), &conversation.user_id)
            .map_err(failed)?;
        Ok(Conversation {
            persona_id: Some(persona_id),
            ..conversation.clone()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Scratch;
    use super::*;
    use betaclaw_core::channels::messages::service::conversation::ports::SessionPort;
    use betaclaw_core::channels::messages::service::ports::UserMessageOptions;

    #[test]
    fn appended_user_message_is_listed_and_becomes_model_context() {
        let scratch = Scratch::new();
        let repo = Arc::new(MessagesRepo::open(&scratch.path("messages.db")).expect("open"));
        let personas = Arc::new(
            PersonaStore::open(&scratch.path("personas.db"), &scratch.dir("personas"))
                .expect("personas"),
        );
        let conversation = repo
            .get_or_create_conversation(ChannelType::WebChat, "web-1", None, Some("user-1"))
            .expect("conversation");
        let history = History::new(repo.clone(), personas);

        let stored = history
            .append_user_message(
                &conversation.id,
                ChannelType::WebChat,
                "hallo",
                UserMessageOptions::default(),
            )
            .expect("append");
        assert_eq!(stored.role, "user");

        let listed = history
            .list_recent_messages(&conversation.id, "user-1", 50)
            .expect("list");
        assert_eq!(listed.len(), 1);

        let context = history
            .build_gateway_messages(&conversation.id, "user-1", 50, None)
            .expect("context");
        assert_eq!(context.len(), 1);
        assert_eq!(context[0].role, GatewayRole::User);
        assert_eq!(context[0].content, "hallo");
    }

    #[test]
    fn a_message_with_attachments_becomes_context_and_does_not_refuse_the_turn() {
        let scratch = Scratch::new();
        let repo = Arc::new(MessagesRepo::open(&scratch.path("messages.db")).expect("open"));
        let personas = Arc::new(
            PersonaStore::open(&scratch.path("personas.db"), &scratch.dir("personas"))
                .expect("personas"),
        );
        let conversation = repo
            .get_or_create_conversation(ChannelType::WebChat, "web-3", None, Some("user-1"))
            .expect("conversation");
        let history = History::new(repo.clone(), personas);
        history
            .append_user_message(
                &conversation.id,
                ChannelType::WebChat,
                "siehe Anhang",
                UserMessageOptions {
                    metadata: Some(serde_json::json!({
                        "attachments": [{
                            "name": "a.txt",
                            "mimeType": "text/plain",
                            "size": 3,
                            "storagePath": "u/c/a.txt"
                        }]
                    })),
                    ..Default::default()
                },
            )
            .expect("append");

        let context = history
            .build_gateway_messages(&conversation.id, "user-1", 50, None)
            .expect("the turn is not refused");
        assert_eq!(context.len(), 1);
        assert_eq!(context[0].attachments.as_ref().map(Vec::len), Some(1));
    }

    #[test]
    fn webchat_keeps_its_conversation_unchanged() {
        let scratch = Scratch::new();
        let repo = Arc::new(MessagesRepo::open(&scratch.path("messages.db")).expect("open"));
        let personas = Arc::new(
            PersonaStore::open(&scratch.path("personas.db"), &scratch.dir("personas"))
                .expect("personas"),
        );
        let session = super::super::repo::SessionManager::new(repo.clone());
        let conversation = session
            .get_or_create_conversation(ChannelType::WebChat, "web-2", None, Some("user-1"))
            .expect("conversation");
        let history = History::new(repo, personas);
        let bound = history
            .apply_channel_binding_persona(&conversation, ChannelType::WebChat)
            .expect("bind");
        assert_eq!(bound, conversation);
    }
}
