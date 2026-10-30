//! Port of `src/server/channels/pairing/telegramInbound.ts`.
//!
//! The pairing gate and the order of its steps are ported as in the source:
//! group migration, the gate for unpaired chats, the native-command check and
//! then the dispatch. Everything after the command check needs the message
//! service, the media download, the model selection or a persona bot. Those
//! steps sit behind [`TelegramInboundPort`], which the chat dispatch implements.
//!
//! Persona-bound bots (a [`TelegramBotContext`]) skip the gate, as in the source.

use std::sync::Arc;

use chrono::{Local, Utc};
use tracing::info;

use super::credentials::{ChannelCredentialStore, ChannelEnv};
use super::telegram_code::{
    ensure_telegram_pairing_code, is_telegram_chat_authorized, migrate_telegram_paired_chat_id,
    EnsureCode,
};
use crate::channels::adapters::telegram::group_migration::resolve_telegram_group_migration;
use crate::channels::adapters::telegram::outbound::{TelegramSender, TelegramTextOptions};
use crate::channels::adapters::telegram::types::{
    TelegramCallbackQuery, TelegramMessage, TelegramUpdate,
};
use crate::channels::adapters::types::{non_empty, ChannelError};
use crate::model_hub::http::BoxFuture;

/// `TelegramBotContext`: the persona-bound bot a message arrived through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelegramBotContext {
    pub bot_id: String,
    pub persona_id: String,
    pub token: String,
}

/// `TelegramInboundProcessResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct InboundOutcome {
    pub handled: bool,
    pub code_issued: bool,
}

/// What the dispatch receives for a message that passed the gate.
pub struct TelegramDispatch<'a> {
    pub message: &'a TelegramMessage,
    pub external_chat_id: &'a str,
    pub sender_name: &'a str,
    pub external_msg_id: &'a str,
    /// Token for the media download: the persona bot's, else
    /// `TELEGRAM_BOT_TOKEN`, else the stored one.
    pub bot_token: Option<String>,
    pub bot_context: Option<&'a TelegramBotContext>,
}

/// The steps of the inbound path that need other slices.
pub trait TelegramInboundPort: Send + Sync {
    /// `handleTelegramNativeCommand`. `true` when the text was a native command
    /// and it was run.
    fn handle_native_command<'a>(
        &'a self,
        chat_id: &'a str,
        text: &'a str,
        external_chat_id: &'a str,
    ) -> BoxFuture<'a, Result<bool, ChannelError>>;

    /// `processTelegramModelCallback`.
    fn handle_model_callback<'a>(
        &'a self,
        query: &'a TelegramCallbackQuery,
    ) -> BoxFuture<'a, Result<bool, ChannelError>>;

    /// Conversation, persona, media and `handleInbound`, in that order. `true`
    /// when a message was dispatched.
    fn dispatch_message<'a>(
        &'a self,
        dispatch: TelegramDispatch<'a>,
    ) -> BoxFuture<'a, Result<bool, ChannelError>>;
}

/// `resolveTelegramConversationExternalChatId`. A forum topic gets its own
/// conversation. Topic 1 of a forum is the general topic and maps to the chat.
pub fn resolve_conversation_external_chat_id(message: &TelegramMessage) -> String {
    let base = message.chat.id.to_string();
    let thread = match message.message_thread_id {
        Some(thread) if thread > 0 => thread,
        _ => return base,
    };
    if message.chat.kind == "private" {
        return format!("{base}:topic:{thread}");
    }
    let is_forum_group = message.chat.kind == "supergroup" && message.chat.is_forum == Some(true);
    if !is_forum_group || thread == 1 {
        return base;
    }
    format!("{base}:topic:{thread}")
}

/// `message.from?.username || message.from?.first_name || 'user-<id>'`.
fn sender_name(message: &TelegramMessage) -> String {
    match &message.from {
        Some(from) => from
            .username
            .clone()
            .filter(|name| !name.is_empty())
            .or_else(|| from.first_name.clone().filter(|name| !name.is_empty()))
            .unwrap_or_else(|| format!("user-{}", from.id)),
        None => "user-undefined".to_string(),
    }
}

#[derive(Clone)]
pub struct TelegramInbound {
    store: Arc<dyn ChannelCredentialStore>,
    env: Arc<ChannelEnv>,
    sender: TelegramSender,
    port: Arc<dyn TelegramInboundPort>,
}

impl TelegramInbound {
    pub fn new(
        store: Arc<dyn ChannelCredentialStore>,
        env: Arc<ChannelEnv>,
        sender: TelegramSender,
        port: Arc<dyn TelegramInboundPort>,
    ) -> Self {
        Self {
            store,
            env,
            sender,
            port,
        }
    }

