//! Port of `src/server/channels/pairing/slack.ts` (`pairSlack`).
//!
//! The bot token is checked with `auth.test`. On success it is stored as the
//! Slack bot token and mirrored into `SLACK_BOT_TOKEN`.

use serde_json::{json, Value};

use super::{ChannelPairing, PairingOutcome};
use crate::channels::adapters::slack::failure_reason;
use crate::channels::adapters::types::{api_ok, response_json, str_field, ChannelError};
use crate::model_hub::http::{fetch_with_timeout, HttpRequest};

impl ChannelPairing {
    /// `pairSlack`. The outcome status is `connected`.
    pub async fn pair_slack(&self, token: &str) -> Result<PairingOutcome, ChannelError> {
        if token.is_empty() {
            return Err(ChannelError::new("Slack bot token is required."));
        }

        let request = HttpRequest::post("https://slack.com/api/auth.test")
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Type", "application/x-www-form-urlencoded");
        let response = fetch_with_timeout(self.transport.as_ref(), request).await?;
        let data = response_json(&response);
        if !response.is_ok() || !api_ok(&data) {
            return Err(ChannelError::new(format!(
                "Slack auth failed: {}",
                failure_reason(&data, &response)
            )));
        }

        self.store.set_credential("slack", "bot_token", token);
        self.env.set("SLACK_BOT_TOKEN", token);

        let peer_name = str_field(&data, "team")
            .or_else(|| str_field(&data, "user"))
            .unwrap_or_else(|| "slack-bot".to_string());
        Ok(PairingOutcome {
            status: Some("connected".to_string()),
            transport: None,
            account_id: None,
            peer_name,
            details: json!({
                "teamId": str_field(&data, "team_id").map_or(Value::Null, Value::String),
                "botId": str_field(&data, "bot_id").map_or(Value::Null, Value::String),
            }),
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

    #[tokio::test]
    async fn a_valid_token_is_stored_and_named_after_the_team() {
        let transport = ScriptedTransport::new();
        transport.then(
            "auth.test",
            json_response(
                200,
                json!({"ok": true, "team": "Acme", "team_id": "T1", "user": "bot", "bot_id": "B1"}),
            ),
        );
        let pairing = ChannelPairing::new(
            memory_store(),
            isolated_env(),
            transport.clone(),
            Arc::new(RecordingPort::default()),
        );

        let outcome = pairing.pair_slack("xoxb-1").await.expect("paired");

        assert_eq!(outcome.status.as_deref(), Some("connected"));
        assert_eq!(outcome.peer_name, "Acme");
        assert_eq!(outcome.details["teamId"], "T1");
        assert_eq!(
            pairing
                .store
                .get_credential("slack", "bot_token")
                .as_deref(),
            Some("xoxb-1")
        );
        let request = &transport.calls("auth.test")[0];
        assert_eq!(
            request
                .headers
                .get("authorization")
                .and_then(|v| v.to_str().ok()),
            Some("Bearer xoxb-1")
        );
    }

    #[tokio::test]
    async fn a_refused_token_reports_the_slack_error() {
        let transport = ScriptedTransport::new();
        transport.then(
            "auth.test",
            json_response(200, json!({"ok": false, "error": "invalid_auth"})),
        );
        let pairing = ChannelPairing::new(
            memory_store(),
            isolated_env(),
            transport.clone(),
            Arc::new(RecordingPort::default()),
        );

        let error = pairing.pair_slack("xoxb-bad").await.expect_err("refused");

        assert_eq!(error.0, "Slack auth failed: invalid_auth");
        assert!(pairing.store.get_credential("slack", "bot_token").is_none());
    }
}
