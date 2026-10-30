//! Side effects of a stored chat message: broadcasts, inbox items, the world-model bridge and
//! the outbound delivery.
//!
//! Port of `src/server/gateway/broadcast.ts` (through `betaclaw_core::gateway::broadcast`),
//! `src/server/channels/inbox/events.ts`, `src/server/world-model/liveChatBridge.ts` and
//! `src/server/channels/outbound/router.ts` (the [`Outbound`] senders).

use std::collections::HashMap;
use std::future::ready;
use std::sync::{Arc, Mutex, PoisonError};

use betaclaw_core::channels::adapters::discord::deliver_discord;
use betaclaw_core::channels::adapters::imessage::deliver_imessage;
use betaclaw_core::channels::adapters::slack::deliver_slack;
use betaclaw_core::channels::adapters::telegram::api::TelegramApi;
use betaclaw_core::channels::adapters::telegram::outbound::{TelegramSender, TelegramTextOptions};
use betaclaw_core::channels::adapters::whatsapp::deliver_whatsapp;
use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::ports::{
    BoxFuture, ChatEvents, SummaryRefreshedEvent,
};
use betaclaw_core::channels::pairing::credentials::{ChannelCredentialStore, ChannelEnv};
use betaclaw_core::gateway::broadcast::broadcast_to_user;
use betaclaw_core::gateway::events::{CHAT_MESSAGE, INBOX_UPDATED};
use betaclaw_core::gateway::registry::SharedRegistry;
use betaclaw_core::messages_store::types::{now_iso, ChannelType, Conversation, StoredMessage};
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::personas::telegram_bots::PersonaTelegramBotRegistry;
use betaclaw_core::world_model::config::WorldModelConfig;
use betaclaw_core::world_model::live_chat_bridge::{
    bridge_stored_chat_message, BridgeStoredChatMessageInput, ConversationRecord,
    StoredMessageRecord,
};
use serde_json::{json, Value};

use super::failed;
use super::world::PgHandle;

/// The outbound senders of `outbound/router.ts`. WebChat and Agent Room deliver nothing here,
/// because their output goes out on the websocket. The five external platforms go to their
/// adapter. The adapters read their tokens from the credential store and the environment.
pub struct Outbound {
    transport: Arc<dyn HttpTransport>,
    credentials: Arc<dyn ChannelCredentialStore>,
    env: Arc<ChannelEnv>,
    telegram: TelegramSender,
    bots: Mutex<PersonaTelegramBotRegistry>,
}

impl Outbound {
    pub fn new(
        transport: Arc<dyn HttpTransport>,
        credentials: Arc<dyn ChannelCredentialStore>,
        bots: PersonaTelegramBotRegistry,
    ) -> Self {
        let env = Arc::new(ChannelEnv::new());
        let telegram = TelegramSender::new(
            TelegramApi::new(transport.clone()),
            credentials.clone(),
            env.clone(),
        );
        Self {
            transport,
            credentials,
            env,
            telegram,
            bots: Mutex::new(bots),
        }
    }

    /// The token of the persona's active Telegram bot, `None` when it has none.
    fn persona_token(&self, persona_id: &str) -> Option<String> {
        let bots = self.bots.lock().unwrap_or_else(PoisonError::into_inner);
        bots.get_bot_by_persona_id(persona_id)
            .ok()
            .flatten()
            .filter(|bot| bot.active)
            .map(|bot| bot.token)
    }

