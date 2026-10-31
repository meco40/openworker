//! Port of `src/server/world-model/liveChatBridge.ts:1-36`.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `liveChatBridge.ts:9-12` (argument) | [`BridgeStoredChatMessageInput`] |
//! | `liveChatBridge.ts:9-36` (`bridgeStoredChatMessage`) | [`bridge_stored_chat_message`] |
//!
//! # Deviations
//!
//! 1. **The `Conversation` and `StoredMessage` records are the port's own
//!    shapes.** `liveChatBridge.ts:1` imports them from
//!    `server/channels/messages/repository`, which belongs to the channel slice
//!    and not to S6. The port takes the fields it reads, so no foreign module is
//!    pulled into the world-model slice.
//! 2. **`workspaceId ?? ''` and `seq ?? 0` stay explicit.** `:20` and `:27` fall
//!    back to `''`/`0`; the port takes `Option` and applies the same fallback.
//! 3. **`senderName ?? undefined` becomes `Option`.** `:33` maps an absent
//!    `senderName` to `undefined`, which the bridge then omits from the payload;
//!    the ported field is `Option<String>` and the bridge omits it the same way.

use crate::world_model::bridge::{
    bridge_chat_messages, BridgeChatMessage, BridgeChatMessagesInput, BridgeChatResult,
};
use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{PgError, PgExecutor};

/// The fields of `Conversation` that `liveChatBridge.ts:13-35` reads.
#[derive(Debug, Clone, PartialEq)]
pub struct ConversationRecord {
    pub id: String,
    pub user_id: String,
    /// `conversation.personaId` — absent for a conversation without persona.
    pub persona_id: Option<String>,
    pub workspace_id: Option<String>,
}

/// The fields of `StoredMessage` that `liveChatBridge.ts:22-34` reads.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredMessageRecord {
    pub id: String,
    pub conversation_id: String,
    pub seq: Option<i64>,
    pub role: Option<String>,
    pub content: Option<String>,
    pub created_at: Option<String>,
    pub platform: Option<String>,
    pub sender_name: Option<String>,
}

/// The argument of `bridgeStoredChatMessage` (`liveChatBridge.ts:9-12`).
#[derive(Debug, Clone, PartialEq)]
pub struct BridgeStoredChatMessageInput {
    pub conversation: ConversationRecord,
    pub message: StoredMessageRecord,
}

/// `bridgeStoredChatMessage(input)` — `liveChatBridge.ts:9-37`.
pub async fn bridge_stored_chat_message(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    input: &BridgeStoredChatMessageInput,
    now: Option<&str>,
) -> Result<BridgeChatResult, PgError> {
    let conversation = &input.conversation;
    let message = &input.message;
    // `if (!conversation.personaId) return { written: 0, skipped: 1 }` — `:14`.
    let Some(persona_id) = conversation.persona_id.clone() else {
        return Ok(BridgeChatResult {
            written: 0,
            skipped: 1,
        });
    };

    bridge_chat_messages(
        executor,
        config,
        &BridgeChatMessagesInput {
            conversation_id: conversation.id.clone(),
            user_id: conversation.user_id.clone(),
            persona_id: persona_id.clone(),
            workspace_id: conversation.workspace_id.clone(),
            messages: vec![BridgeChatMessage {
                id: Some(message.id.clone()),
                user_id: conversation.user_id.clone(),
                persona_id,
                conversation_id: message.conversation_id.clone(),
                seq: message.seq.unwrap_or(0),
                role: message.role.clone(),
                content: message.content.clone(),
                text: None,
                created_at: message.created_at.clone(),
                source_id: Some(message.id.clone()),
                channel_type: message.platform.clone(),
                sender_id: message.sender_name.clone(),
            }],
        },
        now,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow};
    use serde_json::json;

    fn conversation() -> ConversationRecord {
        ConversationRecord {
            id: "conv1".into(),
            user_id: "u1".into(),
            persona_id: Some("p1".into()),
            workspace_id: None,
        }
    }

    fn message() -> StoredMessageRecord {
        StoredMessageRecord {
            id: "m42".into(),
            conversation_id: "conv1".into(),
            seq: None,
            role: Some("user".into()),
            content: Some("Hallo".into()),
            created_at: Some("2026-10-10T10:00:00.000Z".into()),
            platform: Some("telegram".into()),
            sender_name: None,
        }
    }

    fn observation_row() -> PgQueryResult {
        let row: PgRow = json!({
            "id": "o1", "user_id": "u1", "persona_id": "p1", "workspace_id": "",
            "source_type": "chat_message", "source_id": "m42",
            "occurred_at": "2026-10-10T10:00:00.000Z",
            "received_at": "2026-10-10T10:00:00.000Z", "payload": {},
            "source_authority": "user"
        })
        .as_object()
        .unwrap()
        .clone();
        PgQueryResult::from_rows(vec![row])
    }

    #[test]
    fn a_conversation_without_a_persona_skips_the_message() {
        let executor = RecordingExecutor::new(vec![]);
        let input = BridgeStoredChatMessageInput {
            conversation: ConversationRecord {
                persona_id: None,
                ..conversation()
            },
            message: message(),
        };
        let result = drive_sync(bridge_stored_chat_message(
            &executor,
            &WorldModelConfig::default(),
            &input,
            None,
        ))
        .expect("bridge")
        .expect("skipped");
        assert_eq!(
            result,
            BridgeChatResult {
                written: 0,
                skipped: 1
            }
        );
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn the_sqlite_message_id_is_the_source_id_and_the_seq_defaults_to_zero() {
        let executor = RecordingExecutor::new(vec![Ok(observation_row())]);
        let config = WorldModelConfig {
            enabled: true,
            ingestion_bridge_enabled: true,
            ..Default::default()
        };
        let input = BridgeStoredChatMessageInput {
            conversation: conversation(),
            message: message(),
        };
        let result = drive_sync(bridge_stored_chat_message(&executor, &config, &input, None))
            .expect("bridge")
            .expect("written");
        assert_eq!(
            result,
            BridgeChatResult {
                written: 1,
                skipped: 0
            }
        );
        let Recorded::Statement(insert) = &executor.calls()[2] else {
            panic!("expected the observation insert");
        };
        assert_eq!(
            insert.params[4],
            crate::world_model::db::PgValue::text("m42")
        );
        let crate::world_model::db::PgValue::Text(raw) = &insert.params[6] else {
            panic!("payload");
        };
        let payload: serde_json::Value = serde_json::from_str(raw).expect("payload json");
        assert_eq!(payload["seq"], json!(0));
        assert_eq!(payload["conversationId"], json!("conv1"));
    }
}
