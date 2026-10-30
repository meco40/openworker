//! Port of `src/server/channels/pairing/discord.ts` (`pairDiscord`).
//!
//! The bot token is checked against `users/@me`. On success it is stored as the
//! Discord bot token and mirrored into `DISCORD_BOT_TOKEN`.

use super::{ChannelPairing, PairingOutcome};
use crate::channels::adapters::types::{json_text, response_json, str_field, ChannelError};
use crate::model_hub::http::{fetch_with_timeout, HttpRequest};

impl ChannelPairing {
    /// `pairDiscord`. The outcome carries no status, as in the source.
    pub async fn pair_discord(&self, token: &str) -> Result<PairingOutcome, ChannelError> {
        if token.is_empty() {
            return Err(ChannelError::new("Discord bot token is required."));
        }

        let request = HttpRequest::get("https://discord.com/api/v10/users/@me")
            .header("Authorization", &format!("Bot {token}"));
        let response = fetch_with_timeout(self.transport.as_ref(), request).await?;
        let data = response_json(&response);
        if !response.is_ok() {
            return Err(ChannelError::new(format!(
                "Discord auth failed: {}",
                json_text(&data)
            )));
        }

        self.store.set_credential("discord", "bot_token", token);
        self.env.set("DISCORD_BOT_TOKEN", token);

        let peer_name = match str_field(&data, "username") {
            Some(username) => format!(
                "{}#{}",
                username,
                str_field(&data, "discriminator").unwrap_or_else(|| "0".to_string())
            ),
            None => "discord-bot".to_string(),
        };
        Ok(PairingOutcome {
            status: None,
            transport: None,
            account_id: None,
            peer_name,
            details: data,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::channels::pairing::test_support::{
        isolated_env, json_response, memory_store, RecordingPort, ScriptedTransport,
    };

    #[tokio::test]
    async fn the_peer_name_carries_the_discriminator() {
        let transport = ScriptedTransport::new();
        transport.then(
            "users/@me",
            json_response(200, json!({"username": "clawbot", "discriminator": "4242"})),
        );
        let pairing = ChannelPairing::new(
            memory_store(),
            isolated_env(),
            transport.clone(),
            Arc::new(RecordingPort::default()),
        );

        let outcome = pairing.pair_discord("disc-1").await.expect("paired");

        assert_eq!(outcome.peer_name, "clawbot#4242");
        assert_eq!(
            pairing
                .store
                .get_credential("discord", "bot_token")
                .as_deref(),
            Some("disc-1")
        );
    }

    #[tokio::test]
    async fn a_refused_token_is_not_stored() {
        let transport = ScriptedTransport::new();
        transport.then(
            "users/@me",
            json_response(401, json!({"message": "401: Unauthorized"})),
        );
        let pairing = ChannelPairing::new(
            memory_store(),
            isolated_env(),
            transport.clone(),
            Arc::new(RecordingPort::default()),
        );

        let error = pairing.pair_discord("bad").await.expect_err("refused");

        assert!(error.0.starts_with("Discord auth failed: "));
        assert!(pairing
            .store
            .get_credential("discord", "bot_token")
            .is_none());
    }

    #[tokio::test]
    async fn an_empty_token_is_refused_without_a_request() {
        let transport = ScriptedTransport::new();
        let pairing = ChannelPairing::new(
            memory_store(),
            isolated_env(),
            transport.clone(),
            Arc::new(RecordingPort::default()),
        );

        let error = pairing.pair_discord("").await.expect_err("refused");

        assert_eq!(error.0, "Discord bot token is required.");
        assert!(transport.requests().is_empty());
    }
}
