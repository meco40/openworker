//! Port of `src/server/world-model/services/proactiveChannelDelivery.ts:1-280`
//! — the real channel delivery for proactive outbox events.
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `proactiveChannelDelivery.ts:27-34` (`ProactiveDeliveryResult`) | [`ProactiveDeliveryResult`] |
//! | `proactiveChannelDelivery.ts:41-88` (`resolveDeliveryChannel`) | [`resolve_delivery_channel`] |
//! | `proactiveChannelDelivery.ts:93-138` (`deliverProactiveQuestion`) | [`deliver_proactive_question`] |
//! | `proactiveChannelDelivery.ts:143-189` (`deliverIntentFiredNotification`) | [`deliver_intent_fired_notification`] |
//! | `proactiveChannelDelivery.ts:195-240` (`createProactiveQuestionHandler`) | [`create_proactive_question_handler`] |
//! | `proactiveChannelDelivery.ts:245-280` (`createProactiveIntentFiredHandler`) | [`create_proactive_intent_fired_handler`] |
//!
//! # Deviations
//!
//! 1. **The ambient scope is a parameter.** `:200`, `:215`, `:250` and `:268`
//!    call `getDeliveryReceiptByOutboxEventId`/`insertDeliveryReceipt` (and the
//!    `withWorldModelTransaction` of `:215`) without a scope, so
//!    `getWorldModelScope()` decides; the port hands `Option<&WorldModelScope>`
//!    to every repository call, the documented replacement for the
//!    `AsyncLocalStorage` (`db.ts:11`).
//! 2. **The environment is a map.** `:46` reads `process.env`; the port takes
//!    `&HashMap<String, String>` like the rest of the slice.
//! 3. **Two cross-slice seams are injected.** The source reads the channel
//!    bindings through `getMessageRepository().listChannelBindings` (`:51`, the
//!    messages slice) and delivers through `deliverOutboundWithReceipt`
//!    (`:111`, `:162`, the channels outbound router). Neither slice is inside
//!    `betaclaw-core`'s World-Model ports, so the port takes them as
//!    [`ListChannelBindings`] and [`DeliverOutbound`] — the same dependency
//!    injection the source's own `?...`/adapter lookups express. `Ok(None)` is
//!    the `deliverOutboundWithReceipt` returning `null` (`:117`, `:168`), `Err`
//!    its rejection.
//! 4. **The wall clock is injected.** `:214` writes `new Date().toISOString()`;
//!    the port takes a [`Clock`], so the handler is deterministic in tests.
//! 5. **The config is a value.** `:197`/`:247` read `getWorldModelConfig()` on
//!    every invocation; the factory captures the resolved [`WorldModelConfig`].

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::messages_store::types::{ChannelBinding, ChannelType};
use crate::world_model::config::WorldModelConfig;
use crate::world_model::db::{
    BoxFuture, PgError, PgExecutor, PgQueryResult, PgSession, PgStatement,
};
use crate::world_model::outbox_dispatcher::OutboxHandler;
use crate::world_model::repositories::ambient_transaction;
use crate::world_model::repositories::delivery_receipt_repository::{
    get_delivery_receipt_by_outbox_event_id, insert_delivery_receipt, DeliveryReceiptInput,
};
use crate::world_model::repositories::prospective_repository::mark_open_loop_asked;
use crate::world_model::scope::WorldModelScope;
use crate::world_model::services::standing_intent_dispatcher::{
    execute_standing_intent_follow_up, StandingIntentFollowUpInput,
};
use crate::world_model::types::OutboxEvent;

/// `WORLD_MODEL_PROACTIVE_CHANNELS` (`:46`).
pub const PROACTIVE_CHANNELS_ENV: &str = "WORLD_MODEL_PROACTIVE_CHANNELS";
/// The default order of `:46`.
pub const DEFAULT_PROACTIVE_CHANNELS: &str = "telegram,whatsapp,discord,slack,imessage,webchat";

/// `ProactiveDeliveryResult` from `proactiveChannelDelivery.ts:27-34`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProactiveDeliveryResult {
    pub delivered: bool,
    pub provider_message_id: Option<String>,
    pub provider_id: Option<String>,
    pub channel: Option<String>,
    pub target: Option<String>,
    pub error: Option<String>,
}

