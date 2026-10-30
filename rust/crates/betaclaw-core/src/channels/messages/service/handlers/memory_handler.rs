//! Port of `src/server/channels/messages/service/handlers/memoryHandler.ts`, with
//! `extractMemorySaveContent` from `service/types.ts` (the `Speichere ab:` prefix).
//!
//! `handle_memory_save` answers the manual save command. It stores a fact through
//! the memory port, or replies with the reason it cannot.

use serde_json::{json, Map, Value};

use crate::channels::messages::service::execution::ports::PortResult;
use crate::channels::messages::service::ports::SendResponse;
use crate::channels::messages::service::subagent::utils::{non_empty, object};
use crate::channels::messages::service::types::extract_memory_save_content;
use crate::memory::service::{resolve_memory_scoped_user_id, MemoryScopeInput};
use crate::messages_store::types::{ChannelType, Conversation, StoredMessage};
use crate::model_hub::http::BoxFuture;

/// What the memory port must store for a manual save.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryStoreRequest {
    pub persona_id: String,
    pub memory_type: &'static str,
    pub content: String,
    pub importance: u8,
    pub user_id: String,
    pub metadata: Map<String, Value>,
}

/// The part of the memory service that the save command uses.
pub trait MemoryWritePort: Send + Sync {
    /// `isMem0FactualWriteBlocked()`. The canonical world-model configuration
    /// decides this, and the adapter holds it.
    fn is_mem0_factual_write_blocked(&self) -> bool;
    /// `getMemoryService().storeMemory(...)`.
    fn store_memory<'a>(&'a self, request: MemoryStoreRequest) -> BoxFuture<'a, PortResult<()>>;
}

/// Input of [`handle_memory_save`].
#[derive(Debug, Clone, Copy)]
pub struct MemorySaveParams<'a> {
    pub conversation: &'a Conversation,
    pub content: &'a str,
    pub platform: ChannelType,
    pub external_chat_id: &'a str,
    /// TS default `true`. Agent Room conversations turn it off.
    pub memory_enabled: bool,
}

/// `{ saved, message? }`.
#[derive(Debug, Clone, PartialEq)]
pub struct MemorySaveOutcome {
    pub saved: bool,
    pub message: Option<StoredMessage>,
}

/// `handleMemorySave(params, sendResponse)`.
pub async fn handle_memory_save(
    memory: &dyn MemoryWritePort,
    sink: &dyn SendResponse,
    params: MemorySaveParams<'_>,
) -> PortResult<MemorySaveOutcome> {
    let conversation = params.conversation;
    let platform = params.platform;
    let external_chat_id = params.external_chat_id;

    let Some(memory_content) = extract_memory_save_content(params.content) else {
        return Ok(MemorySaveOutcome {
            saved: false,
            message: None,
        });
    };

    if !params.memory_enabled {
        return reply_only(
            sink,
            params,
            "Agent Room ist ein isolierter Brainstorm-Bereich: Memory-Speicherung ist hier deaktiviert.",
        )
        .await;
    }
    if memory_content.is_empty() {
        return reply_only(
            sink,
            params,
            "⚠️ Bitte schreibe nach `Speichere ab:` auch den Inhalt.",
        )
        .await;
    }
    let persona_id = match non_empty(conversation.persona_id.as_deref()) {
        Some(persona_id) => persona_id.to_string(),
        None => {
            return reply_only(
                sink,
                params,
                "⚠️ Keine Persona aktiv. Bitte zuerst eine Persona wählen, dann `Speichere ab: ...` nutzen.",
            )
            .await;
        }
    };
    if memory.is_mem0_factual_write_blocked() {
        return reply_only(
            sink,
            params,
            "⚠️ Im Canonical-Modus werden faktische Memories direkt in PostgreSQL gespeichert. Bitte nutze die Knowledge-Ingestion oder Mission Control.",
        )
        .await;
    }

    let scope_chat_id = non_empty(Some(external_chat_id))
        .or(non_empty(conversation.external_chat_id.as_deref()))
        .unwrap_or("default");
    let user_id = resolve_memory_scoped_user_id(MemoryScopeInput {
        user_id: Some(&conversation.user_id),
        channel_type: Some(platform.as_str()),
        external_chat_id: Some(scope_chat_id),
    });
    let request = MemoryStoreRequest {
        persona_id,
        memory_type: "fact",
        content: memory_content.clone(),
        importance: 4,
        user_id,
        metadata: object(json!({
            "subject": "user",
            "sourceRole": "user",
            "sourceType": "manual_save",
        })),
    };

    match memory.store_memory(request).await {
        Ok(()) => Ok(MemorySaveOutcome {
            saved: true,
            message: Some(
                sink.send_response(
                    conversation,
                    &format!("✅ Gespeichert: {memory_content}"),
                    platform,
                    external_chat_id,
                    None,
                )
                .await?,
            ),
        }),
        Err(error) => {
            tracing::error!(error = %error, "Memory store failed");
            reply_only(sink, params, "⚠️ Memory konnte nicht gespeichert werden.").await
        }
    }
}

