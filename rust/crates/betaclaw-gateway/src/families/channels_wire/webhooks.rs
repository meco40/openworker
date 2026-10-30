//! Port of `app/api/channels/telegram/webhook/route.ts`,
//! `app/api/channels/telegram/bots/[botId]/webhook/route.ts`,
//! `app/api/channels/slack/webhook/route.ts` and
//! `app/api/channels/whatsapp/webhook/route.ts`.
//!
//! The providers retry on any answer other than 200, so these routes answer 200
//! after a failure as the TypeScript routes do. A rejected secret is the one
//! answer that is not 200 (403).

use std::collections::HashMap;
use std::sync::{Arc, PoisonError};

use axum::body::Bytes;
use axum::extract::{Extension, Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use betaclaw_core::channels::adapters::telegram::types::TelegramUpdate;
use betaclaw_core::channels::messages::service::inbound::handle_inbound::{
    InboundOptions, InboundParams,
};
use betaclaw_core::channels::pairing::bridge_accounts::{
    read_bridge_account_allow_from, resolve_bridge_account_id_from_request,
    resolve_bridge_account_secret, scope_bridge_external_chat_id, upsert_bridge_account,
    BridgeAccountUpsert, BridgeChannel,
};
use betaclaw_core::channels::pairing::credentials::{ChannelCredentialStore, ChannelEnv};
use betaclaw_core::channels::pairing::telegram_inbound::TelegramBotContext;
use betaclaw_core::messages_store::types::ChannelType;
use betaclaw_core::model_hub::http::{HttpRequest, HttpTransport};
use betaclaw_core::net_guard::ssrf_guard::{
    fetch_with_ssrf_guard, parse_http_url, Host, SystemResolver,
};
use chrono::Utc;
use serde_json::{json, Value};

use super::attachments::{metadata_for, IncomingAttachment, MAX_ATTACHMENT_BYTES};
use super::webhook_auth::{verify_shared_secret, verify_telegram_webhook};
use super::{forbidden, ok_response, redact_bot_tokens, Services};
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/channels/telegram/webhook", post(telegram_webhook))
        .route(
            "/api/channels/telegram/bots/{botId}/webhook",
            post(telegram_bot_webhook),
        )
        .route("/api/channels/slack/webhook", post(slack_webhook))
        .route("/api/channels/whatsapp/webhook", post(whatsapp_webhook))
        .route(
            "/api/webhooks/agent-completion",
            axum::routing::get(agent_completion_get).post(agent_completion_post),
        )
}

/// `POST /api/channels/telegram/webhook`.
async fn telegram_webhook(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let secret = services
        .db
        .get_credential("telegram", "webhook_secret")
        .filter(|value| !value.is_empty())
        .or_else(|| services.env.get("TELEGRAM_WEBHOOK_SECRET"))
        .unwrap_or_default();
    if !verify_telegram_webhook(&headers, &secret, &services.env) {
        return forbidden();
    }

    let update: TelegramUpdate = match serde_json::from_slice(&body) {
        Ok(update) => update,
        Err(error) => {
            tracing::warn!(%error, "Telegram webhook body is not an update");
            return ok_response();
        }
    };
    if update.message.is_none() && update.callback_query.is_none() {
        return ok_response();
    }
    if let Err(error) = services
        .pairing
        .process_telegram_update(&update, None)
        .await
    {
        tracing::error!(error = %redact_bot_tokens(&error.0), "Telegram webhook error");
    }
    ok_response()
}

