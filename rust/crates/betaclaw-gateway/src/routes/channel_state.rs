//! Channel state route.
//!
//! Port of `app/api/channels/state/route.ts`. Lists every channel with the
//! caller's binding and the static capability flags. `whatsapp` and `imessage`
//! also carry their bridge accounts. Those are read from `channel_credentials`
//! without writing to it: the read side of `listBridgeAccounts` in
//! `src/server/channels/pairing/bridgeAccounts.ts`.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use betaclaw_core::messages_store::{now_iso, ChannelBinding};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::proxy::proxy_to_upstream;
use crate::routes::channel_support::{error_response, failure};
use crate::state::SharedState;

const BRIDGE_CHANNELS: [&str; 2] = ["whatsapp", "imessage"];
const BRIDGE_ACCOUNT_IDS_KEY: &str = "bridge_accounts";
const DEFAULT_BRIDGE_ACCOUNT_ID: &str = "default";
const ACCOUNT_ID_ERROR: &str =
    "Invalid accountId. Use lowercase letters, digits, \"_\" or \"-\", max 63 chars.";

/// `ChannelCapabilities` in `src/server/channels/adapters/types.ts`.
struct Capabilities {
    inbound: bool,
    outbound: bool,
    pairing: bool,
    streaming: bool,
}

/// `CHANNEL_CAPABILITIES` in `src/server/channels/adapters/capabilities.ts`, in
/// the same order the TypeScript route lists them.
const CHANNELS: [(&str, Capabilities); 7] = [
    (
        "webchat",
        Capabilities {
            inbound: true,
            outbound: false,
            pairing: false,
            streaming: true,
        },
    ),
    (
        "agent_room",
        Capabilities {
            inbound: true,
            outbound: false,
            pairing: false,
            streaming: true,
        },
    ),
    (
        "telegram",
        Capabilities {
            inbound: true,
            outbound: true,
            pairing: true,
            streaming: false,
        },
    ),
    (
        "whatsapp",
        Capabilities {
            inbound: true,
            outbound: true,
            pairing: true,
            streaming: false,
        },
    ),
    (
        "discord",
        Capabilities {
            inbound: true,
            outbound: true,
            pairing: true,
            streaming: false,
        },
    ),
    (
        "imessage",
        Capabilities {
            inbound: true,
            outbound: true,
            pairing: true,
            streaming: false,
        },
    ),
    (
        "slack",
        Capabilities {
            inbound: true,
            outbound: true,
            pairing: true,
            streaming: false,
        },
    ),
];

pub fn router() -> Router<SharedState> {
    Router::new().route(
        "/api/channels/state",
        get(channel_state).fallback(proxy_to_upstream),
    )
}

/// `GET /api/channels/state`
async fn channel_state(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let Some(user_id) = user_id_from_headers(&headers) else {
        return unauthorized_response();
    };
    let store = state.messages.lock().await;
    let bindings = match store.list_channel_bindings(user_id.as_str()) {
        Ok(bindings) => bindings,
        Err(error) => return failure(&error),
    };

    let mut channels = Vec::with_capacity(CHANNELS.len());
    for (channel, capabilities) in &CHANNELS {
        let binding = bindings.iter().find(|binding| binding.channel == *channel);
        let mut entry = channel_entry(channel, binding, capabilities);
        if BRIDGE_CHANNELS.contains(channel) {
            match list_bridge_accounts(store.connection(), channel) {
                Ok(accounts) => entry["accounts"] = Value::Array(accounts),
                Err(message) => {
                    return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message);
                }
            }
        }
        channels.push(entry);
    }

    Json(json!({
        "ok": true,
        "channels": channels,
        "generatedAt": now_iso(),
    }))
    .into_response()
}

fn channel_entry(
    channel: &str,
    binding: Option<&ChannelBinding>,
    capabilities: &Capabilities,
) -> Value {
    json!({
        "channel": channel,
        "status": binding.map_or("idle", |binding| binding.status.as_str()),
        "externalPeerId": binding.and_then(|binding| binding.external_peer_id.as_deref()),
        "peerName": binding.and_then(|binding| binding.peer_name.as_deref()),
        "transport": binding.and_then(|binding| binding.transport.as_deref()),
        "lastSeenAt": binding.and_then(|binding| binding.last_seen_at.as_deref()),
        "supportsInbound": capabilities.inbound,
        "supportsOutbound": capabilities.outbound,
        "supportsPairing": capabilities.pairing,
        "supportsStreaming": capabilities.streaming,
    })
}