/// Sends a reply and reports `saved: false`, the shape of every rejection path.
async fn reply_only(
    sink: &dyn SendResponse,
    params: MemorySaveParams<'_>,
    text: &str,
) -> PortResult<MemorySaveOutcome> {
    let message = sink
        .send_response(
            params.conversation,
            text,
            params.platform,
            params.external_chat_id,
            None,
        )
        .await?;
    Ok(MemorySaveOutcome {
        saved: false,
        message: Some(message),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::messages::service::execution::test_doubles::{
        conversation, FakeMemory, FakeSink,
    };

    fn params<'a>(conversation: &'a Conversation, content: &'a str) -> MemorySaveParams<'a> {
        MemorySaveParams {
            conversation,
            content,
            platform: ChannelType::WebChat,
            external_chat_id: "web-1",
            memory_enabled: true,
        }
    }

    #[test]
    fn save_prefix_is_recognised_and_stripped() {
        assert_eq!(
            extract_memory_save_content("Speichere ab: Der Kunde heisst Max").as_deref(),
            Some("Der Kunde heisst Max")
        );
        assert_eq!(
            extract_memory_save_content("speichere ab Milch kaufen").as_deref(),
            Some("Milch kaufen")
        );
        assert_eq!(
            extract_memory_save_content("Speichere ab —  Wert").as_deref(),
            Some("Wert")
        );
        assert_eq!(
            extract_memory_save_content("Speichere ab").as_deref(),
            Some("")
        );
        assert_eq!(extract_memory_save_content("Speichere abwesend"), None);
        assert_eq!(extract_memory_save_content("Hallo"), None);
    }

    #[tokio::test]
    async fn non_save_text_is_not_handled() {
        let conv = conversation("conv-1", "user-1", Some("p-1"));
        let sink = FakeSink::default();
        let outcome = handle_memory_save(&FakeMemory::default(), &sink, params(&conv, "Hallo"))
            .await
            .unwrap();
        assert_eq!(
            outcome,
            MemorySaveOutcome {
                saved: false,
                message: None
            }
        );
        assert!(sink.sent().is_empty());
    }

    #[tokio::test]
    async fn missing_persona_is_explained_and_nothing_is_stored() {
        let conv = conversation("conv-1", "user-1", None);
        let memory = FakeMemory::default();
        let sink = FakeSink::default();
        let outcome = handle_memory_save(&memory, &sink, params(&conv, "Speichere ab: Milch"))
            .await
            .unwrap();
        assert!(!outcome.saved);
        assert!(sink.sent()[0]
            .content
            .starts_with("⚠️ Keine Persona aktiv."));
        assert!(memory.stored.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_empty_save_asks_for_the_content_and_stores_nothing() {
        let conv = conversation("conv-1", "user-1", Some("p-1"));
        let memory = FakeMemory::default();
        let sink = FakeSink::default();
        let outcome = handle_memory_save(&memory, &sink, params(&conv, "Speichere ab:"))
            .await
            .unwrap();
        assert!(!outcome.saved);
        assert_eq!(
            sink.sent()[0].content,
            "⚠️ Bitte schreibe nach `Speichere ab:` auch den Inhalt."
        );
        assert!(memory.stored.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn canonical_mode_blocks_factual_writes() {
        let conv = conversation("conv-1", "user-1", Some("p-1"));
        let memory = FakeMemory {
            blocked: true,
            ..Default::default()
        };
        let sink = FakeSink::default();
        let outcome = handle_memory_save(&memory, &sink, params(&conv, "Speichere ab: Milch"))
            .await
            .unwrap();
        assert!(!outcome.saved);
        assert!(sink.sent()[0].content.contains("Canonical-Modus"));
        assert!(memory.stored.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn save_stores_a_manual_fact_and_confirms() {
        let conv = conversation("conv-1", "user-1", Some("p-1"));
        let memory = FakeMemory::default();
        let sink = FakeSink::default();
        let outcome = handle_memory_save(&memory, &sink, params(&conv, "Speichere ab: Milch"))
            .await
            .unwrap();

        assert!(outcome.saved);
        assert_eq!(sink.sent()[0].content, "✅ Gespeichert: Milch");
        let stored = memory.stored.lock().unwrap();
        assert_eq!(stored[0].persona_id, "p-1");
        assert_eq!(stored[0].memory_type, "fact");
        assert_eq!(stored[0].importance, 4);
        assert_eq!(stored[0].user_id, "user-1");
        assert_eq!(
            stored[0].metadata["sourceType"],
            serde_json::json!("manual_save")
        );
    }

    #[tokio::test]
    async fn store_failure_is_reported_without_saving() {
        let conv = conversation("conv-1", "user-1", Some("p-1"));
        let memory = FakeMemory {
            fail: true,
            ..Default::default()
        };
        let sink = FakeSink::default();
        let outcome = handle_memory_save(&memory, &sink, params(&conv, "Speichere ab: Milch"))
            .await
            .unwrap();
        assert!(!outcome.saved);
        assert_eq!(
            sink.sent()[0].content,
            "⚠️ Memory konnte nicht gespeichert werden."
        );
    }

    #[tokio::test]
    async fn disabled_memory_explains_the_agent_room_rule() {
        let conv = conversation("conv-1", "user-1", Some("p-1"));
        let sink = FakeSink::default();
        let mut request = params(&conv, "Speichere ab: Milch");
        request.memory_enabled = false;
        let outcome = handle_memory_save(&FakeMemory::default(), &sink, request)
            .await
            .unwrap();
        assert!(!outcome.saved);
        assert!(sink.sent()[0]
            .content
            .starts_with("Agent Room ist ein isolierter"));
    }
}