/// `POST /api/channels/telegram/bots/{botId}/webhook`: a persona-bound bot. The
/// bot must exist and be active, and its own secret is checked.
async fn telegram_bot_webhook(
    Extension(services): Extension<Arc<Services>>,
    Path(bot_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let lookup = services
        .bots
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get_bot(&bot_id);
    let bot = match lookup {
        Ok(Some(bot)) if bot.active => bot,
        Ok(_) => return ok_response(),
        Err(error) => {
            tracing::error!(%error, "Persona bot lookup failed");
            return ok_response();
        }
    };
    if !verify_telegram_webhook(&headers, &bot.webhook_secret, &services.env) {
        return forbidden();
    }

    let update: TelegramUpdate = match serde_json::from_slice(&body) {
        Ok(update) => update,
        Err(error) => {
            tracing::warn!(%error, "Persona bot webhook body is not an update");
            return ok_response();
        }
    };
    if update.message.is_none() && update.callback_query.is_none() {
        return ok_response();
    }
    let context = TelegramBotContext {
        bot_id: bot.bot_id.clone(),
        persona_id: bot.persona_id.clone(),
        token: bot.token.clone(),
    };
    if let Err(error) = services
        .pairing
        .process_telegram_update(&update, Some(&context))
        .await
    {
        tracing::error!(error = %redact_bot_tokens(&error.0), "Persona bot webhook error");
    }
    ok_response()
}

/// `POST /api/channels/slack/webhook`. The URL verification answers the challenge;
/// a plain message is dispatched, bot messages and empty events are ignored.
async fn slack_webhook(
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let secret = services.env.get("SLACK_WEBHOOK_SECRET").unwrap_or_default();
    if !verify_shared_secret(&headers, &secret, &services.env) {
        return forbidden();
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return ok_response();
    };

    let kind = payload.get("type").and_then(Value::as_str);
    if kind == Some("url_verification") {
        if let Some(challenge) = payload.get("challenge").and_then(Value::as_str) {
            if !challenge.is_empty() {
                return Json(json!({ "challenge": challenge })).into_response();
            }
        }
    }

    let Some(event) = payload.get("event") else {
        return ok_response();
    };
    let event_text = |key: &str| event.get(key).and_then(Value::as_str);
    if kind != Some("event_callback")
        || event_text("type") != Some("message")
        || event_text("subtype") == Some("bot_message")
    {
        return ok_response();
    }
    let Some(channel) = event_text("channel").filter(|value| !value.is_empty()) else {
        return ok_response();
    };
    let Some(text) = event_text("text").filter(|value| !value.trim().is_empty()) else {
        return ok_response();
    };
    let sender = event_text("user")
        .filter(|value| !value.is_empty())
        .unwrap_or("Slack User");

    let params = InboundParams {
        platform: ChannelType::Slack,
        external_chat_id: channel.to_string(),
        content: text.to_string(),
        sender_name: Some(sender.to_string()),
        external_msg_id: event_text("ts").map(str::to_string),
        user_id: None,
        client_message_id: None,
        attachment_metadata: None,
        on_stream_delta: None,
        opts: InboundOptions::default(),
    };
    if let Err(error) = services.inbound.handle_inbound(params).await {
        tracing::error!(error = %error, "Slack webhook dispatch failed");
    }
    ok_response()
}

/// `POST /api/channels/whatsapp/webhook`: a bridge message. The account comes from
/// the body, the `x-betaclaw-account-id` header or the `accountId` query value, in
/// that order. Its secret and allow list decide whether the message is taken.
async fn whatsapp_webhook(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return ok_response();
    };
    let body_account = payload
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let header_account = headers
        .get("x-betaclaw-account-id")
        .and_then(|value| value.to_str().ok());
    let query_account = query.get("accountId").map(String::as_str);
    let Ok(account) =
        resolve_bridge_account_id_from_request(body_account, header_account, query_account)
    else {
        return ok_response();
    };

    let Ok(secret) = resolve_bridge_account_secret(
        services.db.as_ref(),
        &services.env,
        BridgeChannel::WhatsApp,
        Some(account.as_str()),
    ) else {
        return ok_response();
    };
    if !verify_shared_secret(&headers, &secret, &services.env) {
        return forbidden();
    }

    if let Err(error) = ingest_whatsapp(&state, &services, &payload, &account).await {
        tracing::error!(error = %error, "WhatsApp webhook dispatch failed");
    }
    ok_response()
}

/// The part of the WhatsApp webhook that follows the secret check. Returns early,
/// without touching the account, for a message that is not taken.
async fn ingest_whatsapp(
    state: &SharedState,
    services: &Services,
    payload: &Value,
    account: &str,
) -> Result<(), String> {
    let Some(envelope) = normalize_whatsapp(payload) else {
        return Ok(());
    };
    let allow_from = resolve_allow_from(services, account)?;
    let sender = non_empty_text(payload, "from").unwrap_or_else(|| envelope.chat_id.clone());
    if !is_sender_allowed(&services.env, &sender, &allow_from) {
        return Ok(());
    }

    let scoped_chat =
        scope_bridge_external_chat_id(account, &envelope.chat_id).map_err(|error| error.0)?;
    let dedupe_id = envelope
        .message_id
        .clone()
        .unwrap_or_else(|| fallback_message_id(payload, account));

    let conversation = services
        .db
        .get_or_create_conversation(ChannelType::WhatsApp.as_str(), &scoped_chat)
        .map_err(|error| error.to_string())?;
    let persona_slug = match conversation.persona_id.as_deref() {
        Some(persona_id) => state
            .personas
            .lock()
            .await
            .get_persona(persona_id)
            .map_err(|error| error.to_string())?
            .map(|persona| persona.slug),
        None => None,
    };

    let mut stored = Vec::new();
    for entry in attachment_entries(payload) {
        let name = text_of(entry, "name").unwrap_or("attachment").to_string();
        let incoming = match text_of(entry, "dataUrl").filter(|value| !value.trim().is_empty()) {
            Some(data_url) => IncomingAttachment {
                name,
                mime_type: text_of(entry, "type").unwrap_or("").to_string(),
                size: entry_size(entry),
                data_url: data_url.to_string(),
            },
            None => {
                let Some(url) = text_of(entry, "url").filter(|value| !value.trim().is_empty())
                else {
                    continue;
                };
                if !env_flag(&services.env, "WHATSAPP_WEBHOOK_FETCH_MEDIA") {
                    continue;
                }
                match fetch_attachment(
                    services.transport.as_ref(),
                    &services.env,
                    url,
                    text_of(entry, "type"),
                )
                .await
                {
                    Ok(fetched) => IncomingAttachment {
                        name,
                        mime_type: fetched.mime_type,
                        size: fetched.size,
                        data_url: fetched.data_url,
                    },
                    Err(error) => {
                        tracing::warn!(%error, "WhatsApp attachment fetch skipped");
                        continue;
                    }
                }
            }
        };
        let persisted = services.attachments.persist(
            &format!("channel:whatsapp:{account}"),
            &scoped_chat,
            persona_slug.as_deref(),
            &incoming,
        )?;
        stored.push(persisted);
    }

    let params = InboundParams {
        platform: ChannelType::WhatsApp,
        external_chat_id: scoped_chat,
        content: envelope.content,
        sender_name: Some(
            envelope
                .sender_name
                .unwrap_or_else(|| "WhatsApp User".to_string()),
        ),
        external_msg_id: envelope.message_id,
        user_id: None,
        client_message_id: Some(dedupe_id),
        attachment_metadata: metadata_for(&stored),
        on_stream_delta: None,
        opts: InboundOptions::default(),
    };
    services
        .inbound
        .handle_inbound(params)
        .await
        .map_err(|error| error.to_string())?;

    upsert_bridge_account(
        services.db.as_ref(),
        BridgeChannel::WhatsApp,
        &BridgeAccountUpsert {
            account_id: Some(account.to_string()),
            pairing_status: Some("connected".to_string()),
            touch_last_seen: true,
            ..BridgeAccountUpsert::default()
        },
        Utc::now(),
    )
    .map_err(|error| error.0)?;
    Ok(())
}