/// The `{ channel, externalChatId }` answer of `resolveDeliveryChannel` (`:44`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedChannel {
    pub channel: String,
    pub external_chat_id: String,
}

/// `deliverOutboundWithReceipt(...)` (`:111`) reduced to the receipt fields the
/// caller reads (`:128-129`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OutboundReceipt {
    pub provider_id: Option<String>,
    pub provider_message_id: Option<String>,
}

/// `getMessageRepository().listChannelBindings(userId)` (`:51`).
pub type ListChannelBindings = Arc<dyn Fn(&str) -> Vec<ChannelBinding> + Send + Sync>;

/// `deliverOutboundWithReceipt(channel, externalChatId, message, { personaId })`
/// (`:111-116`).
///
/// `Ok(None)` is the `null` of `:117`/`:168`, `Err` the rejection of the
/// surrounding `catch` (`:131`/`:182`).
pub type DeliverOutbound = Arc<
    dyn Fn(
            String,
            String,
            String,
            String,
        ) -> BoxFuture<'static, Result<Option<OutboundReceipt>, String>>
        + Send
        + Sync,
>;

/// `new Date().toISOString()` (`:214`).
pub type Clock = Arc<dyn Fn() -> String + Send + Sync>;

/// `Object.values(ChannelType)` (`:82`).
const CHANNEL_TYPE_VALUES: [ChannelType; 7] = [
    ChannelType::WhatsApp,
    ChannelType::Telegram,
    ChannelType::Slack,
    ChannelType::Discord,
    ChannelType::WebChat,
    ChannelType::IMessage,
    ChannelType::AgentRoom,
];

/// `Number.MAX_SAFE_INTEGER` (`:75`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `String(value ?? '')` for one payload property.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_string(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// `event.payload?.<key> ?? fallback ?? ''` of `:220-222`/`:270-272`.
fn payload_or_event(payload: &Map<String, Value>, key: &str, fallback: Option<&String>) -> String {
    match payload.get(key) {
        Some(value) if !value.is_null() => js_string(Some(value)),
        _ => fallback.cloned().unwrap_or_default(),
    }
}

/// The `metadata.proactivePriority` probe of `:66-70`.
///
/// `typeof === 'number'` is the JSON number check; a non-number is `null`, which
/// the `??` of `:74` then replaces.
fn explicit_priority(metadata: &Map<String, Value>) -> Option<f64> {
    metadata.get("proactivePriority").and_then(Value::as_f64)
}

