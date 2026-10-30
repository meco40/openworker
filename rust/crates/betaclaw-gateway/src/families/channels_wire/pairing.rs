//! Port of `app/api/channels/pair/route.ts`,
//! `app/api/channels/telegram/pairing/confirm/route.ts`,
//! `app/api/channels/telegram/pairing/poll/route.ts` and
//! `app/api/channels/whatsapp/accounts/route.ts`.
//!
//! The pairing flows are the core `ChannelPairing`. These handlers read the
//! request, write the caller's binding (the channel state route reads it back)
//! and shape the answer.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use betaclaw_core::channels::pairing::bridge_accounts::{
    list_bridge_accounts, normalize_bridge_account_id, upsert_bridge_account,
    write_bridge_account_allow_from, BridgeAccountSummary, BridgeAccountUpsert, BridgeChannel,
};
use betaclaw_core::channels::pairing::credentials::ChannelCredentialStore;
use betaclaw_core::channels::pairing::telegram_code::confirm_telegram_pairing_code;
use betaclaw_core::channels::pairing::PairChannelType;
use betaclaw_core::messages_store::{now_iso, UpsertChannelBindingInput};
use chrono::Utc;
use serde_json::{json, Map, Value};

use super::{parse_body, redact_bot_tokens, text_field, Services};
use crate::auth_gate::{unauthorized_response, user_id_from_headers};
use crate::routes::channel_support::{error_response, failure};
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/channels/pair", post(pair).delete(unpair))
        .route(
            "/api/channels/telegram/pairing/confirm",
            post(confirm_telegram),
        )
        .route("/api/channels/telegram/pairing/poll", post(poll_telegram))
        .route(
            "/api/channels/whatsapp/accounts",
            get(list_whatsapp_accounts).put(put_whatsapp_accounts),
        )
}

/// `POST /api/channels/pair`. Works without a user; the binding is written only
/// for a signed-in caller, as `withResolvedUserContext` does.
async fn pair(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let user_id = user_id_from_headers(&headers);
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    let Some(channel) = text_field(&body, "channel") else {
        return error_response(StatusCode::BAD_REQUEST, "channel is required");
    };
    let Some(kind) = PairChannelType::parse(&channel) else {
        return error_response(StatusCode::BAD_REQUEST, "Unsupported channel");
    };
    let token = text_field(&body, "token").unwrap_or_default();
    let requested_account = text_field(&body, "accountId");

    let outcome = match services
        .pairing
        .pair_channel(kind, &token, requested_account.as_deref())
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            let message = redact_bot_tokens(&error.0);
            let status = if message.starts_with("Unsupported channel:") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            return error_response(status, &message);
        }
    };

    let status = outcome
        .status
        .clone()
        .unwrap_or_else(|| "connected".to_string());
    let account_id = outcome
        .account_id
        .clone()
        .or_else(|| requested_account.clone())
        .unwrap_or_else(|| "default".to_string());
    let connected_at = now_iso();

    if let Some(user) = user_id.as_deref() {
        let metadata = (account_id != "default").then(|| json!({ "accountId": account_id }));
        let binding_status = if status == "awaiting_code" {
            "awaiting_code"
        } else {
            "connected"
        };
        let peer_name = (!outcome.peer_name.is_empty()).then_some(outcome.peer_name.as_str());
        let result =
            state
                .messages
                .lock()
                .await
                .upsert_channel_binding(&UpsertChannelBindingInput {
                    user_id: user,
                    channel: &channel,
                    status: binding_status,
                    external_peer_id: None,
                    peer_name,
                    transport: outcome.transport.as_deref(),
                    metadata: metadata.as_ref(),
                });
        if let Err(error) = result {
            return failure(&error);
        }
    }

    let mut answer = json!({
        "ok": true,
        "status": status,
        "transport": outcome.transport,
        "peerName": outcome.peer_name,
        "connectedAt": connected_at,
        "details": outcome.details,
        "accountId": account_id,
    });
    if outcome.transport.is_none() {
        remove_key(&mut answer, "transport");
    }
    Json(answer).into_response()
}