/// Read-only port of `listBridgeAccounts`. Without the credential table there are
/// no accounts; the TypeScript store creates the table on first use and then
/// returns none as well.
fn list_bridge_accounts(connection: &Connection, channel: &str) -> Result<Vec<Value>, String> {
    if !credentials_table_exists(connection)? {
        return Ok(Vec::new());
    }
    let mut accounts = Vec::new();
    for account_id in bridge_account_ids(connection, channel)? {
        let is_default = account_id == DEFAULT_BRIDGE_ACCOUNT_ID;
        let scoped_status = non_empty(credential(
            connection,
            channel,
            &scoped_key(&account_id, "pairing_status"),
        )?);
        // The default account falls back to the legacy key, unfiltered, as in TypeScript.
        let pairing_status = match scoped_status {
            Some(status) => Some(status),
            None if is_default => credential(connection, channel, "pairing_status")?,
            None => None,
        };
        let peer_name = credential(connection, channel, &scoped_key(&account_id, "peer_name"))?;
        let last_seen_at = credential(
            connection,
            channel,
            &scoped_key(&account_id, "last_seen_at"),
        )?;
        let allow_from = read_allow_from(connection, channel, &account_id, is_default)?;
        accounts.push(json!({
            "accountId": account_id,
            "pairingStatus": pairing_status,
            "peerName": peer_name,
            "lastSeenAt": last_seen_at,
            "allowFrom": allow_from,
        }));
    }
    Ok(accounts)
}

fn bridge_account_ids(connection: &Connection, channel: &str) -> Result<Vec<String>, String> {
    let raw = credential(connection, channel, BRIDGE_ACCOUNT_IDS_KEY)?;
    let ids = parse_account_ids(raw.as_deref())?;
    if !ids.is_empty() {
        return Ok(ids);
    }
    let has_pairing = non_empty(credential(connection, channel, "pairing_status")?).is_some();
    let has_secret = non_empty(credential(connection, channel, "webhook_secret")?).is_some();
    Ok(if has_pairing || has_secret {
        vec![DEFAULT_BRIDGE_ACCOUNT_ID.to_string()]
    } else {
        Vec::new()
    })
}

/// Port of `normalizeAccountIds`: a JSON array, or a comma-separated list when the
/// value is not JSON. An array with an invalid entry falls back to the comma list,
/// as the TypeScript try block does.
fn parse_account_ids(raw: Option<&str>) -> Result<Vec<String>, String> {
    let Some(raw) = raw.filter(|text| !text.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(items)) => {
            let parsed: Result<Vec<String>, String> = items
                .iter()
                .filter_map(Value::as_str)
                .map(normalize_account_id)
                .collect();
            if let Ok(ids) = parsed {
                return Ok(ids);
            }
        }
        Ok(_) => return Ok(Vec::new()),
        Err(_) => {}
    }
    raw.split(',').map(normalize_account_id).collect()
}

/// Port of `normalizeBridgeAccountId`: trimmed and lowercased. An empty value means
/// `default`; anything else must match `^[a-z0-9][a-z0-9_-]{0,62}$`.
fn normalize_account_id(raw: &str) -> Result<String, String> {
    let value = raw.trim().to_lowercase();
    if value.is_empty() {
        return Ok(DEFAULT_BRIDGE_ACCOUNT_ID.to_string());
    }
    let valid = value.len() <= 63
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'_' | b'-'))
        });
    if valid {
        Ok(value)
    } else {
        Err(ACCOUNT_ID_ERROR.to_string())
    }
}

/// Port of `readBridgeAccountAllowFrom`. A scoped list wins; the default account
/// falls back to the legacy `allow_from` key. Entries are trimmed, lowercased and
/// stripped of whitespace, then de-duplicated, keeping the first occurrence.
fn read_allow_from(
    connection: &Connection,
    channel: &str,
    account_id: &str,
    is_default: bool,
) -> Result<Vec<String>, String> {
    let scoped = non_empty(credential(
        connection,
        channel,
        &scoped_key(account_id, "allow_from"),
    )?);
    let raw = match scoped {
        Some(raw) => raw,
        None if is_default => {
            non_empty(credential(connection, channel, "allow_from")?).unwrap_or_default()
        }
        None => String::new(),
    };
    let mut entries: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let entry: String = part
            .trim()
            .to_lowercase()
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .collect();
        if !entry.is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

fn scoped_key(account_id: &str, key: &str) -> String {
    format!("account.{account_id}.{key}")
}

/// JavaScript truthiness for a stored string: an empty value counts as absent.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

fn credentials_table_exists(connection: &Connection) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_credentials'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map(|found| found.is_some())
        .map_err(|error| error.to_string())
}