/// `JSON.parse(binding.metadata ?? '{}')` reduced to the object case (`:58-65`).
fn binding_metadata(binding: &ChannelBinding) -> Map<String, Value> {
    let Some(raw) = binding.metadata.as_ref() else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// `resolveDeliveryChannel(userId, personaId)` — `proactiveChannelDelivery.ts:41-88`.
pub fn resolve_delivery_channel(
    env: &HashMap<String, String>,
    list_bindings: &ListChannelBindings,
    user_id: &str,
    persona_id: &str,
) -> Option<ResolvedChannel> {
    let preferred: Vec<String> = env
        .get(PROACTIVE_CHANNELS_ENV)
        .map(String::as_str)
        .unwrap_or(DEFAULT_PROACTIVE_CHANNELS)
        .split(',')
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .collect();

    let bindings = list_bindings(user_id);
    let mut available: Vec<(ChannelBinding, f64)> = bindings
        .into_iter()
        .filter(|binding| binding.status == "connected")
        .filter(|binding| match &binding.persona_id {
            None => true,
            Some(binding_persona) => binding_persona == persona_id,
        })
        .filter(|binding| {
            binding
                .external_peer_id
                .as_deref()
                .is_some_and(|peer| !peer.is_empty())
        })
        .map(|binding| {
            let metadata = binding_metadata(&binding);
            let configured_index = preferred
                .iter()
                .position(|candidate| candidate == &binding.channel);
            let priority = explicit_priority(&metadata).unwrap_or_else(|| {
                configured_index
                    .map(|index| index as f64)
                    .unwrap_or(MAX_SAFE_INTEGER)
            });
            (binding, priority)
        })
        .collect();
    available.sort_by(|left, right| {
        left.1
            .partial_cmp(&right.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for (binding, _) in available {
        let Some(external_chat_id) = binding.external_peer_id.clone() else {
            continue;
        };
        if external_chat_id.is_empty() {
            continue;
        }
        let channel_type = CHANNEL_TYPE_VALUES
            .iter()
            .find(|value| value.as_str().to_lowercase() == binding.channel);
        if let Some(channel_type) = channel_type {
            return Some(ResolvedChannel {
                channel: channel_type.as_str().to_string(),
                external_chat_id,
            });
        }
    }
    None
}

/// `deliverProactiveQuestion(event)` — `proactiveChannelDelivery.ts:93-138`.
pub async fn deliver_proactive_question(
    env: &HashMap<String, String>,
    list_bindings: &ListChannelBindings,
    deliver_outbound: &DeliverOutbound,
    event: &OutboxEvent,
) -> ProactiveDeliveryResult {
    let payload = &event.input.payload;
    let user_id = js_string(payload.get("userId"));
    let persona_id = js_string(payload.get("personaId"));
    let question = js_string(payload.get("question"));

    if user_id.is_empty() || persona_id.is_empty() || question.is_empty() {
        return ProactiveDeliveryResult {
            delivered: false,
            error: Some("missing required payload fields".to_string()),
            ..ProactiveDeliveryResult::default()
        };
    }

    let Some(channel) = resolve_delivery_channel(env, list_bindings, &user_id, &persona_id) else {
        return ProactiveDeliveryResult {
            delivered: false,
            error: Some("no delivery channel available".to_string()),
            ..ProactiveDeliveryResult::default()
        };
    };

    deliver_through_channel(deliver_outbound, channel, question, persona_id).await
}

/// `deliverIntentFiredNotification(event)` — `proactiveChannelDelivery.ts:143-189`.
pub async fn deliver_intent_fired_notification(
    env: &HashMap<String, String>,
    list_bindings: &ListChannelBindings,
    deliver_outbound: &DeliverOutbound,
    event: &OutboxEvent,
) -> ProactiveDeliveryResult {
    let payload = &event.input.payload;
    let user_id = js_string(payload.get("userId"));
    let persona_id = js_string(payload.get("personaId"));
    let description = js_string(payload.get("description"));

    if user_id.is_empty() || persona_id.is_empty() || description.is_empty() {
        return ProactiveDeliveryResult {
            delivered: false,
            error: Some("missing required payload fields".to_string()),
            ..ProactiveDeliveryResult::default()
        };
    }

    let Some(channel) = resolve_delivery_channel(env, list_bindings, &user_id, &persona_id) else {
        return ProactiveDeliveryResult {
            delivered: false,
            error: Some("no delivery channel available".to_string()),
            ..ProactiveDeliveryResult::default()
        };
    };

    let message = format!("🔔 Erinnerung: {description}");
    deliver_through_channel(deliver_outbound, channel, message, persona_id).await
}

/// The shared `try`/`catch` of `:110-137` and `:161-188`.
async fn deliver_through_channel(
    deliver_outbound: &DeliverOutbound,
    channel: ResolvedChannel,
    message: String,
    persona_id: String,
) -> ProactiveDeliveryResult {
    let channel_type = channel.channel.clone();
    let target = channel.external_chat_id.clone();
    match deliver_outbound(
        channel.channel,
        channel.external_chat_id,
        message,
        persona_id,
    )
    .await
    {
        Ok(None) => ProactiveDeliveryResult {
            delivered: false,
            channel: Some(channel_type),
            target: Some(target),
            error: Some("no outbound adapter".to_string()),
            ..ProactiveDeliveryResult::default()
        },
        Ok(Some(receipt)) => ProactiveDeliveryResult {
            delivered: true,
            provider_id: receipt.provider_id,
            provider_message_id: receipt.provider_message_id,
            channel: Some(channel_type),
            target: Some(target),
            error: None,
        },
        Err(message) => ProactiveDeliveryResult {
            delivered: false,
            channel: Some(channel_type),
            target: None,
            error: Some(message),
            ..ProactiveDeliveryResult::default()
        },
    }
}

/// A `PgExecutor` over the already-scoped transaction session, like the
/// projector's adapter (`projector/projectWindow.ts` runs the same way).
struct SessionExecutor(Arc<dyn PgSession>);

impl PgExecutor for SessionExecutor {
    fn connect<'a>(&'a self) -> BoxFuture<'a, Result<Arc<dyn PgSession>, PgError>> {
        Box::pin(async {
            Err(PgError::new(
                "[world-model] nested proactive delivery transaction",
            ))
        })
    }

    fn query<'a>(
        &'a self,
        statement: PgStatement,
    ) -> BoxFuture<'a, Result<PgQueryResult, PgError>> {
        self.0.query(statement)
    }
}