/// `DELETE /api/channels/pair`.
async fn unpair(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let user_id = user_id_from_headers(&headers);
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    let Some(channel) = text_field(&body, "channel") else {
        return error_response(StatusCode::BAD_REQUEST, "channel is required");
    };
    let Some(kind) = PairChannelType::parse(&channel) else {
        return error_response(StatusCode::BAD_REQUEST, "Unsupported channel");
    };
    let requested_account = text_field(&body, "accountId");

    if let Err(error) = services
        .pairing
        .unpair_channel(kind, requested_account.as_deref())
        .await
    {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &redact_bot_tokens(&error.0),
        );
    }

    if let Some(user) = user_id.as_deref() {
        let metadata = requested_account
            .as_deref()
            .map(|account| json!({ "accountId": account }));
        let result =
            state
                .messages
                .lock()
                .await
                .upsert_channel_binding(&UpsertChannelBindingInput {
                    user_id: user,
                    channel: &channel,
                    status: "disconnected",
                    external_peer_id: None,
                    peer_name: None,
                    transport: None,
                    metadata: metadata.as_ref(),
                });
        if let Err(error) = result {
            return failure(&error);
        }
    }

    Json(json!({
        "ok": true,
        "status": "disconnected",
        "channel": channel,
        "accountId": requested_account.unwrap_or_else(|| "default".to_string()),
    }))
    .into_response()
}

/// `POST /api/channels/telegram/pairing/confirm`: the code shown in the chat,
/// entered in the web UI.
async fn confirm_telegram(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let user_id = user_id_from_headers(&headers);
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(message) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message),
    };
    let Some(code) = text_field(&body, "code").filter(|code| !code.trim().is_empty()) else {
        return error_response(StatusCode::BAD_REQUEST, "code is required");
    };

    let chat_id = match confirm_telegram_pairing_code(services.db.as_ref(), &code, Utc::now()) {
        Ok(chat_id) => chat_id,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, &error.0),
    };
    let connected_at = now_iso();

    if let Some(user) = user_id.as_deref() {
        let transport = services
            .db
            .get_credential("telegram", "update_transport")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "webhook".to_string());
        let peer_name = format!("telegram:{chat_id}");
        let result =
            state
                .messages
                .lock()
                .await
                .upsert_channel_binding(&UpsertChannelBindingInput {
                    user_id: user,
                    channel: "telegram",
                    status: "connected",
                    external_peer_id: None,
                    peer_name: Some(peer_name.as_str()),
                    transport: Some(transport.as_str()),
                    metadata: None,
                });
        if let Err(error) = result {
            return failure(&error);
        }
    }

    Json(json!({
        "ok": true,
        "status": "connected",
        "chatId": chat_id,
        "connectedAt": connected_at,
    }))
    .into_response()
}

/// `POST /api/channels/telegram/pairing/poll`. In polling mode it starts the
/// background poller and never calls `getUpdates` itself: two concurrent calls
/// on one token make Telegram answer 409.
async fn poll_telegram(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let transport = services
        .db
        .get_credential("telegram", "update_transport")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "webhook".to_string());
    if transport != "polling" {
        return Json(json!({
            "ok": true,
            "mode": transport,
            "processed": 0,
            "codeIssued": false,
        }))
        .into_response();
    }

    let token = services
        .db
        .get_credential("telegram", "bot_token")
        .filter(|value| !value.is_empty())
        .or_else(|| {
            services
                .env
                .get("TELEGRAM_BOT_TOKEN")
                .filter(|value| !value.is_empty())
        });
    if token.is_none() {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Telegram bot token not configured.",
        );
    }

    if !services.pairing.is_telegram_polling_active() {
        services.pairing.start_telegram_polling().await;
    }
    Json(json!({
        "ok": true,
        "mode": "polling",
        "processed": 0,
        "codeIssued": false,
        "delegated": true,
    }))
    .into_response()
}