    /// `deliverOutbound(platform, externalChatId, content, { personaId })`. A failed adapter is
    /// an error, which `ResponseHelper` logs after the message is stored.
    pub async fn deliver(
        &self,
        platform: ChannelType,
        external_chat_id: &str,
        content: &str,
        persona_id: Option<&str>,
    ) -> Result<(), String> {
        let transport = self.transport.as_ref();
        let env = self.env.as_ref();
        let credentials = self.credentials.as_ref();
        let outcome = match platform {
            ChannelType::WebChat | ChannelType::AgentRoom => Ok(None),
            ChannelType::Telegram => {
                let options = TelegramTextOptions {
                    persona_token: persona_id.and_then(|id| self.persona_token(id)),
                    ..Default::default()
                };
                self.telegram
                    .deliver(external_chat_id, content, &options)
                    .await
            }
            ChannelType::WhatsApp => {
                let metadata = persona_id.map(|id| json!({ "personaId": id }));
                deliver_whatsapp(transport, env, external_chat_id, content, metadata.as_ref()).await
            }
            ChannelType::Discord => {
                deliver_discord(transport, credentials, env, external_chat_id, content).await
            }
            ChannelType::Slack => {
                deliver_slack(transport, credentials, env, external_chat_id, content).await
            }
            ChannelType::IMessage => {
                deliver_imessage(transport, env, external_chat_id, content).await
            }
        };
        outcome.map(|_| ()).map_err(|error| error.0)
    }
}

/// `INBOX_V2_EVENTS_ENABLED`, read as `events.ts` does: an empty value means the default
/// (`true`), and only the literal `false` turns the events off.
pub fn inbox_events_enabled(env: &HashMap<String, String>) -> bool {
    env.get("INBOX_V2_EVENTS_ENABLED")
        .map(|value| value.to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "true".to_string())
        != "false"
}

/// `buildInboxItemFromConversation` (`inbox/events.ts:21-40`).
fn inbox_item(conversation: &Conversation, last: &StoredMessage) -> Value {
    json!({
        "conversationId": conversation.id,
        "channelType": conversation.channel_type,
        "title": conversation.title,
        "updatedAt": conversation.updated_at,
        "lastMessage": {
            "id": last.id,
            "role": last.role,
            "content": last.content,
            "createdAt": last.created_at,
            "platform": last.platform,
        },
    })
}

fn has_persona(conversation: &Conversation) -> bool {
    conversation
        .persona_id
        .as_deref()
        .is_some_and(|id| !id.is_empty())
}

pub struct ChatBroadcast {
    registry: SharedRegistry,
    world_model: WorldModelConfig,
    pg: Arc<PgHandle>,
    inbox_events_enabled: bool,
    outbound: Outbound,
}

impl ChatBroadcast {
    pub fn new(
        registry: SharedRegistry,
        world_model: WorldModelConfig,
        pg: Arc<PgHandle>,
        inbox_events_enabled: bool,
        outbound: Outbound,
    ) -> Self {
        Self {
            registry,
            world_model,
            pg,
            inbox_events_enabled,
            outbound,
        }
    }
}

impl ChatEvents for ChatBroadcast {
    fn message_persisted(&self, _conversation: &Conversation, _message: &StoredMessage) {
        // ponytail: `chat.message.persisted` goes to the TypeScript server event bus. No Rust
        // subscriber exists yet, so the event has no listener to reach.
    }

    fn broadcast_chat_message(&self, user_id: &str, message: &StoredMessage) {
        broadcast_to_user(
            &self.registry,
            user_id,
            CHAT_MESSAGE,
            serde_json::to_value(message).ok(),
        );
    }

    fn build_inbox_item(&self, conversation: &Conversation, message: &StoredMessage) -> Value {
        inbox_item(conversation, message)
    }

    fn emit_inbox_updated(&self, user_id: &str, action: &str, conversation_id: &str, item: Value) {
        if !self.inbox_events_enabled {
            return;
        }
        broadcast_to_user(
            &self.registry,
            user_id,
            INBOX_UPDATED,
            Some(json!({
                "version": "v2",
                "action": action,
                "conversationId": conversation_id,
                "item": item,
                "serverTs": now_iso(),
            })),
        );
    }

