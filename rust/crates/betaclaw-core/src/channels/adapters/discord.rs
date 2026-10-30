//! Port of `src/server/channels/outbound/discord.ts` (`deliverDiscord`).

use serde_json::{json, Value};
use tracing::error;

use super::types::{json_text, non_empty, response_json, str_field, ChannelError};
use crate::channels::pairing::credentials::{ChannelCredentialStore, ChannelEnv};
use crate::model_hub::http::{fetch_with_timeout, HttpRequest, HttpTransport};

/// Posts `text` to a Discord channel with the bot token. Returns the id of the
/// created message.
pub async fn deliver_discord(
    transport: &dyn HttpTransport,
    store: &dyn ChannelCredentialStore,
    env: &ChannelEnv,
    channel_id: &str,
    text: &str,
) -> Result<Option<String>, ChannelError> {
    let Some(token) = non_empty(store.get_credential("discord", "bot_token"))
        .or_else(|| non_empty(env.get("DISCORD_BOT_TOKEN")))
    else {
        error!("Discord bot token not configured (neither in credential store nor env).");
        return Ok(None);
    };

    let request = HttpRequest::post(format!(
        "https://discord.com/api/v10/channels/{channel_id}/messages"
    ))
    .header("Authorization", &format!("Bot {token}"))
    .header("Content-Type", "application/json")
    .json_body(&json!({ "content": text }));
    let response = fetch_with_timeout(transport, request).await?;
    let body: Value = response_json(&response);
    if !response.is_ok() {
        return Err(ChannelError::new(format!(
            "Discord delivery failed: {}",
            json_text(&body)
        )));
    }
    Ok(str_field(&body, "id"))
}