/// The fields of `normalizeWhatsAppInbound` that the route uses.
struct WhatsAppEnvelope {
    chat_id: String,
    content: String,
    sender_name: Option<String>,
    message_id: Option<String>,
}

/// `normalizeWhatsAppInbound`: the body or text, and the chat or sender. A message
/// without either is not taken.
fn normalize_whatsapp(payload: &Value) -> Option<WhatsAppEnvelope> {
    let content = trimmed_text(payload, "body").or_else(|| trimmed_text(payload, "text"))?;
    let chat_id = trimmed_text(payload, "chatId").or_else(|| trimmed_text(payload, "from"))?;
    Some(WhatsAppEnvelope {
        chat_id,
        content,
        sender_name: non_empty_text(payload, "senderName")
            .or_else(|| non_empty_text(payload, "from")),
        message_id: trimmed_text(payload, "messageId").or_else(|| trimmed_text(payload, "id")),
    })
}

/// The allow list of an account: its own entries, then `WHATSAPP_ALLOW_FROM_<ACCOUNT>`
/// and `WHATSAPP_ALLOW_FROM`. Entries are lowercased and stripped of whitespace.
fn resolve_allow_from(services: &Services, account: &str) -> Result<Vec<String>, String> {
    let stored = read_bridge_account_allow_from(
        services.db.as_ref(),
        BridgeChannel::WhatsApp,
        Some(account),
    )
    .map_err(|error| error.0)?;
    let sanitized: String = account
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    let account_env = services
        .env
        .get(&format!("WHATSAPP_ALLOW_FROM_{sanitized}"))
        .unwrap_or_default();
    let global_env = services.env.get("WHATSAPP_ALLOW_FROM").unwrap_or_default();

    let mut entries: Vec<String> = Vec::new();
    let from_env = [account_env.as_str(), global_env.as_str()].join(",");
    for entry in stored
        .into_iter()
        .chain(from_env.split(',').map(normalize_sender))
    {
        if !entry.is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// `isSenderAllowed`. With an empty list every sender is allowed outside
/// production, or in production with `ALLOW_OPEN_WHATSAPP_INBOUND=true`.
fn is_sender_allowed(env: &ChannelEnv, sender: &str, allow_from: &[String]) -> bool {
    if allow_from.is_empty() {
        return env.get("NODE_ENV").as_deref() != Some("production")
            || env.get("ALLOW_OPEN_WHATSAPP_INBOUND").as_deref() == Some("true");
    }
    let normalized = normalize_sender(sender);
    !normalized.is_empty() && allow_from.contains(&normalized)
}

/// `normalizeSender`: trimmed, lowercased, without any whitespace.
fn normalize_sender(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect()
}

/// `buildFallbackMessageId`: `wa-auto-` plus the SHA-1 of the seed, as in TypeScript,
/// so a redelivery gets the same id in both runtimes.
fn fallback_message_id(payload: &Value, account: &str) -> String {
    let chat = text_of(payload, "chatId")
        .or_else(|| text_of(payload, "from"))
        .unwrap_or("");
    let timestamp = match payload.get("timestamp") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number_text(number),
        _ => String::new(),
    };
    let seed = [
        account,
        chat,
        text_of(payload, "body").unwrap_or(""),
        timestamp.as_str(),
    ]
    .join("|");
    format!("wa-auto-{}", sha1_hex(seed.as_bytes()))
}

/// `String(value || '')` for a JSON number: zero reads as absent, and an integral
/// value has no decimal point.
fn number_text(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(0.0) => String::new(),
        Some(value) if value.fract() == 0.0 && value.abs() < 1e21 => {
            format!("{}", value as i128)
        }
        Some(value) => value.to_string(),
        None => String::new(),
    }
}