    /// `processTelegramInboundMessage`.
    pub async fn process_message(
        &self,
        message: &TelegramMessage,
        bot_context: Option<&TelegramBotContext>,
    ) -> Result<InboundOutcome, ChannelError> {
        if let Some(migration) = resolve_telegram_group_migration(
            message.chat.id,
            message.migrate_to_chat_id,
            message.migrate_from_chat_id,
        ) {
            if migrate_telegram_paired_chat_id(
                self.store.as_ref(),
                &migration.old_chat_id,
                &migration.new_chat_id,
            ) {
                info!(
                    "[Telegram] Group migration applied: {} -> {}",
                    migration.old_chat_id, migration.new_chat_id
                );
            }
        }

        let chat_id = message.chat.id.to_string();
        if bot_context.is_none() && !is_telegram_chat_authorized(self.store.as_ref(), &chat_id) {
            return self.gate_unpaired_chat(&chat_id).await;
        }

        let external_chat_id = resolve_conversation_external_chat_id(message);
        let command_text = message
            .text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        if let Some(text) = command_text {
            if self
                .port
                .handle_native_command(&chat_id, text, &external_chat_id)
                .await?
            {
                return Ok(InboundOutcome {
                    handled: true,
                    code_issued: false,
                });
            }
        }

        let sender = sender_name(message);
        let external_msg_id = message.message_id.to_string();
        let bot_token = bot_context
            .map(|context| context.token.clone())
            .filter(|token| !token.is_empty())
            .or_else(|| non_empty(self.env.get("TELEGRAM_BOT_TOKEN")))
            .or_else(|| non_empty(self.store.get_credential("telegram", "bot_token")));
        let handled = self
            .port
            .dispatch_message(TelegramDispatch {
                message,
                external_chat_id: &external_chat_id,
                sender_name: &sender,
                external_msg_id: &external_msg_id,
                bot_token,
                bot_context,
            })
            .await?;
        Ok(InboundOutcome {
            handled,
            code_issued: false,
        })
    }

    /// `processTelegramInboundUpdate`.
    pub async fn process_update(
        &self,
        update: &TelegramUpdate,
        bot_context: Option<&TelegramBotContext>,
    ) -> Result<InboundOutcome, ChannelError> {
        if let Some(query) = &update.callback_query {
            let callback_chat_id = query
                .message
                .as_ref()
                .and_then(|message| message.chat.as_ref())
                .map(|chat| chat.id);
            if let (None, Some(chat_id)) = (bot_context, callback_chat_id) {
                if !is_telegram_chat_authorized(self.store.as_ref(), &chat_id.to_string()) {
                    self.sender
                        .answer_callback_query(&query.id, Some("Pairing required."), false)
                        .await?;
                    return Ok(InboundOutcome {
                        handled: true,
                        code_issued: false,
                    });
                }
            }
            let handled = self.port.handle_model_callback(query).await?;
            return Ok(InboundOutcome {
                handled,
                code_issued: false,
            });
        }

        match &update.message {
            Some(message) => self.process_message(message, bot_context).await,
            None => Ok(InboundOutcome::default()),
        }
    }

