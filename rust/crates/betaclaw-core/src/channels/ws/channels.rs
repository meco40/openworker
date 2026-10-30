//! Port of `src/server/gateway/methods/channels.ts` (S8): `channels.list`,
//! `channels.pair` and `channels.unpair`.
//!
//! `inbox.list` from the same TypeScript file is not ported here. It depends on
//! the inbox contract, the rate limiter and the observability calls, which belong
//! to the inbox slice (S3) and to OP-2.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::gateway::events::CHANNELS_STATUS;

use super::helpers::{insert_if_some, js_truthy, non_empty, now_iso, str_param, HandlerError};
use super::ports::{ChannelBinding, ChannelBindingWrite, ChannelPairing, EventSink, MessageStore};

/// `CHANNEL_CAPABILITIES` in `src/server/channels/adapters/capabilities.ts`, in
/// its declaration order. That order is the order of `channels.list`.
struct Capabilities {
    channel: &'static str,
    inbound: bool,
    outbound: bool,
    pairing: bool,
    streaming: bool,
}

const CHANNEL_CAPABILITIES: &[Capabilities] = &[
    Capabilities {
        channel: "webchat",
        inbound: true,
        outbound: false,
        pairing: false,
        streaming: true,
    },
    Capabilities {
        channel: "agent_room",
        inbound: true,
        outbound: false,
        pairing: false,
        streaming: true,
    },
    Capabilities {
        channel: "telegram",
        inbound: true,
        outbound: true,
        pairing: true,
        streaming: false,
    },
    Capabilities {
        channel: "whatsapp",
        inbound: true,
        outbound: true,
        pairing: true,
        streaming: false,
    },
    Capabilities {
        channel: "discord",
        inbound: true,
        outbound: true,
        pairing: true,
        streaming: false,
    },
    Capabilities {
        channel: "imessage",
        inbound: true,
        outbound: true,
        pairing: true,
        streaming: false,
    },
    Capabilities {
        channel: "slack",
        inbound: true,
        outbound: true,
        pairing: true,
        streaming: false,
    },
];

/// `isPairChannelType` in `src/server/channels/pairing/index.ts`.
pub fn is_pair_channel_type(channel: &str) -> bool {
    matches!(
        channel,
        "whatsapp" | "telegram" | "discord" | "imessage" | "slack"
    )
}

/// `channels.list`: every known channel with its binding state, in table order.
pub fn list(
    store: &dyn MessageStore,
    pairing: &dyn ChannelPairing,
    user_id: &str,
) -> Result<Value, HandlerError> {
    // A later binding for the same channel overwrites an earlier one, as in `new Map(...)`.
    let bindings: HashMap<String, ChannelBinding> = store
        .list_channel_bindings(user_id)?
        .into_iter()
        .map(|binding| (binding.channel.clone(), binding))
        .collect();

    let mut channels = Vec::with_capacity(CHANNEL_CAPABILITIES.len());
    for caps in CHANNEL_CAPABILITIES {
        let binding = bindings.get(caps.channel);
        let mut entry = json!({
            "channel": caps.channel,
            "status": binding.and_then(|b| b.status.as_deref()).unwrap_or("idle"),
            "peerName": binding.and_then(|b| b.peer_name.clone()),
            "transport": binding.and_then(|b| b.transport.clone()),
            "lastSeenAt": binding.and_then(|b| b.last_seen_at.clone()),
            "supportsInbound": caps.inbound,
            "supportsOutbound": caps.outbound,
            "supportsPairing": caps.pairing,
            "supportsStreaming": caps.streaming,
        });
        if matches!(caps.channel, "whatsapp" | "imessage") {
            entry["accounts"] = pairing.list_bridge_accounts(caps.channel)?;
        }
        channels.push(entry);
    }

    Ok(json!({ "channels": channels, "generatedAt": now_iso() }))
}