/// SHA-1 of `data` as lowercase hex. The gateway has no SHA-1 crate, and the
/// workspace may not gain one, so the digest is computed here (FIPS 180-4).
fn sha1_hex(data: &[u8]) -> String {
    let mut state: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let mut message = data.to_vec();
    let bit_length = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_be_bytes());

    for block in message.chunks_exact(64) {
        let mut words = [0u32; 80];
        for (index, word) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = state;
        for (index, word) in words.iter().enumerate() {
            let (mix, constant) = match index {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(mix)
                .wrapping_add(e)
                .wrapping_add(constant)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e]) {
            *slot = slot.wrapping_add(value);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

/// A remote attachment, read through the SSRF guard.
struct FetchedAttachment {
    data_url: String,
    mime_type: String,
    size: u64,
}

/// `fetchAttachmentDataUrl`. The host must be listed in
/// `WHATSAPP_WEBHOOK_MEDIA_ALLOWED_HOSTS`. The guard refuses private addresses and
/// redirects, and the body is capped at `MAX_ATTACHMENT_BYTES`. The caller skips the
/// attachment on any error.
async fn fetch_attachment(
    transport: &dyn HttpTransport,
    env: &ChannelEnv,
    url: &str,
    declared_type: Option<&str>,
) -> Result<FetchedAttachment, String> {
    let parsed = parse_http_url(url).map_err(|error| error.to_string())?;
    let allowed: Vec<String> = env
        .get("WHATSAPP_WEBHOOK_MEDIA_ALLOWED_HOSTS")
        .unwrap_or_default()
        .split(',')
        .map(|entry| entry.trim().to_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect();
    if allowed.is_empty() {
        return Err(
            "Remote attachment fetching requires WHATSAPP_WEBHOOK_MEDIA_ALLOWED_HOSTS.".to_string(),
        );
    }
    let hostname = host_text(&parsed.host);
    if !allowed.contains(&hostname) {
        return Err(format!("Attachment host is not allowed: {hostname}"));
    }

    let timeout_ms = env
        .get("WHATSAPP_WEBHOOK_MEDIA_TIMEOUT_MS")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(5_000);
    let request = HttpRequest::get(url)
        .timeout_ms(timeout_ms)
        .max_body_bytes(MAX_ATTACHMENT_BYTES);
    let guarded = fetch_with_ssrf_guard(transport, &SystemResolver, request, 0)
        .await
        .map_err(|error| error.to_string())?;
    let response = guarded.response;
    if !response.is_ok() {
        return Err(format!(
            "Attachment fetch failed with status {}.",
            response.status.as_u16()
        ));
    }
    if response.body_bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Attachment is too large (max {MAX_ATTACHMENT_BYTES} bytes)."
        ));
    }

    let mime_type = declared_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            response
                .header("content-type")
                .split(';')
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("application/octet-stream")
        .to_string();
    let size = response.body_bytes.len() as u64;
    let data_url = format!(
        "data:{mime_type};base64,{}",
        STANDARD.encode(&response.body_bytes)
    );
    Ok(FetchedAttachment {
        data_url,
        mime_type,
        size,
    })
}

/// The hostname as `URL.hostname` prints it: IPv6 in brackets.
fn host_text(host: &Host) -> String {
    match host {
        Host::Domain(name) => name.clone(),
        Host::Ipv4(address) => address.to_string(),
        Host::Ipv6(address) => format!("[{address}]"),
    }
}

/// The declared size of an attachment entry: a finite, non-negative number, floored.
fn entry_size(entry: &Value) -> u64 {
    entry
        .get("size")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map_or(0, |value| value.max(0.0) as u64)
}

/// `attachments` followed by `attachment`, the entries that are objects.
fn attachment_entries(payload: &Value) -> Vec<&Value> {
    let mut entries: Vec<&Value> = payload
        .get("attachments")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter(|item| item.is_object()).collect())
        .unwrap_or_default();
    if let Some(single) = payload.get("attachment").filter(|item| item.is_object()) {
        entries.push(single);
    }
    entries
}

