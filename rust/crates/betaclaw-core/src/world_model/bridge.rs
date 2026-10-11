//! Port of `src/server/world-model/bridge.ts:1-133` — Phase 2, the unified chat
//! write path.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `bridge.ts:9-22` (`BridgeChatMessage`) | [`BridgeChatMessage`] |
//! | `bridge.ts:30-45` (`bridgeChatMessages`) | [`bridge_chat_messages`] |
//! | `bridge.ts:47-121` (`bridgeChatMessagesInScope`) | [`bridge_chat_messages_in_scope`] |
//! | `bridge.ts:123-133` (`bridgeCanReachWorldModel`) | [`bridge_can_reach_world_model`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `:37-44` wraps the body in
//!    `runWithWorldModelScope`; the port passes the same
//!    [`WorldModelScope`](crate::world_model::scope::WorldModelScope) down to
//!    `record_observation`, `process_incoming_standing_intents` and
//!    `match_standing_intents`, which is the documented replacement for
//!    `getWorldModelScope()` (`db.ts:11`).
//! 2. **The wall clock is passed in.** `:80` writes
//!    `new Date().toISOString()` when a message carries no `createdAt`; the port
//!    takes `now` for that fallback.
//! 3. **The fail-soft catch is kept, the re-throw becomes the error value.**
//!    `:114-118` counts a skipped message, re-throws in a required mode and logs
//!    otherwise; the port answers `Err(PgError)` for the required mode and counts
//!    the skip in every other mode (there is no logger in this crate).
//! 4. **Config is a parameter.** `:54` and `:124` read `getWorldModelConfig()`;
//!    the port takes `&WorldModelConfig`.
//! 5. **The `SELECT 1` probe is unscoped.** `:128` calls `getWorldModelDb()`,
//!    whose `query` is the bare `pool.query` outside a scope; the port calls
//!    [`PgExecutor::query`] directly, so no `BEGIN` and no scope statement are
//!    issued.

use serde_json::{Map, Value};

use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{PgError, PgExecutor, PgStatement};
use crate::world_model::mode::WorldModelMode;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::observation_service::record_observation;
use crate::world_model::services::prospective_engine::match_standing_intents;
use crate::world_model::services::standing_intent_compiler::{
    process_incoming_standing_intents, CompileStandingIntentInput,
};
use crate::world_model::types::{ObservationInput, ObservationSourceType};

/// `BridgeChatMessage` from `bridge.ts:9-22`.
#[derive(Debug, Clone, PartialEq)]
pub struct BridgeChatMessage {
    pub id: Option<String>,
    pub user_id: String,
    pub persona_id: String,
    pub conversation_id: String,
    pub seq: i64,
    pub role: Option<String>,
    pub content: Option<String>,
    pub text: Option<String>,
    pub created_at: Option<String>,
    pub source_id: Option<String>,
    pub channel_type: Option<String>,
    pub sender_id: Option<String>,
}

/// The `bridgeChatMessages` argument of `bridge.ts:30-36`.
#[derive(Debug, Clone, PartialEq)]
pub struct BridgeChatMessagesInput {
    pub conversation_id: String,
    pub user_id: String,
    pub persona_id: String,
    pub workspace_id: Option<String>,
    pub messages: Vec<BridgeChatMessage>,
}

/// The `{ written, skipped }` answer of `bridge.ts:36`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BridgeChatResult {
    pub written: usize,
    pub skipped: usize,
}

/// `bridge.ts:72`.
pub const MESSAGE_SCOPE_MESSAGE: &str =
    "[world-model:bridge] message scope does not match bridge scope";

/// `bridgeChatMessages(input)` — `bridge.ts:30-45`.
pub async fn bridge_chat_messages(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    input: &BridgeChatMessagesInput,
    now: Option<&str>,
) -> Result<BridgeChatResult, PgError> {
    let scope = WorldModelScope::new(
        input.user_id.clone(),
        input.persona_id.clone(),
        input.workspace_id.clone(),
    );
    bridge_chat_messages_in_scope(executor, config, input, &scope, now).await
}

