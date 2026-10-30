//! Channel family: the pairing, webhook, chat-dispatch and attachment routes that
//! `app/api/channels/**` still serves through the reverse proxy.
//!
//! Ports `src/server/channels/pairing/*`, the attachment and delete parts of
//! `src/server/channels/messages/*`, `src/server/channels/inbound/normalizers.ts`
//! and `src/server/channels/webhookAuth.ts`. The integrator calls [`build`] once and
//! attaches the result as `Extension<Arc<Services>>`.
//!
//! Outside this family: `GET /api/channels/messages` (in `routes::messages`), and
//! `app/api/webhooks/agent-completion` (it works on the tasks tables, which no
//! family serves yet). The chat dispatch is the [`ChannelInbound`] port; see the
//! report for what its production implementation still needs.

pub(crate) mod attachments;
mod chat;
mod inbound;
mod pairing;
pub(crate) mod store;
mod telegram_commands;
#[cfg(test)]
mod test_support;
mod webhook_auth;
mod webhooks;

use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use betaclaw_core::channels::adapters::telegram::api::TelegramApi;
use betaclaw_core::channels::adapters::telegram::outbound::TelegramSender;
use betaclaw_core::channels::pairing::credentials::{ChannelCredentialStore, ChannelEnv};
use betaclaw_core::channels::pairing::telegram_inbound::TelegramInboundPort;
use betaclaw_core::channels::pairing::ChannelPairing;
use betaclaw_core::messages_store::MessageRepositoryError;
use betaclaw_core::model_hub::http::HttpTransport;
use betaclaw_core::personas::telegram_bots::PersonaTelegramBotRegistry;
use serde_json::{json, Map, Value};

use crate::state::SharedState;
use telegram_commands::TelegramCommands;

pub use inbound::ChannelInbound;

/// Everything the channel routes call into. Built once by [`build`].
pub struct Services {
    pub(crate) db: Arc<store::ChannelDb>,
    pub(crate) env: Arc<ChannelEnv>,
    pub pairing: ChannelPairing,
    pub(crate) bots: Mutex<PersonaTelegramBotRegistry>,
    pub(crate) inbound: Arc<dyn ChannelInbound>,
    pub(crate) attachments: Arc<attachments::AttachmentStore>,
    /// The outbound HTTP port. Remote WhatsApp media is fetched through it.
    pub(crate) transport: Arc<dyn HttpTransport>,
    /// The Telegram commands. The bridge holds its own clone; this one exists so the
    /// family's tests can call the commands directly.
    #[cfg(test)]
    pub(crate) telegram: TelegramCommands,
}

/// Start-up failures of [`build`]. `anyhow` is not a dependency of the gateway
/// crate, so the family has its own error type.
#[derive(Debug, thiserror::Error)]
pub enum ServicesError {
    #[error("messages store: {0}")]
    Messages(#[from] MessageRepositoryError),
    #[error("personas database: {0}")]
    Personas(#[from] rusqlite::Error),
    #[error("attachment storage: {0}")]
    Attachments(String),
}

/// Builds the channel services.
///
/// - `state`: the gateway state. Its configuration gives the messages database
///   (`messages_db_path`, which holds `channel_credentials`), the personas database
///   (`personas_db_path`) and the personas root (for persona-scoped attachments).
///   The Telegram commands use its registry and message store for the delete and
///   the inbox events.
/// - `transport`: the outbound HTTP port. Production passes
///   `model_hub_transport::ReqwestTransport`.
/// - `inbound`: the chat dispatch. Production passes the `MessageService`, once
///   its inbound dependencies have production implementations.
///
/// Environment read here: `CHAT_ATTACHMENTS_DIR` (default `.local/uploads/chat`).
pub fn build(
    state: SharedState,
    transport: Arc<dyn HttpTransport>,
    inbound: Arc<dyn ChannelInbound>,
) -> Result<Services, ServicesError> {
    let config = &state.config;
    let env = Arc::new(ChannelEnv::new());
    let db = Arc::new(store::ChannelDb::open(&config.messages_db_path)?);
    let credentials: Arc<dyn ChannelCredentialStore> = db.clone();
    let attachments = Arc::new(
        attachments::AttachmentStore::new(
            env.get("CHAT_ATTACHMENTS_DIR").as_deref(),
            &config.personas_root_path,
        )
        .map_err(ServicesError::Attachments)?,
    );
    let sender = TelegramSender::new(
        TelegramApi::new(transport.clone()),
        credentials.clone(),
        env.clone(),
    );
    let telegram = TelegramCommands {
        state: state.clone(),
        db: db.clone(),
        attachments: attachments.clone(),
        env: env.clone(),
        sender,
    };
    let port: Arc<dyn TelegramInboundPort> = Arc::new(inbound::TelegramBridge::new(
        telegram.clone(),
        inbound.clone(),
    ));
    let pairing = ChannelPairing::new(credentials, env.clone(), transport.clone(), port);
    let bots = Mutex::new(PersonaTelegramBotRegistry::open(&config.personas_db_path)?);
    Ok(Services {
        db,
        env,
        pairing,
        bots,
        inbound,
        attachments,
        transport,
        #[cfg(test)]
        telegram,
    })
}

/// The family's routes. The integrator attaches the services with
/// `.layer(Extension(Arc::new(services)))`.
pub fn router() -> Router<SharedState> {
    Router::new()
        .merge(pairing::router())
        .merge(webhooks::router())
        .merge(chat::router())
}

/// `request.json()` for a route that reads a body. Invalid JSON is an error, as in
/// TypeScript (the message text differs, see OP-3). A body that is not an object
/// reads as an empty object.
pub(crate) fn parse_body(bytes: &Bytes) -> Result<Map<String, Value>, String> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Ok(Map::new()),
        Err(error) => Err(error.to_string()),
    }
}

/// A non-empty string field, as `body.field || default` reads it in TypeScript.
pub(crate) fn text_field(body: &Map<String, Value>, key: &str) -> Option<String> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// `{ ok: true }`, the answer of every webhook that was accepted.
pub(crate) fn ok_response() -> Response {
    Json(json!({ "ok": true })).into_response()
}

/// The answer to a webhook whose shared secret does not match.
pub(crate) fn forbidden() -> Response {
    crate::routes::channel_support::error_response(axum::http::StatusCode::FORBIDDEN, "Forbidden")
}

/// Replaces the token in every `/bot<token>` path segment. Telegram errors carry
/// the request URL, and the URL carries the bot token. Segments without a colon
/// are kept, so `/bots/...` route paths stay readable.
pub(crate) fn redact_bot_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("/bot") {
        let (head, tail) = rest.split_at(index + "/bot".len());
        out.push_str(head);
        let end = tail
            .find(['/', '?', '"', '\'', ' ', ')', '\n', '\r'])
            .unwrap_or(tail.len());
        let (segment, remaining) = tail.split_at(end);
        if segment.contains(':') {
            out.push_str("<redacted>");
        } else {
            out.push_str(segment);
        }
        rest = remaining;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::redact_bot_tokens;

    #[test]
    fn bot_tokens_are_redacted_from_request_urls() {
        assert_eq!(
            redact_bot_tokens(
                "error sending request for url (https://api.telegram.org/bot123:AAbb/getMe)"
            ),
            "error sending request for url (https://api.telegram.org/bot<redacted>/getMe)"
        );
    }

    #[test]
    fn route_paths_without_a_token_are_kept() {
        assert_eq!(
            redact_bot_tokens("/api/channels/telegram/bots/main/webhook"),
            "/api/channels/telegram/bots/main/webhook"
        );
    }
}