/// `String(event.payload?.openLoopId ?? event.aggregateId)` (`:211`).
fn event_open_loop_id(event: &OutboxEvent) -> String {
    match event.input.payload.get("openLoopId") {
        Some(value) if !value.is_null() => js_string(Some(value)),
        _ => event.input.aggregate_id.clone(),
    }
}

/// `{ question: event.payload?.question }` (`:228`).
fn question_payload(event: &OutboxEvent) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert(
        "question".to_string(),
        event
            .input
            .payload
            .get("question")
            .cloned()
            .unwrap_or(Value::Null),
    );
    payload
}

/// `{ description: event.payload?.description }` (`:277`).
fn description_payload(event: &OutboxEvent) -> Map<String, Value> {
    let mut payload = Map::new();
    payload.insert(
        "description".to_string(),
        event
            .input
            .payload
            .get("description")
            .cloned()
            .unwrap_or(Value::Null),
    );
    payload
}

/// `createProactiveQuestionHandler()` — `proactiveChannelDelivery.ts:195-240`.
#[allow(clippy::too_many_arguments)]
pub fn create_proactive_question_handler(
    executor: Arc<dyn PgExecutor>,
    config: WorldModelConfig,
    env: HashMap<String, String>,
    list_bindings: ListChannelBindings,
    deliver_outbound: DeliverOutbound,
    clock: Clock,
) -> OutboxHandler {
    Arc::new(move |event: OutboxEvent, scope: Option<WorldModelScope>| {
        let executor = Arc::clone(&executor);
        let config = config.clone();
        let env = env.clone();
        let list_bindings = Arc::clone(&list_bindings);
        let deliver_outbound = Arc::clone(&deliver_outbound);
        let clock = Arc::clone(&clock);
        Box::pin(async move {
            if !config.enabled && !config.e2e_enabled {
                return Ok(());
            }

            let existing = get_delivery_receipt_by_outbox_event_id::<PgError>(
                executor.as_ref(),
                scope.as_ref(),
                &event.id,
            )
            .await
            .map_err(|error| error.message)?;
            if existing.is_some() {
                return Ok(());
            }

            let result =
                deliver_proactive_question(&env, &list_bindings, &deliver_outbound, &event).await;
            if !result.delivered {
                return Err(format!(
                    "[world-model:proactive] question delivery failed: {}",
                    result
                        .error
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string())
                ));
            }

            let open_loop_id = event_open_loop_id(&event);
            if !open_loop_id.is_empty() {
                let now = clock();
                let input = DeliveryReceiptInput {
                    outbox_event_id: event.id.clone(),
                    open_loop_id: Some(open_loop_id.clone()),
                    user_id: payload_or_event(
                        &event.input.payload,
                        "userId",
                        event.input.user_id.as_ref(),
                    ),
                    persona_id: payload_or_event(
                        &event.input.payload,
                        "personaId",
                        event.input.persona_id.as_ref(),
                    ),
                    workspace_id: Some(payload_or_event(
                        &event.input.payload,
                        "workspaceId",
                        event.input.workspace_id.as_ref(),
                    )),
                    channel: result
                        .channel
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string()),
                    target: result.target.clone().unwrap_or_default(),
                    provider_id: result.provider_id.clone(),
                    provider_message_id: result.provider_message_id.clone(),
                    delivered_at: Some(now.clone()),
                    payload: Some(question_payload(&event)),
                };
                let marker = open_loop_id.clone();
                let transaction_clock = now.clone();
                let _ = ambient_transaction::<(), PgError>(
                    executor.as_ref(),
                    scope.as_ref(),
                    Box::new(move |session| {
                        let query_executor = SessionExecutor(Arc::clone(&session));
                        let input = input.clone();
                        let marker = marker.clone();
                        let transaction_clock = transaction_clock.clone();
                        Box::pin(async move {
                            insert_delivery_receipt::<PgError>(&query_executor, None, &input)
                                .await?;
                            mark_open_loop_asked::<PgError>(
                                &query_executor,
                                None,
                                &marker,
                                &transaction_clock,
                            )
                            .await?;
                            Ok(())
                        })
                    }),
                )
                .await;
            }
            Ok(())
        })
    })
}