/// `bridgeCanReachWorldModel()` — `bridge.ts:123-133`.
pub async fn bridge_can_reach_world_model(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
) -> bool {
    if !config.enabled && !config.e2e_enabled {
        return false;
    }
    executor
        .query(PgStatement::new("SELECT 1"))
        .await
        .map(|_| true)
        .unwrap_or(false)
}

/// `isWorldModelRequired(config.mode)` — `bridge.ts:116`.
fn mode_is_required(mode: WorldModelMode) -> bool {
    mode.is_required()
}

/// `bridgeChatMessagesInScope(input)` — `bridge.ts:47-121`.
pub async fn bridge_chat_messages_in_scope(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    input: &BridgeChatMessagesInput,
    scope: &WorldModelScope,
    now: Option<&str>,
) -> Result<BridgeChatResult, PgError> {
    if !config.enabled && !config.e2e_enabled {
        return Ok(BridgeChatResult {
            written: 0,
            skipped: input.messages.len(),
        });
    }
    if !config.ingestion_bridge_enabled {
        return Ok(BridgeChatResult {
            written: 0,
            skipped: input.messages.len(),
        });
    }

    let mut written = 0;
    let mut skipped = 0;
    for message in &input.messages {
        // `String(message.content ?? message.text ?? '').trim()` — `:65`.
        let text = message
            .content
            .clone()
            .or_else(|| message.text.clone())
            .unwrap_or_default()
            .trim()
            .to_string();
        if text.is_empty() {
            skipped += 1;
            continue;
        }

        let outcome = bridge_one_message(executor, config, input, scope, message, &text, now).await;
        match outcome {
            Ok(()) => written += 1,
            Err(error) => {
                skipped += 1;
                if mode_is_required(config.mode) {
                    return Err(error);
                }
                // Fail-soft (`:117`): the message stays out of the canonical
                // store and the loop continues.
            }
        }
    }
    Ok(BridgeChatResult { written, skipped })
}

/// The `try` block of `bridge.ts:70-113` for a single message.
#[allow(clippy::too_many_arguments)]
async fn bridge_one_message(
    executor: &dyn PgExecutor,
    config: &WorldModelConfig,
    input: &BridgeChatMessagesInput,
    scope: &WorldModelScope,
    message: &BridgeChatMessage,
    text: &str,
    now: Option<&str>,
) -> Result<(), PgError> {
    if message.user_id != input.user_id || message.persona_id != input.persona_id {
        return Err(PgError::new(MESSAGE_SCOPE_MESSAGE));
    }

    let observation_input = ObservationInput {
        user_id: input.user_id.clone(),
        persona_id: input.persona_id.clone(),
        workspace_id: Some(input.workspace_id.clone().unwrap_or_default()),
        source_type: ObservationSourceType::ChatMessage,
        // `message.sourceId ?? message.id ?? `${conversationId}:${seq}`` — `:79`.
        source_id: message
            .source_id
            .clone()
            .or_else(|| message.id.clone())
            .unwrap_or_else(|| format!("{}:{}", message.conversation_id, message.seq)),
        occurred_at: message
            .created_at
            .clone()
            .unwrap_or_else(|| now.map(str::to_string).unwrap_or_else(now_iso)),
        payload: message_payload(message, text),
        source_authority: Some(
            match message.role.as_deref() {
                Some("assistant") | Some("agent") => "persona",
                _ => "user",
            }
            .to_string(),
        ),
    };

    let recorded = record_observation(executor, observation_input, Some(scope), config).await?;

    // `processIncomingStandingIntents(…).catch(…)` — `:98-105` keeps a failure
    // silent, like the ported compiler's `Option`.
    let _ = process_incoming_standing_intents(
        executor,
        Some(scope),
        config,
        &CompileStandingIntentInput {
            user_id: input.user_id.clone(),
            persona_id: input.persona_id.clone(),
            workspace_id: Some(input.workspace_id.clone().unwrap_or_default()),
            statement: text.to_string(),
        },
    )
    .await;

    if recorded.created {
        // `matchStandingIntents(observation).catch(…)` — `:109-111`.
        let _ = match_standing_intents(executor, Some(scope), &recorded.observation).await;
    }
    Ok(())
}