    /// The branch of `processTelegramInboundMessage` for a chat that is not paired.
    async fn gate_unpaired_chat(&self, chat_id: &str) -> Result<InboundOutcome, ChannelError> {
        let notice = match ensure_telegram_pairing_code(self.store.as_ref(), chat_id, Utc::now())? {
            EnsureCode::Issued {
                code, expires_at, ..
            } => {
                let expiration = expires_at
                    .with_timezone(&Local)
                    .format("%H:%M")
                    .to_string();
                self.sender
                    .deliver(
                        chat_id,
                        &format!("Pairing code: {code}\nEnter this in the Web UI before {expiration}."),
                        &TelegramTextOptions::default(),
                    )
                    .await?;
                return Ok(InboundOutcome {
                    handled: false,
                    code_issued: true,
                });
            }
            EnsureCode::Blocked { .. } => {
                "Pairing is already pending in another chat. Complete the code entry in the Web UI first."
            }
            EnsureCode::AlreadyBound { .. } => {
                "This bot is already paired with another chat. Re-run pairing from the Web UI to switch chats."
            }
            EnsureCode::AlreadyConnected => return Ok(InboundOutcome::default()),
        };
        self.sender
            .deliver(chat_id, notice, &TelegramTextOptions::default())
            .await?;
        Ok(InboundOutcome::default())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::{json, Value};

    use super::*;
    use crate::channels::adapters::telegram::api::TelegramApi;
    use crate::channels::pairing::test_support::{
        isolated_env, json_response, memory_store, RecordingPort, ScriptedTransport,
    };

    fn message(value: Value) -> TelegramMessage {
        serde_json::from_value(value).expect("a valid message")
    }

    struct Harness {
        inbound: TelegramInbound,
        store: Arc<dyn ChannelCredentialStore>,
        transport: Arc<ScriptedTransport>,
        port: Arc<RecordingPort>,
    }

    fn harness() -> Harness {
        let transport = ScriptedTransport::new();
        transport.then(
            "sendMessage",
            json_response(200, json!({"ok": true, "result": {"message_id": 5}})),
        );
        let store = memory_store();
        store.set_credential("telegram", "bot_token", "1:t");
        let env = isolated_env();
        let api = TelegramApi::new(transport.clone()).with_backoff(Duration::ZERO);
        let sender = TelegramSender::new(api, store.clone(), env.clone());
        let port = Arc::new(RecordingPort::default());
        let inbound = TelegramInbound::new(store.clone(), env, sender, port.clone());
        Harness {
            inbound,
            store,
            transport,
            port,
        }
    }

    fn private_message(text: &str) -> TelegramMessage {
        message(json!({
            "message_id": 1,
            "chat": {"id": 42, "type": "private"},
            "from": {"id": 7, "username": "alice"},
            "text": text,
        }))
    }

    #[test]
    fn the_external_chat_id_separates_forum_topics_only() {
        let topic = message(json!({
            "message_id": 1, "chat": {"id": 42, "type": "private"}, "message_thread_id": 5
        }));
        assert_eq!(resolve_conversation_external_chat_id(&topic), "42:topic:5");

        let forum = |thread: i64| {
            message(json!({
                "message_id": 1,
                "chat": {"id": -100, "type": "supergroup", "is_forum": true},
                "message_thread_id": thread,
            }))
        };
        assert_eq!(resolve_conversation_external_chat_id(&forum(1)), "-100");
        assert_eq!(
            resolve_conversation_external_chat_id(&forum(9)),
            "-100:topic:9"
        );

        let plain_group = message(json!({
            "message_id": 1, "chat": {"id": -100, "type": "group"}, "message_thread_id": 9
        }));
        assert_eq!(resolve_conversation_external_chat_id(&plain_group), "-100");
    }

    #[tokio::test]
    async fn an_unpaired_chat_receives_a_code_and_nothing_is_dispatched() {
        let h = harness();

        let outcome = h
            .inbound
            .process_message(&private_message("hello"), None)
            .await
            .expect("processed");

        assert_eq!(
            outcome,
            InboundOutcome {
                handled: false,
                code_issued: true
            }
        );
        let sent = h.transport.calls("sendMessage");
        let body = ScriptedTransport::body_of(&sent[0]);
        assert!(body["text"]
            .as_str()
            .expect("text")
            .starts_with("Pairing code: "));
        assert!(h.port.dispatched.lock().unwrap().is_empty());
        assert_eq!(
            h.store
                .get_credential("telegram", "pending_chat_id")
                .as_deref(),
            Some("42")
        );
    }

    #[tokio::test]
    async fn a_paired_chat_reaches_the_dispatch_with_its_conversation_id() {
        let h = harness();
        h.store
            .set_credential("telegram", "pairing_status", "connected");
        h.store.set_credential("telegram", "paired_chat_id", "42");

        let outcome = h
            .inbound
            .process_message(&private_message("hello"), None)
            .await
            .expect("processed");

        assert!(outcome.handled);
        assert_eq!(*h.port.dispatched.lock().unwrap(), vec!["42".to_string()]);
    }

    #[tokio::test]
    async fn a_native_command_short_circuits_the_dispatch() {
        let transport = ScriptedTransport::new();
        let store = memory_store();
        store.set_credential("telegram", "pairing_status", "connected");
        store.set_credential("telegram", "paired_chat_id", "42");
        let env = isolated_env();
        let sender = TelegramSender::new(
            TelegramApi::new(transport.clone()),
            store.clone(),
            env.clone(),
        );
        let port = Arc::new(RecordingPort {
            native_command_handled: true,
            ..RecordingPort::default()
        });
        let inbound = TelegramInbound::new(store, env, sender, port.clone());

        let outcome = inbound
            .process_message(&private_message("/new"), None)
            .await
            .expect("processed");

        assert!(outcome.handled);
        assert!(port.dispatched.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_persona_bot_skips_the_gate() {
        let h = harness();
        let context = TelegramBotContext {
            bot_id: "b1".into(),
            persona_id: "p1".into(),
            token: "9:bot".into(),
        };

        let outcome = h
            .inbound
            .process_message(&private_message("hello"), Some(&context))
            .await
            .expect("processed");

        assert!(outcome.handled);
        assert!(h.transport.calls("sendMessage").is_empty());
    }

    #[tokio::test]
    async fn a_callback_from_an_unpaired_chat_is_answered_with_pairing_required() {
        let h = harness();
        h.transport.then(
            "answerCallbackQuery",
            json_response(200, json!({"ok": true})),
        );
        let update: TelegramUpdate = serde_json::from_value(json!({
            "update_id": 3,
            "callback_query": {
                "id": "cb9",
                "data": "model:x",
                "message": {"message_id": 1, "chat": {"id": 42, "type": "private"}},
            },
        }))
        .expect("valid update");

        let outcome = h
            .inbound
            .process_update(&update, None)
            .await
            .expect("processed");

        assert!(outcome.handled);
        let body = ScriptedTransport::body_of(&h.transport.calls("answerCallbackQuery")[0]);
        assert_eq!(body["text"], "Pairing required.");
        assert!(h.port.callbacks.lock().unwrap().is_empty());
    }
}