/// `GET /api/channels/whatsapp/accounts`.
async fn list_whatsapp_accounts(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    match list_bridge_accounts(services.db.as_ref(), BridgeChannel::WhatsApp) {
        Ok(accounts) => Json(json!({
            "ok": true,
            "accounts": accounts.iter().map(account_json).collect::<Vec<Value>>(),
            "generatedAt": now_iso(),
        }))
        .into_response(),
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error.0),
    }
}

/// `PUT /api/channels/whatsapp/accounts`: creates or updates one account and its
/// allow list.
async fn put_whatsapp_accounts(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if user_id_from_headers(&headers).is_none() {
        return unauthorized_response();
    }
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(message) => return error_response(StatusCode::BAD_REQUEST, &message),
    };
    match save_whatsapp_account(&services, &body) {
        Ok(answer) => Json(answer).into_response(),
        Err(message) => error_response(StatusCode::BAD_REQUEST, &message),
    }
}

fn save_whatsapp_account(services: &Services, body: &Map<String, Value>) -> Result<Value, String> {
    let store = services.db.as_ref();
    let account_id = normalize_bridge_account_id(text_field(body, "accountId").as_deref())
        .map_err(|error| error.0)?;
    upsert_bridge_account(
        store,
        BridgeChannel::WhatsApp,
        &BridgeAccountUpsert {
            account_id: Some(account_id.clone()),
            ..BridgeAccountUpsert::default()
        },
        Utc::now(),
    )
    .map_err(|error| error.0)?;

    let allow_from = parse_allow_from(body.get("allowFrom"));
    let normalized =
        write_bridge_account_allow_from(store, BridgeChannel::WhatsApp, &account_id, &allow_from)
            .map_err(|error| error.0)?;
    let account = list_bridge_accounts(store, BridgeChannel::WhatsApp)
        .map_err(|error| error.0)?
        .into_iter()
        .find(|entry| entry.account_id == account_id);

    Ok(json!({
        "ok": true,
        "accountId": account_id,
        "allowFrom": normalized,
        "account": account.as_ref().map(account_json),
    }))
}

/// `parseAllowFromInput`: an array of entries, or a string split on commas and
/// newlines. Anything else is an empty list.
fn parse_allow_from(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(entries)) => entries
            .iter()
            .map(|entry| match entry {
                Value::String(text) => text.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            })
            .collect(),
        Some(Value::String(text)) => text
            .split([',', '\n'])
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn account_json(account: &BridgeAccountSummary) -> Value {
    json!({
        "accountId": account.account_id,
        "pairingStatus": account.pairing_status,
        "peerName": account.peer_name,
        "lastSeenAt": account.last_seen_at,
        "allowFrom": account.allow_from,
    })
}