/// `channels.pair`: pairs a channel, stores the binding, and broadcasts the status.
pub async fn pair(
    store: &dyn MessageStore,
    pairing: &dyn ChannelPairing,
    events: &dyn EventSink,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let channel = str_param(params, "channel").trim().to_lowercase();
    let token = str_param(params, "token").to_string();
    let account_id = str_param(params, "accountId").to_string();

    if !is_pair_channel_type(&channel) {
        return Err(HandlerError::plain(format!(
            "Unsupported channel: {channel}"
        )));
    }

    let result = pairing
        .pair_channel(&channel, &token, non_empty(&account_id).as_deref())
        .await?;

    let status = result
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("connected")
        .to_string();
    let transport = result.get("transport").and_then(Value::as_str);
    let peer_name = result.get("peerName").and_then(Value::as_str);
    let account_label = non_empty(&account_id).unwrap_or_else(|| "default".to_string());

    // `result.accountId || accountId || 'default'`, stored when the key is present.
    let has_account_key = result
        .as_object()
        .is_some_and(|object| object.contains_key("accountId"));
    let metadata = if has_account_key {
        let account = match result.get("accountId") {
            Some(value) if js_truthy(Some(value)) => value.clone(),
            _ => Value::String(account_label.clone()),
        };
        Some(json!({ "accountId": account }))
    } else {
        non_empty(&account_id).map(|id| json!({ "accountId": id }))
    };

    let binding_status = if status == "awaiting_code" {
        "awaiting_code"
    } else {
        "connected"
    };
    store.upsert_channel_binding(ChannelBindingWrite {
        user_id: user_id.to_string(),
        channel: channel.clone(),
        status: binding_status.to_string(),
        peer_name: peer_name.map(str::to_string),
        transport: transport.map(str::to_string),
        metadata,
    })?;

    let updated_at = now_iso();
    let mut broadcast = Map::new();
    broadcast.insert("channel".into(), json!(channel));
    broadcast.insert("accountId".into(), json!(account_label));
    broadcast.insert("status".into(), json!(status));
    insert_if_some(&mut broadcast, "peerName", peer_name);
    insert_if_some(&mut broadcast, "transport", transport);
    broadcast.insert("updatedAt".into(), json!(updated_at));
    events.broadcast_to_user(user_id, CHANNELS_STATUS, Value::Object(broadcast));

    let response_account = result
        .get("accountId")
        .and_then(Value::as_str)
        .map_or_else(|| account_label.clone(), str::to_string);
    let mut response = Map::new();
    response.insert("ok".into(), json!(true));
    response.insert("channel".into(), json!(channel));
    response.insert("accountId".into(), json!(response_account));
    response.insert("status".into(), json!(status));
    insert_if_some(&mut response, "transport", transport);
    insert_if_some(&mut response, "peerName", peer_name);
    response.insert("connectedAt".into(), json!(updated_at));
    if let Some(details) = result.get("details") {
        response.insert("details".into(), details.clone());
    }
    Ok(Value::Object(response))
}

