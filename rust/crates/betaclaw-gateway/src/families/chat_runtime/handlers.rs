//! Memory save and inferred shell question: the `HandlersPort`.
//!
//! The memory save runs the core handler (`handlers/memoryHandler.ts`) against [`Memory`].
//! The core checks the `Speichere ab:` prefix first and returns without touching the memory
//! store for any other text, so ordinary messages pass through. The inferred shell question
//! needs the tool runtime, which is not wired, so it fails with a named error.

use std::future::ready;
use std::sync::Arc;

use betaclaw_core::channels::messages::service::execution::ports::PortResult;
use betaclaw_core::channels::messages::service::handlers::memory_handler::{
    handle_memory_save, MemorySaveParams,
};
use betaclaw_core::channels::messages::service::ports::{
    BoxFuture, HandlersPort, MemorySaveInput, SendResponse, ShellInferenceInput,
};
use betaclaw_core::messages_store::types::StoredMessage;

use super::memory::Memory;
use super::not_wired;

pub struct Handlers {
    memory: Memory,
}

impl Handlers {
    pub fn new(memory: Memory) -> Self {
        Self { memory }
    }
}

impl HandlersPort for Handlers {
    fn handle_memory_save(
        &self,
        input: MemorySaveInput,
        send: Arc<dyn SendResponse>,
    ) -> BoxFuture<'_, PortResult<Option<StoredMessage>>> {
        Box::pin(async move {
            let params = MemorySaveParams {
                conversation: &input.conversation,
                content: &input.content,
                platform: input.platform,
                external_chat_id: &input.external_chat_id,
                memory_enabled: input.memory_enabled,
            };
            let outcome = handle_memory_save(&self.memory, &*send, params).await?;
            Ok(outcome.message)
        })
    }

    fn handle_inferred_shell_question(
        &self,
        _input: ShellInferenceInput,
        _send: Arc<dyn SendResponse>,
    ) -> BoxFuture<'_, PortResult<StoredMessage>> {
        Box::pin(ready(Err(not_wired(
            "HandlersPort",
            "handle_inferred_shell_question",
        ))))
    }
}

#[cfg(test)]
mod tests {
    use super::super::repo::MessagesRepo;
    use super::super::test_support::Scratch;
    use super::*;
    use betaclaw_core::channels::messages::service::execution::ports::PortError;
    use betaclaw_core::messages_store::types::{
        ChannelType, Conversation, MessageRole, SaveMessageInput,
    };

    /// Never called: the first test only uses text that is not a save command.
    struct NoSend;

    impl SendResponse for NoSend {
        fn send_response<'a>(
            &'a self,
            _conversation: &'a Conversation,
            _content: &'a str,
            _platform: ChannelType,
            _external_chat_id: &'a str,
            _metadata: Option<serde_json::Map<String, serde_json::Value>>,
        ) -> BoxFuture<'a, PortResult<StoredMessage>> {
            Box::pin(ready(Err(PortError::Failed(
                "unexpected reply".to_string(),
            ))))
        }
    }

    /// Stores each reply, as `ResponseHelper` does, so the handler's reply can be read back.
    struct StoreReply(Arc<MessagesRepo>);

    impl SendResponse for StoreReply {
        fn send_response<'a>(
            &'a self,
            conversation: &'a Conversation,
            content: &'a str,
            platform: ChannelType,
            _external_chat_id: &'a str,
            _metadata: Option<serde_json::Map<String, serde_json::Value>>,
        ) -> BoxFuture<'a, PortResult<StoredMessage>> {
            Box::pin(ready(self.0.run(|s| {
                s.save_message(&SaveMessageInput {
                    conversation_id: &conversation.id,
                    role: MessageRole::Agent,
                    content,
                    platform: platform.as_str(),
                    external_msg_id: None,
                    sender_name: None,
                    metadata: None,
                    client_message_id: None,
                })
            })))
        }
    }

    /// A memory source with no Mem0 client configured: a save fails by name, nothing is stored.
    fn test_memory() -> Memory {
        let env = std::collections::HashMap::new();
        let world_model = betaclaw_core::world_model::config::resolve_world_model_config(&env);
        let pg = Arc::new(super::super::world::PgHandle::new(&world_model));
        Memory::new(
            &env,
            &world_model,
            Arc::new(betaclaw_core::model_hub::http::UnreachableTransport),
            pg,
        )
    }

    fn conversation_in(repo: &MessagesRepo) -> Conversation {
        repo.run(|s| s.get_or_create_conversation("WebChat", "web-h", None, Some("user-1")))
            .expect("conversation")
    }

    #[tokio::test]
    async fn plain_text_passes_the_memory_handler_without_a_store_call() {
        let scratch = Scratch::new();
        let repo = MessagesRepo::open(&scratch.path("messages.db")).expect("open");
        let handlers = Handlers::new(test_memory());
        let outcome = handlers
            .handle_memory_save(
                MemorySaveInput {
                    conversation: conversation_in(&repo),
                    content: "hallo".into(),
                    platform: ChannelType::WebChat,
                    external_chat_id: "web-h".into(),
                    memory_enabled: true,
                },
                Arc::new(NoSend),
            )
            .await;
        assert_eq!(outcome, Ok(None));
    }

    #[tokio::test]
    async fn a_save_command_without_the_store_replies_with_a_failure_and_saves_nothing() {
        let scratch = Scratch::new();
        let repo = Arc::new(MessagesRepo::open(&scratch.path("messages.db")).expect("open"));
        let handlers = Handlers::new(test_memory());
        let mut conversation = conversation_in(&repo);
        conversation.persona_id = Some("persona-1".into());
        let outcome = handlers
            .handle_memory_save(
                MemorySaveInput {
                    conversation,
                    content: "Speichere ab: Max mag Kaffee".into(),
                    platform: ChannelType::WebChat,
                    external_chat_id: "web-h".into(),
                    memory_enabled: true,
                },
                Arc::new(StoreReply(repo.clone())),
            )
            .await;
        // The core reports the store failure as a reply and does not confirm a save.
        let reply = outcome
            .expect("the reply is stored")
            .expect("a reply message");
        assert!(
            !reply.content.starts_with("✅"),
            "save was confirmed: {}",
            reply.content
        );
    }
}