    fn bridge_stored_message(
        &self,
        conversation: Conversation,
        message: StoredMessage,
    ) -> BoxFuture<'_, PortResult<()>> {
        // liveChatBridge.ts: a conversation without a persona is skipped, and so is a world
        // model that is off (bridge.ts, `!enabled && !e2eEnabled`).
        let world_model_off = !self.world_model.enabled && !self.world_model.e2e_enabled;
        if !has_persona(&conversation) || world_model_off {
            return Box::pin(ready(Ok(())));
        }
        Box::pin(async move {
            let executor = self.pg.executor().map_err(failed)?;
            let input = BridgeStoredChatMessageInput {
                conversation: ConversationRecord {
                    id: conversation.id,
                    user_id: conversation.user_id,
                    persona_id: conversation.persona_id,
                    workspace_id: conversation.workspace_id,
                },
                message: StoredMessageRecord {
                    id: message.id,
                    conversation_id: message.conversation_id,
                    seq: message.seq,
                    role: Some(message.role),
                    content: Some(message.content),
                    created_at: Some(message.created_at),
                    platform: Some(message.platform),
                    sender_name: message.sender_name,
                },
            };
            bridge_stored_chat_message(executor.as_ref(), &self.world_model, &input, None)
                .await
                .map(|_| ())
                .map_err(failed)
        })
    }

    fn deliver_outbound(
        &self,
        platform: ChannelType,
        external_chat_id: String,
        content: String,
        persona_id: Option<String>,
    ) -> BoxFuture<'_, PortResult<()>> {
        Box::pin(async move {
            self.outbound
                .deliver(platform, &external_chat_id, &content, persona_id.as_deref())
                .await
                .map_err(failed)
        })
    }

    fn summary_refreshed(&self, _event: SummaryRefreshedEvent) {
        // ponytail: `chat.summary.refreshed` goes to the TypeScript server event bus. No Rust
        // subscriber exists yet.
    }
}

#[cfg(test)]
mod tests {
    use super::super::repo::MessagesRepo;
    use super::super::test_support::Scratch;
    use super::*;
    use betaclaw_core::gateway::registry::ClientRegistry;
    use std::sync::Arc;

    #[test]
    fn the_inbox_flag_defaults_on_and_only_false_turns_it_off() {
        let mut env = HashMap::new();
        assert!(inbox_events_enabled(&env));
        env.insert("INBOX_V2_EVENTS_ENABLED".into(), "".into());
        assert!(inbox_events_enabled(&env));
        env.insert("INBOX_V2_EVENTS_ENABLED".into(), "FALSE".into());
        assert!(!inbox_events_enabled(&env));
    }

    #[tokio::test]
    async fn bridge_is_skipped_without_persona_and_webchat_needs_no_sender() {
        let scratch = Scratch::new();
        let repo = MessagesRepo::open(&scratch.path("messages.db")).expect("open");
        let conversation = repo
            .run(|s| s.get_or_create_conversation("WebChat", "web-1", None, Some("user-1")))
            .expect("conversation");
        let message = repo
            .run(|s| {
                s.save_message(&betaclaw_core::messages_store::types::SaveMessageInput {
                    conversation_id: &conversation.id,
                    role: betaclaw_core::messages_store::types::MessageRole::User,
                    content: "hallo",
                    platform: "WebChat",
                    external_msg_id: None,
                    sender_name: None,
                    metadata: None,
                    client_message_id: None,
                })
            })
            .expect("message");

        let config =
            betaclaw_core::world_model::config::resolve_world_model_config(&HashMap::new());
        let outbound = Outbound::new(
            Arc::new(betaclaw_core::model_hub::http::UnreachableTransport),
            Arc::new(MessagesRepo::open(&scratch.path("messages.db")).expect("credentials")),
            PersonaTelegramBotRegistry::open(&scratch.path("personas.db")).expect("bots"),
        );
        let pg = Arc::new(PgHandle::new(&config));
        let events =
            ChatBroadcast::new(Arc::new(ClientRegistry::new()), config, pg, true, outbound);
        events
            .bridge_stored_message(conversation.clone(), message.clone())
            .await
            .expect("no persona, nothing to bridge");

        // WebChat and Agent Room go out on the websocket, so no sender is called for them.
        assert!(events
            .deliver_outbound(ChannelType::WebChat, "w".into(), "x".into(), None)
            .await
            .is_ok());
        assert!(events
            .deliver_outbound(ChannelType::AgentRoom, "a".into(), "x".into(), None)
            .await
            .is_ok());

        let item = events.build_inbox_item(&conversation, &message);
        assert_eq!(item["conversationId"], json!(conversation.id));
        assert_eq!(item["lastMessage"]["content"], json!("hallo"));
    }
}