/// `channels.unpair`: unpairs a channel, marks it disconnected and broadcasts it.
pub async fn unpair(
    store: &dyn MessageStore,
    pairing: &dyn ChannelPairing,
    events: &dyn EventSink,
    user_id: &str,
    params: &Value,
) -> Result<Value, HandlerError> {
    let channel = str_param(params, "channel").trim().to_lowercase();
    let account_id = str_param(params, "accountId").to_string();

    if !is_pair_channel_type(&channel) {
        return Err(HandlerError::plain(format!(
            "Unsupported channel: {channel}"
        )));
    }

    pairing
        .unpair_channel(&channel, non_empty(&account_id).as_deref())
        .await?;

    store.upsert_channel_binding(ChannelBindingWrite {
        user_id: user_id.to_string(),
        channel: channel.clone(),
        status: "disconnected".to_string(),
        peer_name: None,
        transport: None,
        metadata: non_empty(&account_id).map(|id| json!({ "accountId": id })),
    })?;

    let updated_at = now_iso();
    let account_label = non_empty(&account_id).unwrap_or_else(|| "default".to_string());
    events.broadcast_to_user(
        user_id,
        CHANNELS_STATUS,
        json!({
            "channel": channel,
            "accountId": account_label,
            "status": "disconnected",
            "updatedAt": updated_at,
        }),
    );

    Ok(json!({
        "ok": true,
        "channel": channel,
        "accountId": account_label,
        "status": "disconnected",
        "updatedAt": updated_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::Fake;
    use super::*;

    #[test]
    fn list_reports_every_channel_with_its_binding() {
        let fake = Fake::default();
        {
            let mut state = fake.state.lock().unwrap();
            state.bindings = vec![ChannelBinding {
                channel: "telegram".into(),
                status: Some("connected".into()),
                peer_name: Some("bot".into()),
                transport: None,
                last_seen_at: None,
            }];
            state.bridge_accounts = json!([{"id": "acc"}]);
        }

        let payload = list(&fake, &fake, "u1").unwrap();
        let channels = payload["channels"].as_array().unwrap();
        let names: Vec<&str> = channels
            .iter()
            .map(|entry| entry["channel"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "webchat",
                "agent_room",
                "telegram",
                "whatsapp",
                "discord",
                "imessage",
                "slack"
            ]
        );
        assert_eq!(channels[0]["status"], "idle");
        assert_eq!(channels[0]["peerName"], Value::Null);
        assert_eq!(channels[0]["supportsStreaming"], true);
        assert_eq!(channels[2]["status"], "connected");
        assert_eq!(channels[2]["peerName"], "bot");
        assert!(channels[2].get("accounts").is_none());
        assert_eq!(channels[3]["accounts"], json!([{"id": "acc"}]));
        assert!(payload["generatedAt"].is_string());
    }

    #[tokio::test]
    async fn pair_rejects_an_unknown_channel() {
        let fake = Fake::default();
        let err = pair(&fake, &fake, &fake, "u1", &json!({"channel": "matrix"}))
            .await
            .unwrap_err();
        assert_eq!(err, HandlerError::plain("Unsupported channel: matrix"));
    }

    #[tokio::test]
    async fn pair_stores_the_result_and_broadcasts_with_the_default_label() {
        let fake = Fake::default();
        fake.state.lock().unwrap().pair_result = json!({
            "status": "awaiting_code",
            "peerName": "bot",
            "transport": "polling",
            "accountId": "acc1",
            "details": {"hint": 1},
        });

        let payload = pair(
            &fake,
            &fake,
            &fake,
            "u1",
            &json!({"channel": " Telegram ", "token": "t0"}),
        )
        .await
        .unwrap();

        assert_eq!(payload["ok"], true);
        assert_eq!(payload["channel"], "telegram");
        assert_eq!(payload["accountId"], "acc1");
        assert_eq!(payload["status"], "awaiting_code");
        assert_eq!(payload["transport"], "polling");
        assert_eq!(payload["peerName"], "bot");
        assert_eq!(payload["details"], json!({"hint": 1}));
        assert!(payload["connectedAt"].is_string());

        let state = fake.state.lock().unwrap();
        assert_eq!(
            state.pairs,
            vec![("telegram".to_string(), "t0".to_string(), None)]
        );
        assert_eq!(state.upserts[0].status, "awaiting_code");
        assert_eq!(
            state.upserts[0].metadata,
            Some(json!({"accountId": "acc1"}))
        );
        // The broadcast uses the request's accountId, not the result's, as the TypeScript does.
        assert_eq!(state.broadcasts[0].2["accountId"], "default");
        assert_eq!(state.broadcasts[0].2["status"], "awaiting_code");
    }

    #[tokio::test]
    async fn pair_without_result_fields_falls_back_and_omits_optional_keys() {
        let fake = Fake::default();
        fake.state.lock().unwrap().pair_result = json!({});

        let payload = pair(
            &fake,
            &fake,
            &fake,
            "u1",
            &json!({"channel": "whatsapp", "accountId": "bridge"}),
        )
        .await
        .unwrap();

        assert_eq!(payload["status"], "connected");
        assert_eq!(payload["accountId"], "bridge");
        assert!(payload.get("transport").is_none());
        assert!(payload.get("peerName").is_none());
        assert!(payload.get("details").is_none());
        let state = fake.state.lock().unwrap();
        assert_eq!(
            state.upserts[0].metadata,
            Some(json!({"accountId": "bridge"}))
        );
        assert_eq!(
            state.pairs,
            vec![(
                "whatsapp".to_string(),
                String::new(),
                Some("bridge".to_string())
            )]
        );
    }

    #[tokio::test]
    async fn unpair_marks_the_binding_disconnected_and_broadcasts() {
        let fake = Fake::default();
        let payload = unpair(
            &fake,
            &fake,
            &fake,
            "u1",
            &json!({"channel": "slack", "accountId": "ws1"}),
        )
        .await
        .unwrap();

        assert_eq!(payload["ok"], true);
        assert_eq!(payload["accountId"], "ws1");
        assert_eq!(payload["status"], "disconnected");
        let state = fake.state.lock().unwrap();
        assert_eq!(
            state.unpairs,
            vec![("slack".to_string(), Some("ws1".to_string()))]
        );
        assert_eq!(state.upserts[0].status, "disconnected");
        assert_eq!(state.upserts[0].metadata, Some(json!({"accountId": "ws1"})));
        assert_eq!(state.broadcasts[0].2["accountId"], "ws1");
        assert_eq!(state.broadcasts[0].2["status"], "disconnected");
    }
}