/// The `payload` object literal of `bridge.ts:81-88`.
fn message_payload(message: &BridgeChatMessage, text: &str) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert(
        "conversationId".into(),
        Value::String(message.conversation_id.clone()),
    );
    payload.insert("seq".into(), Value::from(message.seq));
    payload.insert(
        "role".into(),
        Value::String(message.role.clone().unwrap_or_else(|| "user".to_string())),
    );
    payload.insert("text".into(), Value::String(text.to_string()));
    if let Some(channel_type) = message.channel_type.as_ref().filter(|v| !v.is_empty()) {
        payload.insert("channelType".into(), Value::String(channel_type.clone()));
    }
    if let Some(sender_id) = message.sender_id.as_ref().filter(|v| !v.is_empty()) {
        payload.insert("senderId".into(), Value::String(sender_id.clone()));
    }
    payload
}

fn now_iso() -> String {
    crate::world_model::repositories::assertion_repository::now_iso()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{drive_sync, PgQueryResult, PgRow};
    use serde_json::json;

    fn row(value: serde_json::Value) -> PgRow {
        value.as_object().expect("row").clone()
    }

    fn observation_row() -> PgQueryResult {
        PgQueryResult::from_rows(vec![row(json!({
            "id": "o1", "user_id": "u1", "persona_id": "p1", "workspace_id": "",
            "source_type": "chat_message", "source_id": "conv1:1",
            "occurred_at": "2026-10-10T10:00:00.000Z",
            "received_at": "2026-10-10T10:00:00.000Z", "payload": {},
            "source_authority": "user"
        }))])
    }

    fn config() -> WorldModelConfig {
        WorldModelConfig {
            enabled: true,
            ingestion_bridge_enabled: true,
            ..Default::default()
        }
    }

    fn message() -> BridgeChatMessage {
        BridgeChatMessage {
            id: None,
            user_id: "u1".into(),
            persona_id: "p1".into(),
            conversation_id: "conv1".into(),
            seq: 1,
            role: Some("user".into()),
            content: Some("  Hallo Welt  ".into()),
            text: None,
            created_at: Some("2026-10-10T10:00:00.000Z".into()),
            source_id: None,
            channel_type: Some("telegram".into()),
            sender_id: Some("mike".into()),
        }
    }

    fn input(messages: Vec<BridgeChatMessage>) -> BridgeChatMessagesInput {
        BridgeChatMessagesInput {
            conversation_id: "conv1".into(),
            user_id: "u1".into(),
            persona_id: "p1".into(),
            workspace_id: None,
            messages,
        }
    }

    #[test]
    fn a_disabled_or_disabled_ingestion_bridge_skips_every_message() {
        let executor = RecordingExecutor::new(vec![]);
        let disabled = drive_sync(bridge_chat_messages(
            &executor,
            &WorldModelConfig::default(),
            &input(vec![message()]),
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect("skipped");
        assert_eq!(
            disabled,
            BridgeChatResult {
                written: 0,
                skipped: 1
            }
        );

        let no_ingestion = WorldModelConfig {
            enabled: true,
            ..Default::default()
        };
        let skipped = drive_sync(bridge_chat_messages(
            &executor,
            &no_ingestion,
            &input(vec![message()]),
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect("skipped");
        assert_eq!(
            skipped,
            BridgeChatResult {
                written: 0,
                skipped: 1
            }
        );
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn a_message_is_written_as_a_trimmed_chat_observation() {
        let executor = RecordingExecutor::new(vec![Ok(observation_row())]);
        let result = drive_sync(bridge_chat_messages(
            &executor,
            &config(),
            &input(vec![message()]),
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect("written");
        assert_eq!(
            result,
            BridgeChatResult {
                written: 1,
                skipped: 0
            }
        );

        let calls = executor.calls();
        let Recorded::Statement(insert) = &calls[2] else {
            panic!("expected the observation insert, got {:?}", calls.get(2));
        };
        assert_eq!(
            insert.sql,
            crate::world_model::repositories::observation_repository::SQL_INSERT_OBSERVATION
        );
        assert_eq!(
            insert.params[3],
            crate::world_model::db::PgValue::text("chat_message")
        );
        // `sourceId` falls back to `${conversationId}:${seq}` (`:79`).
        assert_eq!(
            insert.params[4],
            crate::world_model::db::PgValue::text("conv1:1")
        );
        assert_eq!(
            insert.params[7],
            crate::world_model::db::PgValue::text("user")
        );
        let crate::world_model::db::PgValue::Text(raw) = &insert.params[6] else {
            panic!("payload");
        };
        let payload: serde_json::Value = serde_json::from_str(raw).expect("payload json");
        assert_eq!(payload["text"], json!("Hallo Welt"));
        assert_eq!(payload["role"], json!("user"));
        assert_eq!(payload["seq"], json!(1));
        assert_eq!(payload["channelType"], json!("telegram"));
        assert_eq!(payload["senderId"], json!("mike"));
    }

    #[test]
    fn an_assistant_message_is_attributed_to_the_persona() {
        let executor = RecordingExecutor::new(vec![Ok(observation_row())]);
        let mut assistant = message();
        assistant.role = Some("assistant".into());
        drive_sync(bridge_chat_messages(
            &executor,
            &config(),
            &input(vec![assistant]),
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect("written");
        let Recorded::Statement(insert) = &executor.calls()[2] else {
            panic!("expected the observation insert");
        };
        assert_eq!(
            insert.params[7],
            crate::world_model::db::PgValue::text("persona")
        );
    }

    #[test]
    fn a_scope_mismatch_is_fail_soft_but_throws_in_a_required_mode() {
        let mut foreign = message();
        foreign.persona_id = "p2".into();
        let executor = RecordingExecutor::new(vec![]);
        let soft = drive_sync(bridge_chat_messages(
            &executor,
            &config(),
            &input(vec![foreign.clone()]),
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect("fail-soft");
        assert_eq!(
            soft,
            BridgeChatResult {
                written: 0,
                skipped: 1
            }
        );

        let required = WorldModelConfig {
            mode: WorldModelMode::Canonical,
            ..config()
        };
        let error = drive_sync(bridge_chat_messages(
            &executor,
            &required,
            &input(vec![foreign]),
            Some("2026-10-10T10:00:00.000Z"),
        ))
        .expect("bridge")
        .expect_err("required mode");
        assert_eq!(error.message, MESSAGE_SCOPE_MESSAGE);
    }

    #[test]
    fn an_empty_text_is_skipped_without_a_statement() {
        let executor = RecordingExecutor::new(vec![]);
        let mut blank = message();
        blank.content = Some("   ".into());
        let result = drive_sync(bridge_chat_messages(
            &executor,
            &config(),
            &input(vec![blank]),
            Some("2026-10-10T10:00:00.000Z"),
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
    fn the_reachability_probe_is_a_bare_select_one() {
        let executor = RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]);
        assert!(!drive_sync(bridge_can_reach_world_model(
            &executor,
            &WorldModelConfig::default()
        ))
        .expect("bridge"));
        assert!(executor.calls().is_empty());

        let enabled = WorldModelConfig {
            enabled: true,
            ..Default::default()
        };
        assert!(drive_sync(bridge_can_reach_world_model(&executor, &enabled)).expect("bridge"));
        assert_eq!(executor.calls().len(), 1);
        assert_eq!(executor.calls()[0].sql(), "SELECT 1");
    }
}