fn credential(connection: &Connection, channel: &str, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM channel_credentials WHERE channel = ?1 AND key = ?2",
            params![channel, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::test_support::{assert_keys, send, state_in, ScratchDir};
    use crate::state::SharedState;
    use axum::http::Method;
    use betaclaw_core::messages_store::UpsertChannelBindingInput;

    const USER: &str = "user-channels";

    fn entry<'a>(body: &'a Value, channel: &str) -> &'a Value {
        body["channels"]
            .as_array()
            .expect("channels array")
            .iter()
            .find(|entry| entry["channel"] == channel)
            .expect("channel present")
    }

    #[tokio::test]
    async fn lists_every_channel_with_its_capabilities() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);

        let (status, body) =
            send(&state, Method::GET, "/api/channels/state", Some(USER), None).await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["channels", "generatedAt", "ok"]);
        assert_eq!(body["channels"].as_array().expect("array").len(), 7);
        let webchat = entry(&body, "webchat");
        assert_eq!(webchat["status"], "idle");
        assert_eq!(webchat["supportsOutbound"], false);
        assert_eq!(webchat["supportsStreaming"], true);
        assert!(
            webchat.get("accounts").is_none(),
            "only bridges carry accounts"
        );
        let telegram = entry(&body, "telegram");
        assert_eq!(telegram["supportsPairing"], true);
        assert_eq!(telegram["supportsStreaming"], false);
        assert_eq!(entry(&body, "whatsapp")["accounts"], json!([]));
    }

    #[tokio::test]
    async fn reports_the_callers_binding() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        state
            .messages
            .lock()
            .await
            .upsert_channel_binding(&UpsertChannelBindingInput {
                user_id: USER,
                channel: "telegram",
                status: "connected",
                external_peer_id: Some("peer-1"),
                peer_name: Some("Alice"),
                transport: Some("polling"),
                metadata: None,
            })
            .expect("binding");

        let (status, body) =
            send(&state, Method::GET, "/api/channels/state", Some(USER), None).await;

        assert_eq!(status, StatusCode::OK);
        let telegram = entry(&body, "telegram");
        assert_eq!(telegram["status"], "connected");
        assert_eq!(telegram["externalPeerId"], "peer-1");
        assert_eq!(telegram["peerName"], "Alice");
        assert_eq!(telegram["transport"], "polling");
    }

    #[tokio::test]
    async fn reads_whatsapp_bridge_accounts_from_the_credential_table() {
        let scratch = ScratchDir::new();
        let state = state_in(&scratch);
        {
            let store = state.messages.lock().await;
            store
                .connection()
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS channel_credentials (
                        channel TEXT NOT NULL,
                        key TEXT NOT NULL,
                        value TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        PRIMARY KEY (channel, key)
                    );",
                )
                .expect("create credential table");
            let rows = [
                ("bridge_accounts", "[\"default\",\"sales\"]"),
                ("pairing_status", "connected"),
                ("allow_from", "A@b.c"),
                ("account.sales.pairing_status", "pending"),
                ("account.sales.peer_name", "Sales Desk"),
                ("account.sales.allow_from", "+1 555, Foo@x.com,foo@x.com"),
            ];
            for (key, value) in rows {
                store
                    .connection()
                    .execute(
                        "INSERT INTO channel_credentials (channel, key, value, updated_at)
                         VALUES ('whatsapp', ?1, ?2, '2026-10-10T00:00:00.000Z')",
                        params![key, value],
                    )
                    .expect("insert credential");
            }
        }

        let (status, body) =
            send(&state, Method::GET, "/api/channels/state", Some(USER), None).await;

        assert_eq!(status, StatusCode::OK);
        let accounts = entry(&body, "whatsapp")["accounts"]
            .as_array()
            .expect("accounts array")
            .clone();
        assert_eq!(accounts.len(), 2);
        let default = &accounts[0];
        assert_eq!(default["accountId"], "default");
        assert_eq!(default["pairingStatus"], "connected");
        assert_eq!(default["allowFrom"], json!(["a@b.c"]));
        let sales = &accounts[1];
        assert_eq!(sales["accountId"], "sales");
        assert_eq!(sales["pairingStatus"], "pending");
        assert_eq!(sales["peerName"], "Sales Desk");
        assert_eq!(sales["allowFrom"], json!(["+1555", "foo@x.com"]));
        assert_eq!(entry(&body, "imessage")["accounts"], json!([]));
    }

    #[tokio::test]
    async fn without_a_user_the_state_is_unauthorized() {
        let scratch = ScratchDir::new();
        let state: SharedState = state_in(&scratch);

        let (status, body) = send(&state, Method::GET, "/api/channels/state", None, None).await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_keys(&body, &["error", "ok"]);
    }

    #[test]
    fn account_ids_are_normalised_and_validated() {
        assert_eq!(
            normalize_account_id("  Sales_1 "),
            Ok("sales_1".to_string())
        );
        assert_eq!(normalize_account_id(""), Ok("default".to_string()));
        assert!(normalize_account_id("_leading").is_err());
        assert!(normalize_account_id("has space").is_err());
        assert!(normalize_account_id(&"a".repeat(64)).is_err());
    }
}
