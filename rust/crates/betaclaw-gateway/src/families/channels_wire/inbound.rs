//! The inbound side of the channels: the chat dispatch as a port, and the Telegram
//! adapter over it.
//!
//! [`ChannelInbound`] is what the channel routes need from the dispatch:
//! `handleInbound` of `src/server/channels/messages/service/messageService.ts`.
//! [`MessageService`] implements it. [`TelegramBridge`] is the dispatch half of
//! `src/server/channels/pairing/telegramInbound.ts`, the part that follows the
//! pairing gate and the native-command check.

use std::sync::Arc;

use betaclaw_core::channels::adapters::telegram::types::TelegramCallbackQuery;
use betaclaw_core::channels::adapters::types::ChannelError;
use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::inbound::handle_inbound::{
    InboundOptions, InboundParams, InboundResult,
};
use betaclaw_core::channels::messages::service::message_service::MessageService;
use betaclaw_core::channels::pairing::telegram_inbound::{TelegramDispatch, TelegramInboundPort};
use betaclaw_core::messages_store::types::ChannelType;
use betaclaw_core::model_hub::http::BoxFuture;

use super::telegram_commands::TelegramCommands;

/// The chat dispatch as the channel routes see it: one inbound message in, the
/// stored user and agent messages out.
pub trait ChannelInbound: Send + Sync {
    fn handle_inbound(&self, params: InboundParams) -> BoxFuture<'_, PortResult<InboundResult>>;
}

impl ChannelInbound for MessageService {
    fn handle_inbound(&self, params: InboundParams) -> BoxFuture<'_, PortResult<InboundResult>> {
        Box::pin(MessageService::handle_inbound(self, params))
    }
}

/// The Telegram steps of the pairing flow that run in the gateway: the native
/// commands (`/model`, `/chatdelete`), the model browser, the conversation of a
/// persona-bound bot, and the dispatch.
///
/// ponytail: media is not downloaded: only the text or the caption is dispatched.
pub struct TelegramBridge {
    commands: TelegramCommands,
    inbound: Arc<dyn ChannelInbound>,
}

impl TelegramBridge {
    pub fn new(commands: TelegramCommands, inbound: Arc<dyn ChannelInbound>) -> Self {
        Self { commands, inbound }
    }
}

impl TelegramInboundPort for TelegramBridge {
    fn handle_native_command<'a>(
        &'a self,
        _chat_id: &'a str,
        text: &'a str,
        external_chat_id: &'a str,
    ) -> BoxFuture<'a, Result<bool, ChannelError>> {
        Box::pin(self.commands.handle_native_command(text, external_chat_id))
    }

    fn handle_model_callback<'a>(
        &'a self,
        query: &'a TelegramCallbackQuery,
    ) -> BoxFuture<'a, Result<bool, ChannelError>> {
        Box::pin(self.commands.handle_model_callback(query))
    }

    fn dispatch_message<'a>(
        &'a self,
        dispatch: TelegramDispatch<'a>,
    ) -> BoxFuture<'a, Result<bool, ChannelError>> {
        Box::pin(async move {
            let text = dispatch
                .message
                .text
                .as_deref()
                .or(dispatch.message.caption.as_deref())
                .map(str::trim)
                .unwrap_or("");
            if text.is_empty() {
                return Ok(false);
            }

            let conversation = self
                .commands
                .db
                .get_or_create_conversation(
                    ChannelType::Telegram.as_str(),
                    dispatch.external_chat_id,
                )
                .map_err(|error| ChannelError::new(error.to_string()))?;
            if let Some(context) = dispatch.bot_context {
                if conversation.persona_id.is_none() {
                    self.commands
                        .db
                        .with(|store| {
                            store.update_persona_id(
                                &conversation.id,
                                Some(context.persona_id.as_str()),
                                &conversation.user_id,
                            )
                        })
                        .map_err(|error| ChannelError::new(error.to_string()))?;
                }
            }

            self.inbound
                .handle_inbound(InboundParams {
                    platform: ChannelType::Telegram,
                    external_chat_id: dispatch.external_chat_id.to_string(),
                    content: text.to_string(),
                    sender_name: Some(dispatch.sender_name.to_string()),
                    external_msg_id: Some(dispatch.external_msg_id.to_string()),
                    user_id: None,
                    client_message_id: None,
                    attachment_metadata: None,
                    on_stream_delta: None,
                    opts: InboundOptions::default(),
                })
                .await
                .map_err(|error| ChannelError::new(error.to_string()))?;
            Ok(true)
        })
    }
}
