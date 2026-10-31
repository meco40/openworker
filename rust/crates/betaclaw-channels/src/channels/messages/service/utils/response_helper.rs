//! Port of `src/server/channels/messages/service/utils/responseHelper.ts`.
//!
//! `createSendResponse(historyManager)` becomes [`ResponseHelper`], which implements
//! [`SendResponse`]. The side-effect order matches the source: persist, event bus,
//! world-model bridge (errors propagate), broadcast, inbox, then outbound delivery
//! (errors are logged only).

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::ports::{BoxFuture, ChatEvents, ChatStore, SendResponse};
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};

/// The reply sender of one service instance.
pub struct ResponseHelper {
    history: Arc<dyn ChatStore>,
    events: Arc<dyn ChatEvents>,
}

impl ResponseHelper {
    /// `createSendResponse(historyManager)` (`responseHelper.ts:41`).
    pub fn new(history: Arc<dyn ChatStore>, events: Arc<dyn ChatEvents>) -> Self {
        Self { history, events }
    }
}

impl SendResponse for ResponseHelper {
    fn send_response<'a>(
        &'a self,
        conversation: &'a Conversation,
        content: &'a str,
        platform: ChannelType,
        external_chat_id: &'a str,
        metadata: Option<Map<String, Value>>,
    ) -> BoxFuture<'a, PortResult<StoredMessage>> {
        Box::pin(async move {
            let agent_message = self.history.append_agent_message(
                &conversation.id,
                platform,
                content,
                metadata.map(Value::Object),
            )?;
            self.events.message_persisted(conversation, &agent_message);

            self.events
                .bridge_stored_message(conversation.clone(), agent_message.clone())
                .await?;

            self.events
                .broadcast_chat_message(&conversation.user_id, &agent_message);
            self.events.inbox_upserted(conversation, &agent_message);

            let persona_id = conversation.persona_id.clone();
            if let Err(error) = self
                .events
                .deliver_outbound(
                    platform,
                    external_chat_id.to_string(),
                    content.to_string(),
                    persona_id,
                )
                .await
            {
                eprintln!(
                    "Outbound delivery failed for {}: {error}",
                    platform.as_str()
                );
            }

            Ok(agent_message)
        })
    }
}