fn env_flag(env: &ChannelEnv, name: &str) -> bool {
    env.get(name).as_deref() == Some("true")
}

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn trimmed_text(value: &Value, key: &str) -> Option<String> {
    text_of(value, key)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn non_empty_text(value: &Value, key: &str) -> Option<String> {
    text_of(value, key).map(str::to_string)
}

/// `GET /api/webhooks/agent-completion` (`app/api/webhooks/agent-completion/route.ts:219-224`).
async fn agent_completion_get() -> Response {
    Json(json!({
        "status": "active",
        "endpoint": "/api/webhooks/agent-completion",
    }))
    .into_response()
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut block = [0u8; 64];
    if key.len() > 64 {
        let hashed = Sha256::digest(key);
        block[..32].copy_from_slice(&hashed);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= block[i];
        opad[i] ^= block[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    let result = outer.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

fn verify_agent_completion_signature(signature: &str, raw_body: &[u8], env: &ChannelEnv) -> bool {
    use subtle::ConstantTimeEq;
    let secret = env.get("WEBHOOK_SECRET").unwrap_or_default();
    if secret.is_empty() {
        return super::webhook_auth::allow_insecure_fallback(env);
    }
    if signature.len() != 64 || !signature.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let mut received = [0u8; 32];
    for (i, chunk) in signature.as_bytes().chunks_exact(2).enumerate() {
        let hex_str = std::str::from_utf8(chunk).unwrap_or("");
        let Ok(byte) = u8::from_str_radix(hex_str, 16) else {
            return false;
        };
        received[i] = byte;
    }
    let expected = hmac_sha256(secret.as_bytes(), raw_body);
    bool::from(received.ct_eq(&expected))
}

/// `POST /api/webhooks/agent-completion` (`app/api/webhooks/agent-completion/route.ts:47-212`).
async fn agent_completion_post(
    State(state): State<SharedState>,
    Extension(services): Extension<Arc<Services>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    use axum::http::StatusCode;
    use rusqlite::OptionalExtension;

    let signature = headers
        .get("x-webhook-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !verify_agent_completion_signature(signature, &body, &services.env) {
        tracing::warn!("[WEBHOOK] Invalid signature attempt");
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Unauthorized" })),
        )
            .into_response();
    }

    let payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Internal server error" })),
            )
                .into_response();
        }
    };

    let db_path = services
        .env
        .get("DATABASE_PATH")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| state.migrations.paths.mission_control.clone());
    let Ok(conn) = rusqlite::Connection::open(&db_path) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Internal server error" })),
        )
            .into_response();
    };
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    if let Some(task_id) = non_empty_text(&payload, "task_id") {
        let row: Option<(String, String, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT t.id, t.status, t.assigned_agent_id, a.name as assigned_agent_name
                 FROM tasks t
                 LEFT JOIN agents a ON t.assigned_agent_id = a.id
                 WHERE t.id = ?1",
                [&task_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .unwrap_or(None);

        let Some((id, status, assigned_agent_id, assigned_agent_name)) = row else {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Task not found" })),
            )
                .into_response();
        };

        if !matches!(status.as_str(), "testing" | "review" | "done") {
            let _ = conn.execute(
                "UPDATE tasks SET status = 'testing', updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, id],
            );
        }

        let summary =
            non_empty_text(&payload, "summary").unwrap_or_else(|| "Task finished".to_string());
        let agent_label = assigned_agent_name.unwrap_or_else(|| "undefined".to_string());
        let _ = conn.execute(
            "INSERT INTO events (id, type, agent_id, task_id, message, created_at)
             VALUES (?1, 'task_completed', ?2, ?3, ?4, ?5)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                assigned_agent_id,
                id,
                format!("{agent_label} completed: {summary}"),
                now,
            ],
        );

        if let Some(agent_id) = assigned_agent_id {
            let _ = conn.execute(
                "UPDATE agents SET status = 'standby', updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, agent_id],
            );
        }

        return Json(json!({
            "success": true,
            "task_id": id,
            "new_status": "testing",
            "message": "Task moved to testing for automated verification",
        }))
        .into_response();
    }

    if let (Some(session_id), Some(message)) = (
        non_empty_text(&payload, "session_id"),
        non_empty_text(&payload, "message"),
    ) {
        let lower = message.to_ascii_lowercase();
        let Some(pos) = lower.find("task_complete:") else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "Invalid completion message format. Expected: TASK_COMPLETE: [summary]"
                })),
            )
                .into_response();
        };
        let summary = message[pos + "task_complete:".len()..].trim().to_string();
        if summary.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "Invalid completion message format. Expected: TASK_COMPLETE: [summary]"
                })),
            )
                .into_response();
        }

        let agent_id: Option<Option<String>> = conn
            .query_row(
                "SELECT agent_id FROM betaclaw_sessions WHERE betaclaw_session_id = ?1 AND status = 'active'",
                [&session_id],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);

        let Some(agent_id) = agent_id else {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Session not found or inactive" })),
            )
                .into_response();
        };

        let task: Option<(String, String, Option<String>)> = conn
            .query_row(
                "SELECT t.id, t.status, a.name as assigned_agent_name
                 FROM tasks t
                 LEFT JOIN agents a ON t.assigned_agent_id = a.id
                 WHERE t.assigned_agent_id = ?1
                   AND t.status IN ('assigned', 'in_progress')
                 ORDER BY t.updated_at DESC
                 LIMIT 1",
                rusqlite::params![agent_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .unwrap_or(None);

        let Some((task_id, status, assigned_agent_name)) = task else {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "No active task found for this agent" })),
            )
                .into_response();
        };

        if !matches!(status.as_str(), "testing" | "review" | "done") {
            let _ = conn.execute(
                "UPDATE tasks SET status = 'testing', updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, task_id],
            );
        }

        let agent_label = assigned_agent_name.unwrap_or_else(|| "undefined".to_string());
        let _ = conn.execute(
            "INSERT INTO events (id, type, agent_id, task_id, message, created_at)
             VALUES (?1, 'task_completed', ?2, ?3, ?4, ?5)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                agent_id,
                task_id,
                format!("{agent_label} completed: {summary}"),
                now,
            ],
        );

        let _ = conn.execute(
            "UPDATE agents SET status = 'standby', updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, agent_id],
        );

        return Json(json!({
            "success": true,
            "task_id": task_id,
            "agent_id": agent_id,
            "summary": summary,
            "new_status": "testing",
            "message": "Task moved to testing for automated verification",
        }))
        .into_response();
    }

    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "error": "Invalid payload. Provide either task_id or session_id + message"
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, StatusCode};

    use super::*;
    use crate::families::channels_wire::test_support::{
        assert_keys, harness, harness_on, harness_with, telegram_ok, FakeInbound, Harness,
        ScratchDir, ScriptedHttp,
    };
    use axum::http::{HeaderMap, HeaderValue};
    use betaclaw_core::model_hub::http::{HttpError, HttpResponse};

    const TELEGRAM_HEADER: &str = "x-telegram-bot-api-secret-token";

    #[test]
    fn a_whatsapp_message_needs_text_and_a_chat() {
        assert!(normalize_whatsapp(&json!({"from": "+49", "body": "  "})).is_none());
        let envelope = normalize_whatsapp(&json!({
            "from": "+49 123", "body": " hi ", "messageId": "m1", "senderName": "Ann"
        }))
        .expect("taken");
        assert_eq!(envelope.chat_id, "+49 123");
        assert_eq!(envelope.content, "hi");
        assert_eq!(envelope.message_id.as_deref(), Some("m1"));
        assert_eq!(envelope.sender_name.as_deref(), Some("Ann"));
    }

    #[test]
    fn senders_are_normalised_before_the_allow_list_check() {
        assert_eq!(normalize_sender(" +49 123 "), "+49123");
        let env = betaclaw_core::channels::pairing::credentials::ChannelEnv::new();
        let allowed = vec!["+49123".to_string()];
        assert!(is_sender_allowed(&env, "+49 123", &allowed));
        assert!(!is_sender_allowed(&env, "+1", &allowed));
        assert!(!is_sender_allowed(&env, "", &allowed));
    }

    #[test]
    fn the_fallback_id_is_stable_for_one_message() {
        let payload = json!({"chatId": "c", "body": "b", "timestamp": 5});
        assert_eq!(
            fallback_message_id(&payload, "default"),
            fallback_message_id(&payload, "default")
        );
        assert!(fallback_message_id(&payload, "default").starts_with("wa-auto-"));
    }

    #[tokio::test]
    async fn a_telegram_webhook_without_any_secret_is_forbidden() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);

        let (status, body) = h
            .send_with_headers(
                Method::POST,
                "/api/channels/telegram/webhook",
                &[],
                Some("{\"update_id\":1}"),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "Forbidden");
    }

    #[tokio::test]
    async fn a_telegram_webhook_with_the_wrong_secret_is_forbidden() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        h.services.env.set("TELEGRAM_WEBHOOK_SECRET", "s3cret");

        let (status, _, _) = h
            .raw(
                Method::POST,
                "/api/channels/telegram/webhook",
                &[(TELEGRAM_HEADER, "guess")],
                Some("{\"update_id\":1}"),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_telegram_webhook_with_the_right_secret_acknowledges_an_empty_update() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        h.services.env.set("TELEGRAM_WEBHOOK_SECRET", "s3cret");

        let (status, body) = h
            .send_with_headers(
                Method::POST,
                "/api/channels/telegram/webhook",
                &[(TELEGRAM_HEADER, "s3cret")],
                Some("{\"update_id\":1}"),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_keys(&body, &["ok"]);
        assert!(h.inbound.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_unknown_persona_bot_is_acknowledged_without_a_secret_check() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);

        let (status, body) = h
            .send(
                Method::POST,
                "/api/channels/telegram/bots/missing/webhook",
                None,
                Some("{\"update_id\":1}"),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn a_persona_bot_checks_its_own_secret_and_dispatches_with_its_persona() {
        use betaclaw_core::personas::telegram_bots::{
            PersonaTelegramTransport, UpsertPersonaTelegramBotInput,
        };
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        h.services
            .bots
            .lock()
            .expect("bots")
            .upsert_bot(&UpsertPersonaTelegramBotInput {
                bot_id: "main".to_string(),
                persona_id: "persona-1".to_string(),
                token: "123:AAsecret".to_string(),
                webhook_secret: "bot-secret".to_string(),
                peer_name: None,
                transport: PersonaTelegramTransport::Webhook,
            })
            .expect("bot stored");
        let path = "/api/channels/telegram/bots/main/webhook";
        let update = "{\"update_id\":2,\"message\":{\"message_id\":9,\"from\":{\"id\":7,\"username\":\"ann\"},\"chat\":{\"id\":555,\"type\":\"private\"},\"text\":\"hallo\"}}";

        let (status, _, _) = h
            .raw(
                Method::POST,
                path,
                &[(TELEGRAM_HEADER, "wrong")],
                Some(update),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, body) = h
            .send_with_headers(
                Method::POST,
                path,
                &[(TELEGRAM_HEADER, "bot-secret")],
                Some(update),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);

        let calls = h.inbound.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].platform, ChannelType::Telegram);
        assert_eq!(calls[0].external_chat_id, "555");
        assert_eq!(calls[0].content, "hallo");
        assert_eq!(calls[0].sender_name.as_deref(), Some("ann"));
        assert_eq!(calls[0].external_msg_id.as_deref(), Some("9"));
        let conversation = h
            .services
            .db
            .get_or_create_conversation(ChannelType::Telegram.as_str(), "555")
            .expect("conversation");
        assert_eq!(conversation.persona_id.as_deref(), Some("persona-1"));
    }

    #[tokio::test]
    async fn a_slack_challenge_is_echoed() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        h.services.env.set("SLACK_WEBHOOK_SECRET", "slack");

        let (status, body) = h
            .send_with_headers(
                Method::POST,
                "/api/channels/slack/webhook",
                &[("x-webhook-secret", "slack")],
                Some("{\"type\":\"url_verification\",\"challenge\":\"abc\"}"),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"challenge": "abc"}));
    }

    #[tokio::test]
    async fn a_slack_message_is_dispatched_and_a_bot_message_is_not() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        h.services.env.set("SLACK_WEBHOOK_SECRET", "slack");
        let path = "/api/channels/slack/webhook";
        let headers = [("x-webhook-secret", "slack")];

        let (status, _, _) = h
            .raw(
                Method::POST,
                path,
                &[("x-webhook-secret", "nope")],
                Some("{}"),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let bot = "{\"type\":\"event_callback\",\"event\":{\"type\":\"message\",\"subtype\":\"bot_message\",\"channel\":\"C1\",\"text\":\"echo\"}}";
        let (status, _) = h
            .send_with_headers(Method::POST, path, &headers, Some(bot))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert!(h.inbound.calls.lock().unwrap().is_empty());

        let message = "{\"type\":\"event_callback\",\"event\":{\"type\":\"message\",\"channel\":\"C1\",\"user\":\"U1\",\"text\":\"hi\",\"ts\":\"1.2\"}}";
        let (status, _) = h
            .send_with_headers(Method::POST, path, &headers, Some(message))
            .await;
        assert_eq!(status, StatusCode::OK);
        let calls = h.inbound.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].platform, ChannelType::Slack);
        assert_eq!(calls[0].external_chat_id, "C1");
        assert_eq!(calls[0].sender_name.as_deref(), Some("U1"));
        assert_eq!(calls[0].external_msg_id.as_deref(), Some("1.2"));
    }

    #[tokio::test]
    async fn a_failed_slack_dispatch_still_answers_ok() {
        let scratch = ScratchDir::new();
        let h = harness_with(
            &scratch,
            FakeInbound {
                fail: true,
                ..FakeInbound::default()
            },
        );
        h.services.env.set("SLACK_WEBHOOK_SECRET", "slack");

        let (status, body) = h
            .send_with_headers(
                Method::POST,
                "/api/channels/slack/webhook",
                &[("x-webhook-secret", "slack")],
                Some("{\"type\":\"event_callback\",\"event\":{\"type\":\"message\",\"channel\":\"C1\",\"text\":\"hi\"}}"),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
    }

    #[tokio::test]
    async fn a_whatsapp_message_from_an_allowed_sender_is_dispatched_and_the_account_marked_connected(
    ) {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);
        h.services.env.set("WHATSAPP_WEBHOOK_SECRET", "bridge");
        h.services.env.set("WHATSAPP_ALLOW_FROM", "+49 123");
        let path = "/api/channels/whatsapp/webhook";
        let headers = [("x-webhook-secret", "bridge")];

        let (status, _, _) = h
            .raw(
                Method::POST,
                path,
                &[("x-webhook-secret", "bridge-wrong")],
                Some("{}"),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let stranger = "{\"from\":\"+1 999\",\"body\":\"spam\",\"messageId\":\"x1\"}";
        let (status, _) = h
            .send_with_headers(Method::POST, path, &headers, Some(stranger))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert!(h.inbound.calls.lock().unwrap().is_empty());

        let allowed =
            "{\"from\":\"+49 123\",\"body\":\"hi\",\"messageId\":\"m1\",\"senderName\":\"Ann\"}";
        let (status, _) = h
            .send_with_headers(Method::POST, path, &headers, Some(allowed))
            .await;
        assert_eq!(status, StatusCode::OK);
        let calls = h.inbound.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].platform, ChannelType::WhatsApp);
        assert_eq!(calls[0].external_chat_id, "+49 123");
        assert_eq!(calls[0].content, "hi");
        assert_eq!(calls[0].client_message_id.as_deref(), Some("m1"));
        assert_eq!(calls[0].sender_name.as_deref(), Some("Ann"));

        let accounts = betaclaw_core::channels::pairing::bridge_accounts::list_bridge_accounts(
            h.services.db.as_ref(),
            BridgeChannel::WhatsApp,
        )
        .expect("accounts");
        assert_eq!(accounts[0].pairing_status.as_deref(), Some("connected"));
    }

    #[tokio::test]
    async fn a_whatsapp_webhook_with_a_non_json_body_is_acknowledged() {
        let scratch = ScratchDir::new();
        let h = harness(&scratch);

        let (status, body) = h
            .send(
                Method::POST,
                "/api/channels/whatsapp/webhook",
                None,
                Some("not json"),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
    }

    #[test]
    fn sha1_matches_the_published_vectors() {
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            sha1_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
    }

    /// The ids were computed by the TypeScript `buildFallbackMessageId` in Node.
    #[test]
    fn the_fallback_id_is_the_typescript_id_of_the_same_message() {
        let payload = json!({"chatId": "+49 123", "body": "hi", "timestamp": 1_700_000_000_000u64});
        assert_eq!(
            fallback_message_id(&payload, "default"),
            "wa-auto-46ff0ef8113bf91fe1acd4a67a669cd5537df312"
        );
        let zero = json!({"chatId": "c", "body": "b", "timestamp": 0});
        assert_eq!(
            fallback_message_id(&zero, "default"),
            "wa-auto-0daeee7a7fea46cc2a921c8aae795dd584fdeb90"
        );
        let text = json!({"from": "+1 9", "body": "ünï", "timestamp": "2026-10-11T10:00:00Z"});
        assert_eq!(
            fallback_message_id(&text, "acc-2"),
            "wa-auto-e1b1456b38bbdac70749cffcdeae31e4f9185262"
        );
    }

    /// A WhatsApp message from an allowed sender, carrying one remote attachment.
    fn remote_media(url: &str) -> String {
        json!({
            "from": "+49 123",
            "body": "hi",
            "messageId": "m9",
            "attachment": {"name": "pic.txt", "type": "text/plain", "url": url},
        })
        .to_string()
    }

    fn whatsapp_harness(
        scratch: &ScratchDir,
        responses: Vec<Result<HttpResponse, HttpError>>,
    ) -> (Harness, Arc<ScriptedHttp>) {
        let transport = ScriptedHttp::with(responses);
        let h = harness_on(scratch, FakeInbound::default(), transport.clone());
        h.services.env.set("WHATSAPP_WEBHOOK_SECRET", "bridge");
        h.services.env.set("WHATSAPP_ALLOW_FROM", "+49 123");
        (h, transport)
    }

    async fn post_whatsapp(h: &Harness, payload: &str) -> StatusCode {
        let (status, _) = h
            .send_with_headers(
                Method::POST,
                "/api/channels/whatsapp/webhook",
                &[("x-webhook-secret", "bridge")],
                Some(payload),
            )
            .await;
        status
    }

    fn served_text(body: &str) -> Result<HttpResponse, HttpError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        Ok(HttpResponse::new(StatusCode::OK, headers, body))
    }

    #[tokio::test]
    async fn a_remote_attachment_is_fetched_through_the_guard_when_enabled() {
        let scratch = ScratchDir::new();
        let (h, transport) = whatsapp_harness(&scratch, vec![served_text("hallo!")]);
        h.services.env.set("WHATSAPP_WEBHOOK_FETCH_MEDIA", "true");
        h.services
            .env
            .set("WHATSAPP_WEBHOOK_MEDIA_ALLOWED_HOSTS", "93.184.216.34");

        let status = post_whatsapp(&h, &remote_media("http://93.184.216.34/pic.txt")).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(transport.urls(), vec!["http://93.184.216.34/pic.txt"]);
        let calls = h.inbound.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        let metadata = calls[0].attachment_metadata.clone().expect("metadata");
        assert_eq!(metadata["attachments"][0]["name"], "pic.txt");
        assert_eq!(metadata["attachments"][0]["size"], 6);
    }

    #[tokio::test]
    async fn a_remote_attachment_on_a_private_address_is_skipped_without_a_request() {
        let scratch = ScratchDir::new();
        let (h, transport) = whatsapp_harness(&scratch, vec![]);
        h.services.env.set("WHATSAPP_WEBHOOK_FETCH_MEDIA", "true");
        h.services
            .env
            .set("WHATSAPP_WEBHOOK_MEDIA_ALLOWED_HOSTS", "127.0.0.1");

        let status = post_whatsapp(&h, &remote_media("http://127.0.0.1/pic.txt")).await;

        assert_eq!(status, StatusCode::OK);
        assert!(transport.requests().is_empty());
        let calls = h.inbound.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1, "the message is still dispatched");
        assert!(calls[0].attachment_metadata.is_none());
    }

    #[tokio::test]
    async fn remote_media_stays_off_unless_the_flag_is_set() {
        let scratch = ScratchDir::new();
        let (h, transport) = whatsapp_harness(&scratch, vec![served_text("x")]);
        h.services
            .env
            .set("WHATSAPP_WEBHOOK_MEDIA_ALLOWED_HOSTS", "93.184.216.34");

        post_whatsapp(&h, &remote_media("http://93.184.216.34/pic.txt")).await;

        assert!(transport.requests().is_empty());
        assert!(h.inbound.calls.lock().unwrap()[0]
            .attachment_metadata
            .is_none());
    }

    #[tokio::test]
    async fn a_chatdelete_from_a_paired_chat_is_run_by_the_gateway() {
        let scratch = ScratchDir::new();
        let transport = ScriptedHttp::with(vec![telegram_ok(77)]);
        let h = harness_on(&scratch, FakeInbound::default(), transport.clone());
        h.services.env.set("TELEGRAM_WEBHOOK_SECRET", "s3cret");
        h.services.env.set("TELEGRAM_BOT_TOKEN", "1:t");
        h.services
            .db
            .set_credential("telegram", "pairing_status", "connected");
        h.services
            .db
            .set_credential("telegram", "paired_chat_id", "555");
        let update = "{\"update_id\":5,\"message\":{\"message_id\":12,\"from\":{\"id\":7,\"username\":\"ann\"},\"chat\":{\"id\":555,\"type\":\"private\"},\"text\":\"/chatdelete\"}}";

        let (status, body) = h
            .send_with_headers(
                Method::POST,
                "/api/channels/telegram/webhook",
                &[(TELEGRAM_HEADER, "s3cret")],
                Some(update),
            )
            .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], true);
        assert!(h.inbound.calls.lock().unwrap().is_empty());
        assert!(transport.urls()[0].ends_with("/sendMessage"));
        assert!(transport.requests()[0]
            .body
            .clone()
            .unwrap_or_default()
            .contains("Nothing to delete."));
    }
}