fn remove_key(value: &mut Value, key: &str) {
    if let Some(object) = value.as_object_mut() {
        object.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Method;
    use betaclaw_core::channels::pairing::telegram_code::{
        ensure_telegram_pairing_code, EnsureCode,
    };

    use super::*;
    use crate::families::channels_wire::test_support::{assert_keys, harness, ScratchDir, USER};

    #[tokio::test]
    async fn pairing_needs_a_known_channel() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);

        let (status, body) = h
            .send(Method::POST, "/api/channels/pair", Some(USER), Some("{}"))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_keys(&body, &["error", "ok"]);
        assert_eq!(body["error"], "channel is required");

        let (status, body) = h
            .send(
                Method::POST,
                "/api/channels/pair",
                Some(USER),
                Some("{\"channel\":\"sms\"}"),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Unsupported channel");
    }

    #[tokio::test]
    async fn a_refused_token_is_a_server_error_with_its_message() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);

        let (status, body) = h
            .send(
                Method::POST,
                "/api/channels/pair",
                Some(USER),
                Some("{\"channel\":\"telegram\",\"token\":\"\"}"),
            )
            .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"], "Telegram token is required.");
    }

    #[tokio::test]
    async fn unpairing_discord_clears_its_credentials_and_marks_the_binding() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        h.services.db.set_credential("discord", "bot_token", "t");

        let (status, body) = h
            .send(
                Method::DELETE,
                "/api/channels/pair",
                Some(USER),
                Some("{\"channel\":\"discord\"}"),
            )
            .await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["accountId", "channel", "ok", "status"]);
        assert_eq!(body["status"], "disconnected");
        assert_eq!(body["accountId"], "default");
        assert_eq!(h.services.db.get_credential("discord", "bot_token"), None);
        let bindings = h
            .state
            .messages
            .lock()
            .await
            .list_channel_bindings(USER)
            .expect("bindings");
        let discord = bindings
            .iter()
            .find(|binding| binding.channel == "discord")
            .expect("discord binding");
        assert_eq!(discord.status, "disconnected");
    }

    #[tokio::test]
    async fn a_telegram_code_confirms_the_pending_chat() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        let issued = ensure_telegram_pairing_code(h.services.db.as_ref(), "4242", Utc::now())
            .expect("pairing code");
        let code = match issued {
            EnsureCode::Issued { code, .. } => code,
            _ => panic!("a code is issued for a new chat"),
        };

        let payload = format!("{{\"code\":\"{code}\"}}");
        let (status, body) = h
            .send(
                Method::POST,
                "/api/channels/telegram/pairing/confirm",
                Some(USER),
                Some(&payload),
            )
            .await;

        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["chatId", "connectedAt", "ok", "status"]);
        assert_eq!(body["chatId"], "4242");
        let bindings = h
            .state
            .messages
            .lock()
            .await
            .list_channel_bindings(USER)
            .expect("bindings");
        assert!(bindings
            .iter()
            .any(|binding| binding.channel == "telegram" && binding.status == "connected"));
    }

    #[tokio::test]
    async fn confirming_without_a_pending_request_is_refused() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);

        let (status, body) = h
            .send(
                Method::POST,
                "/api/channels/telegram/pairing/confirm",
                Some(USER),
                Some("{\"code\":\"123456\"}"),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "No active Telegram pairing request.");

        let (status, body) = h
            .send(
                Method::POST,
                "/api/channels/telegram/pairing/confirm",
                Some(USER),
                Some("{\"code\":\"  \"}"),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "code is required");
    }

    #[tokio::test]
    async fn polling_needs_a_user_and_reports_the_webhook_mode() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        let path = "/api/channels/telegram/pairing/poll";

        let (status, _) = h.send(Method::POST, path, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, body) = h.send(Method::POST, path, Some(USER), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["mode"], "webhook");
        assert_eq!(body["processed"], 0);

        h.services
            .db
            .set_credential("telegram", "update_transport", "polling");
        let (status, body) = h.send(Method::POST, path, Some(USER), None).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"], "Telegram bot token not configured.");
    }

    #[tokio::test]
    async fn whatsapp_accounts_are_saved_and_listed_with_their_allow_list() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        let path = "/api/channels/whatsapp/accounts";

        let (status, _) = h.send(Method::GET, path, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, body) = h
            .send(
                Method::PUT,
                path,
                Some(USER),
                Some("{\"accountId\":\"Sales\",\"allowFrom\":\"A@b.c, +1 555,a@b.c\"}"),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["accountId"], "sales");
        assert_eq!(body["allowFrom"], json!(["a@b.c", "+1555"]));
        assert_eq!(body["account"]["accountId"], "sales");

        let (status, body) = h.send(Method::GET, path, Some(USER), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["accounts", "generatedAt", "ok"]);
        let accounts = body["accounts"].as_array().expect("accounts");
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["allowFrom"], json!(["a@b.c", "+1555"]));
    }

    #[tokio::test]
    async fn an_invalid_whatsapp_account_id_is_a_bad_request() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);

        let (status, body) = h
            .send(
                Method::PUT,
                "/api/channels/whatsapp/accounts",
                Some(USER),
                Some("{\"accountId\":\"_bad id\"}"),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["ok"], false);
    }

    #[test]
    fn allow_from_accepts_an_array_or_a_separated_string() {
        assert_eq!(
            parse_allow_from(Some(&json!(["x", 5]))),
            vec!["x".to_string(), "5".to_string()]
        );
        assert_eq!(
            parse_allow_from(Some(&json!("a, b\nc"))),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
        assert!(parse_allow_from(Some(&json!(7))).is_empty());
    }
}
