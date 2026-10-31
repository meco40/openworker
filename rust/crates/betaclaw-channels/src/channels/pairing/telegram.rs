//! Port of `pairTelegram` in `src/server/channels/pairing/telegram.ts`.
//!
//! The bot token is validated with `getMe`. A webhook is registered when the app
//! URL is known, with a fresh secret token. Without one, or when Telegram refuses
//! the webhook, the bot polls instead. The chat is then paired with a code, see
//! `telegram_code`.

use serde_json::{json, Value};
use tracing::warn;

use super::telegram_code::begin_telegram_code_pairing;
use super::{app_url, random_hex, trim_one_slash, ChannelPairing, PairingOutcome};
use crate::channels::adapters::telegram::api::allowed_updates;
use crate::channels::adapters::telegram::native_commands::{
    sync_native_commands, TELEGRAM_NATIVE_COMMANDS,
};
use crate::channels::adapters::types::{
    api_ok, json_text, response_json, value_as_id, ChannelError,
};

const CHANNEL: &str = "telegram";
const WEBHOOK_PATH: &str = "/api/channels/telegram/webhook";

impl ChannelPairing {
    /// `pairTelegram`. The outcome status is `awaiting_code`.
    pub async fn pair_telegram(&self, token: &str) -> Result<PairingOutcome, ChannelError> {
        if token.is_empty() {
            return Err(ChannelError::new("Telegram token is required."));
        }

        let me_response = self.api.get(token, "getMe").await?;
        let me = response_json(&me_response);
        if !me_response.is_ok() || !api_ok(&me) {
            return Err(ChannelError::new(format!(
                "Telegram auth failed: {}",
                json_text(&me)
            )));
        }

        let webhook_secret = random_hex(32)?;
        let mut transport = "polling";
        if let Some(app) = app_url(&self.env) {
            let webhook_url = format!("{}{WEBHOOK_PATH}", trim_one_slash(&app));
            let answer = self
                .api
                .post(
                    token,
                    "setWebhook",
                    &json!({
                        "url": webhook_url,
                        "secret_token": webhook_secret,
                        "allowed_updates": allowed_updates(),
                    }),
                )
                .await?;
            let body = response_json(&answer);
            if api_ok(&body) {
                transport = "webhook";
            } else {
                let description = body
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("undefined");
                warn!("Telegram webhook setup warning: {}", description);
            }
        } else {
            warn!("APP_URL not set - Telegram webhook not registered. Set APP_URL for production.");
        }

        if transport == "polling" {
            if let Err(error) = self
                .api
                .post(
                    token,
                    "deleteWebhook",
                    &json!({ "drop_pending_updates": true }),
                )
                .await
            {
                warn!(
                    "Telegram deleteWebhook warning while switching to polling mode: {}",
                    error
                );
            }
        }

        self.poller.stop();
        self.store.set_credential(CHANNEL, "bot_token", token);
        self.store
            .set_credential(CHANNEL, "webhook_secret", &webhook_secret);
        self.store
            .set_credential(CHANNEL, "update_transport", transport);
        self.store.set_credential(CHANNEL, "polling_offset", "0");
        self.env.set("TELEGRAM_BOT_TOKEN", token);
        self.env.set("TELEGRAM_WEBHOOK_SECRET", &webhook_secret);

        begin_telegram_code_pairing(self.store.as_ref());
        if transport == "polling" {
            self.poller.start().await;
        }
        sync_native_commands(&self.api, token, &TELEGRAM_NATIVE_COMMANDS).await;

        let result = me.get("result").cloned().unwrap_or(Value::Null);
        let peer_name = result
            .get("username")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "telegram:{}",
                    result
                        .get("id")
                        .and_then(value_as_id)
                        .unwrap_or_else(|| "unknown".to_string())
                )
            });

        Ok(PairingOutcome {
            status: Some("awaiting_code".to_string()),
            transport: Some(transport.to_string()),
            account_id: None,
            peer_name,
            details: result,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::channels::pairing::test_support::{
        isolated_env, json_response, memory_store, RecordingPort, ScriptedTransport,
    };

    fn pairing_with(transport: &Arc<ScriptedTransport>) -> ChannelPairing {
        ChannelPairing::new(
            memory_store(),
            isolated_env(),
            transport.clone(),
            Arc::new(RecordingPort::default()),
        )
    }

    fn me_ok(transport: &ScriptedTransport) {
        transport.then(
            "getMe",
            json_response(
                200,
                json!({"ok": true, "result": {"id": 9, "username": "claw_bot"}}),
            ),
        );
        transport.then("deleteMyCommands", json_response(200, json!({"ok": true})));
        transport.then("setMyCommands", json_response(200, json!({"ok": true})));
    }

    #[tokio::test]
    async fn an_empty_token_is_refused_before_any_request() {
        let transport = ScriptedTransport::new();
        let pairing = pairing_with(&transport);

        let error = pairing.pair_telegram("").await.expect_err("refused");

        assert_eq!(error.0, "Telegram token is required.");
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn a_rejected_token_is_reported_with_the_provider_answer() {
        let transport = ScriptedTransport::new();
        transport.then(
            "getMe",
            json_response(401, json!({"ok": false, "description": "Unauthorized"})),
        );
        let pairing = pairing_with(&transport);

        let error = pairing.pair_telegram("9:bad").await.expect_err("refused");

        assert!(error.0.starts_with("Telegram auth failed: "));
        assert!(error.0.contains("Unauthorized"));
        assert!(pairing
            .store
            .get_credential("telegram", "bot_token")
            .is_none());
    }

    #[tokio::test]
    async fn a_webhook_pairing_records_the_token_and_waits_for_a_code() {
        let transport = ScriptedTransport::new();
        me_ok(&transport);
        transport.then("setWebhook", json_response(200, json!({"ok": true})));
        let pairing = pairing_with(&transport);
        pairing.env.set("APP_URL", "https://app.test/");

        let outcome = pairing.pair_telegram("9:token").await.expect("paired");

        assert_eq!(outcome.status.as_deref(), Some("awaiting_code"));
        assert_eq!(outcome.transport.as_deref(), Some("webhook"));
        assert_eq!(outcome.peer_name, "claw_bot");
        assert_eq!(
            pairing
                .store
                .get_credential("telegram", "bot_token")
                .as_deref(),
            Some("9:token")
        );
        assert_eq!(
            pairing
                .store
                .get_credential("telegram", "pairing_status")
                .as_deref(),
            Some("awaiting_code")
        );
        let webhook = ScriptedTransport::body_of(&transport.calls("setWebhook")[0]);
        assert_eq!(
            webhook["url"],
            "https://app.test/api/channels/telegram/webhook"
        );
        assert_eq!(
            webhook["allowed_updates"],
            json!(["message", "callback_query"])
        );
        assert!(transport.calls("deleteWebhook").is_empty());
        assert!(!pairing.is_telegram_polling_active());
    }

    #[tokio::test]
    async fn without_an_app_url_the_bot_polls_and_clears_the_webhook() {
        let transport = ScriptedTransport::new();
        me_ok(&transport);
        transport.then("deleteWebhook", json_response(200, json!({"ok": true})));
        let pairing = pairing_with(&transport);

        let outcome = pairing.pair_telegram("9:token").await.expect("paired");

        assert_eq!(outcome.transport.as_deref(), Some("polling"));
        assert!(transport.calls("setWebhook").is_empty());
        let clear = ScriptedTransport::body_of(&transport.calls("deleteWebhook")[0]);
        assert_eq!(clear["drop_pending_updates"], true);
        assert_eq!(
            pairing
                .store
                .get_credential("telegram", "update_transport")
                .as_deref(),
            Some("polling")
        );
        pairing.stop_telegram_polling();
    }
}