/// `createProactiveIntentFiredHandler()` — `proactiveChannelDelivery.ts:245-280`.
#[allow(clippy::too_many_arguments)]
pub fn create_proactive_intent_fired_handler(
    executor: Arc<dyn PgExecutor>,
    config: WorldModelConfig,
    env: HashMap<String, String>,
    list_bindings: ListChannelBindings,
    deliver_outbound: DeliverOutbound,
) -> OutboxHandler {
    Arc::new(move |event: OutboxEvent, scope: Option<WorldModelScope>| {
        let executor = Arc::clone(&executor);
        let config = config.clone();
        let env = env.clone();
        let list_bindings = Arc::clone(&list_bindings);
        let deliver_outbound = Arc::clone(&deliver_outbound);
        Box::pin(async move {
            if !config.enabled && !config.e2e_enabled {
                return Ok(());
            }

            let existing = get_delivery_receipt_by_outbox_event_id::<PgError>(
                executor.as_ref(),
                scope.as_ref(),
                &event.id,
            )
            .await
            .map_err(|error| error.message)?;
            if existing.is_some() {
                return Ok(());
            }

            execute_standing_intent_follow_up(
                executor.as_ref(),
                &StandingIntentFollowUpInput {
                    intent_id: payload_or_event(
                        &event.input.payload,
                        "intentId",
                        Some(&event.input.aggregate_id),
                    ),
                    user_id: payload_or_event(
                        &event.input.payload,
                        "userId",
                        event.input.user_id.as_ref(),
                    ),
                    persona_id: payload_or_event(
                        &event.input.payload,
                        "personaId",
                        event.input.persona_id.as_ref(),
                    ),
                    workspace_id: Some(payload_or_event(
                        &event.input.payload,
                        "workspaceId",
                        event.input.workspace_id.as_ref(),
                    )),
                    description: js_string(event.input.payload.get("description")),
                    firing_observation_id: js_string(
                        event.input.payload.get("firingObservationId"),
                    ),
                },
                None,
            )
            .await
            .map_err(|error| error.message)?;

            let result =
                deliver_intent_fired_notification(&env, &list_bindings, &deliver_outbound, &event)
                    .await;
            if !result.delivered {
                return Err(format!(
                    "[world-model:proactive] intent notification delivery failed: {}",
                    result
                        .error
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string())
                ));
            }

            let input = DeliveryReceiptInput {
                outbox_event_id: event.id.clone(),
                open_loop_id: None,
                user_id: payload_or_event(
                    &event.input.payload,
                    "userId",
                    event.input.user_id.as_ref(),
                ),
                persona_id: payload_or_event(
                    &event.input.payload,
                    "personaId",
                    event.input.persona_id.as_ref(),
                ),
                workspace_id: Some(payload_or_event(
                    &event.input.payload,
                    "workspaceId",
                    event.input.workspace_id.as_ref(),
                )),
                channel: result
                    .channel
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
                target: result.target.clone().unwrap_or_default(),
                provider_id: result.provider_id.clone(),
                provider_message_id: result.provider_message_id.clone(),
                delivered_at: None,
                payload: Some(description_payload(&event)),
            };
            insert_delivery_receipt::<PgError>(executor.as_ref(), scope.as_ref(), &input)
                .await
                .map_err(|error| error.message)?;
            Ok(())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_model::db::drive_sync;
    use crate::world_model::db::testing::{Recorded, RecordingExecutor};
    use crate::world_model::db::{PgQueryResult, PgValue, SQL_BEGIN, SQL_COMMIT};
    use crate::world_model::repositories::delivery_receipt_repository::SQL_INSERT_RECEIPT;
    use crate::world_model::types::{OutboxEventInput, OutboxStatus};
    use serde_json::json;

    fn binding(
        channel: &str,
        status: &str,
        peer: Option<&str>,
        persona: Option<&str>,
        metadata: Option<&str>,
    ) -> ChannelBinding {
        ChannelBinding {
            user_id: "u1".to_string(),
            channel: channel.to_string(),
            status: status.to_string(),
            external_peer_id: peer.map(str::to_string),
            peer_name: None,
            transport: None,
            metadata: metadata.map(str::to_string),
            persona_id: persona.map(str::to_string),
            last_seen_at: None,
            created_at: "2026-10-10T00:00:00.000Z".to_string(),
            updated_at: "2026-10-10T00:00:00.000Z".to_string(),
        }
    }

    fn bindings(value: Vec<ChannelBinding>) -> ListChannelBindings {
        Arc::new(move |_user_id: &str| value.clone())
    }

    fn no_delivery() -> DeliverOutbound {
        Arc::new(
            |_channel: String, _target: String, _message: String, _persona: String| {
                Box::pin(async { Ok(None) })
            },
        )
    }

    fn ok_delivery() -> DeliverOutbound {
        Arc::new(
            |_channel: String, _target: String, _message: String, _persona: String| {
                Box::pin(async {
                    Ok(Some(OutboundReceipt {
                        provider_id: Some("telegram".to_string()),
                        provider_message_id: Some("m1".to_string()),
                    }))
                })
            },
        )
    }

    fn outbox(event_type: &str, aggregate_id: &str, payload: Value) -> OutboxEvent {
        OutboxEvent {
            input: OutboxEventInput {
                event_type: event_type.to_string(),
                aggregate_type: "test".to_string(),
                aggregate_id: aggregate_id.to_string(),
                payload: payload.as_object().expect("payload").clone(),
                idempotency_key: None,
                correlation_id: None,
                user_id: Some("u1".to_string()),
                persona_id: Some("p1".to_string()),
                workspace_id: Some("w1".to_string()),
            },
            id: "ob1".to_string(),
            status: OutboxStatus::Pending,
            attempts: 0,
            error_message: None,
            created_at: "2026-10-10T00:00:00.000Z".to_string(),
            dispatched_at: None,
            created: None,
        }
    }

    fn receipt_row() -> crate::world_model::db::PgRow {
        json!({
            "id":"r1", "outbox_event_id":"ob1", "open_loop_id":"l1", "user_id":"u1",
            "persona_id":"p1", "workspace_id":"w1", "channel":"Telegram", "target":"+49",
            "provider_id":"telegram", "provider_message_id":"m1",
            "delivered_at":"2026-10-10T00:00:05.000Z", "payload":{"question":"Confirm?"}
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn resolve_prefers_the_configured_order_and_skips_unusable_bindings() {
        let env = HashMap::new();
        let list = bindings(vec![
            binding("slack", "connected", Some("s1"), None, None),
            binding("telegram", "disconnected", Some("t1"), None, None),
            binding("whatsapp", "connected", Some("w1"), None, None),
            binding("discord", "connected", None, None, None),
            binding("imessage", "connected", Some("i1"), Some("other"), None),
        ]);
        let resolved = resolve_delivery_channel(&env, &list, "u1", "p1").expect("a usable channel");
        assert_eq!(resolved.channel, "WhatsApp");
        assert_eq!(resolved.external_chat_id, "w1");
    }

    #[test]
    fn resolve_honours_an_explicit_metadata_priority() {
        let env = HashMap::new();
        let list = bindings(vec![
            binding("whatsapp", "connected", Some("w1"), None, None),
            binding(
                "slack",
                "connected",
                Some("s1"),
                None,
                Some(r#"{"proactivePriority":0}"#),
            ),
        ]);
        let resolved = resolve_delivery_channel(&env, &list, "u1", "p1").expect("channel");
        assert_eq!(
            resolved.channel, "Slack",
            "priority 0 beats the default order"
        );
        assert_eq!(resolved.external_chat_id, "s1");
    }

    #[test]
    fn resolve_ignores_invalid_metadata_and_returns_none_without_a_binding() {
        let env = HashMap::new();
        let list = bindings(vec![binding(
            "telegram",
            "connected",
            Some("t1"),
            None,
            Some("not json"),
        )]);
        assert_eq!(
            resolve_delivery_channel(&env, &list, "u1", "p1")
                .expect("channel")
                .channel,
            "Telegram"
        );

        let empty = bindings(vec![]);
        assert!(resolve_delivery_channel(&env, &empty, "u1", "p1").is_none());
    }

    #[test]
    fn delivering_a_question_maps_every_outcome_of_the_source() {
        let env = HashMap::new();
        let list = bindings(vec![binding(
            "telegram",
            "connected",
            Some("t1"),
            None,
            None,
        )]);

        let missing = drive_sync(deliver_proactive_question(
            &env,
            &list,
            &ok_delivery(),
            &outbox("proactive.question.requested", "l1", json!({})),
        ))
        .expect("bridge");
        assert_eq!(
            missing.error.as_deref(),
            Some("missing required payload fields")
        );

        let no_channel = drive_sync(deliver_proactive_question(
            &env,
            &bindings(vec![]),
            &ok_delivery(),
            &outbox(
                "proactive.question.requested",
                "l1",
                json!({ "userId": "u1", "personaId": "p1", "question": "Confirm?" }),
            ),
        ))
        .expect("bridge");
        assert_eq!(
            no_channel.error.as_deref(),
            Some("no delivery channel available")
        );

        let no_adapter = drive_sync(deliver_proactive_question(
            &env,
            &list,
            &no_delivery(),
            &outbox(
                "proactive.question.requested",
                "l1",
                json!({ "userId": "u1", "personaId": "p1", "question": "Confirm?" }),
            ),
        ))
        .expect("bridge");
        assert_eq!(no_adapter.error.as_deref(), Some("no outbound adapter"));
        assert_eq!(no_adapter.channel.as_deref(), Some("Telegram"));
        assert_eq!(no_adapter.target.as_deref(), Some("t1"));

        let delivered = drive_sync(deliver_proactive_question(
            &env,
            &list,
            &ok_delivery(),
            &outbox(
                "proactive.question.requested",
                "l1",
                json!({ "userId": "u1", "personaId": "p1", "question": "Confirm?" }),
            ),
        ))
        .expect("bridge");
        assert!(delivered.delivered);
        assert_eq!(delivered.provider_id.as_deref(), Some("telegram"));
        assert_eq!(delivered.provider_message_id.as_deref(), Some("m1"));
        assert_eq!(delivered.channel.as_deref(), Some("Telegram"));
    }

    #[test]
    fn an_intent_notification_prefixes_the_description() {
        let env = HashMap::new();
        let list = bindings(vec![binding(
            "telegram",
            "connected",
            Some("t1"),
            None,
            None,
        )]);
        let seen: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
        let sink = Arc::clone(&seen);
        let deliver: DeliverOutbound = Arc::new(
            move |_channel: String, _target: String, message: String, persona: String| {
                let sink = Arc::clone(&sink);
                Box::pin(async move {
                    *sink.lock().expect("sink") = Some(format!("{message}|{persona}"));
                    Ok(Some(OutboundReceipt::default()))
                })
            },
        );
        let result = drive_sync(deliver_intent_fired_notification(
            &env,
            &list,
            &deliver,
            &outbox(
                "proactive.intent.fired",
                "si1",
                json!({ "userId": "u1", "personaId": "p1", "description": "Call Mira" }),
            ),
        ))
        .expect("bridge");
        assert!(result.delivered);
        assert_eq!(
            seen.lock().expect("sink").clone(),
            Some("🔔 Erinnerung: Call Mira|p1".to_string())
        );
    }

    #[test]
    fn a_disabled_handler_returns_before_any_statement() {
        let executor = Arc::new(RecordingExecutor::new(vec![]));
        let handler = create_proactive_question_handler(
            executor.clone(),
            WorldModelConfig::default(),
            HashMap::new(),
            bindings(vec![]),
            ok_delivery(),
            Arc::new(|| "2026-10-10T00:00:00.000Z".to_string()),
        );
        drive_sync(handler(
            outbox(
                "proactive.question.requested",
                "l1",
                json!({ "userId": "u1", "personaId": "p1", "question": "Confirm?" }),
            ),
            None,
        ))
        .expect("bridge")
        .expect("handled");
        assert!(executor.calls().is_empty());
    }

    #[test]
    fn a_replayed_event_skips_delivery_after_the_receipt_lookup() {
        let executor = Arc::new(RecordingExecutor::new(vec![Ok(PgQueryResult::from_rows(
            vec![receipt_row()],
        ))]));
        let handler = create_proactive_question_handler(
            executor.clone(),
            WorldModelConfig {
                enabled: true,
                ..Default::default()
            },
            HashMap::new(),
            bindings(vec![binding(
                "telegram",
                "connected",
                Some("t1"),
                None,
                None,
            )]),
            ok_delivery(),
            Arc::new(|| "2026-10-10T00:00:00.000Z".to_string()),
        );
        drive_sync(handler(
            outbox(
                "proactive.question.requested",
                "l1",
                json!({ "userId": "u1", "personaId": "p1", "question": "Confirm?" }),
            ),
            None,
        ))
        .expect("bridge")
        .expect("handled");
        assert_eq!(executor.calls().len(), 1);
    }

    #[test]
    fn a_successful_delivery_writes_the_receipt_and_marks_the_open_loop() {
        let executor = Arc::new(RecordingExecutor::new(vec![
            Ok(PgQueryResult::empty()),
            Ok(PgQueryResult::from_rows(vec![receipt_row()])),
            Ok(PgQueryResult::affected(1)),
        ]));
        let handler = create_proactive_question_handler(
            executor.clone(),
            WorldModelConfig {
                enabled: true,
                ..Default::default()
            },
            HashMap::new(),
            bindings(vec![binding(
                "telegram",
                "connected",
                Some("t1"),
                None,
                None,
            )]),
            ok_delivery(),
            Arc::new(|| "2026-10-10T00:00:07.000Z".to_string()),
        );
        drive_sync(handler(outbox(
            "proactive.question.requested",
            "l1",
            json!({ "userId": "u1", "personaId": "p1", "question": "Confirm?", "openLoopId": "l1" }),
        ), None))
        .expect("bridge")
        .expect("handled");

        let sqls: Vec<String> = executor
            .calls()
            .iter()
            .map(|call| call.sql().to_string())
            .collect();
        assert!(sqls.contains(&SQL_BEGIN.to_string()));
        assert!(sqls.contains(&SQL_COMMIT.to_string()));
        assert!(sqls.contains(&SQL_INSERT_RECEIPT.to_string()));
        assert!(sqls
            .iter()
            .any(|sql| sql.contains("UPDATE world_model_open_loops")));
        let insert = executor
            .calls()
            .into_iter()
            .find_map(|call| match call {
                Recorded::Statement(statement) if statement.sql == SQL_INSERT_RECEIPT => {
                    Some(statement)
                }
                _ => None,
            })
            .expect("insert");
        assert_eq!(insert.params[5], PgValue::text("Telegram"));
        assert_eq!(insert.params[9], PgValue::text("2026-10-10T00:00:07.000Z"));
    }

    #[test]
    fn a_failed_delivery_is_reported_with_the_source_literal() {
        let executor = Arc::new(RecordingExecutor::new(vec![Ok(PgQueryResult::empty())]));
        let handler = create_proactive_question_handler(
            executor.clone(),
            WorldModelConfig {
                enabled: true,
                ..Default::default()
            },
            HashMap::new(),
            bindings(vec![binding(
                "telegram",
                "connected",
                Some("t1"),
                None,
                None,
            )]),
            no_delivery(),
            Arc::new(|| "2026-10-10T00:00:00.000Z".to_string()),
        );
        let error = drive_sync(handler(
            outbox(
                "proactive.question.requested",
                "l1",
                json!({ "userId": "u1", "personaId": "p1", "question": "Confirm?" }),
            ),
            None,
        ))
        .expect("bridge")
        .expect_err("delivery failed");
        assert_eq!(
            error,
            "[world-model:proactive] question delivery failed: no outbound adapter"
        );
    }
}
