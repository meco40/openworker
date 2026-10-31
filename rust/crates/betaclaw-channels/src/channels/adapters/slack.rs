//! Port of `src/server/channels/outbound/slack.ts` (`deliverSlack`) and of the
//! failure text that `pairing/slack.ts` shares with it.

use serde_json::{json, Value};
use tracing::error;

use super::types::{api_ok, non_empty, response_json, str_field, ChannelError};
use crate::channels::pairing::credentials::{ChannelCredentialStore, ChannelEnv};
use crate::model_hub::http::{fetch_with_timeout, HttpRequest, HttpResponse, HttpTransport};

/// `data.error || response.statusText || 'unknown error'`.
pub fn failure_reason(data: &Value, response: &HttpResponse) -> String {
    str_field(data, "error")
        .or_else(|| non_empty(Some(response.status_text.clone())))
        .unwrap_or_else(|| "unknown error".to_string())
}

/// `chat.postMessage`. Returns the `ts` of the posted message.
pub async fn deliver_slack(
    transport: &dyn HttpTransport,
    store: &dyn ChannelCredentialStore,
    env: &ChannelEnv,
    channel_id: &str,
    text: &str,
) -> Result<Option<String>, ChannelError> {
    let Some(token) = non_empty(store.get_credential("slack", "bot_token"))
        .or_else(|| non_empty(env.get("SLACK_BOT_TOKEN")))
    else {
        error!("Slack bot token not configured (neither in credential store nor env).");
        return Ok(None);
    };

    let request = HttpRequest::post("https://slack.com/api/chat.postMessage")
        .header("Authorization", &format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json_body(&json!({ "channel": channel_id, "text": text }));
    let response = fetch_with_timeout(transport, request).await?;
    let data = response_json(&response);
    if !response.is_ok() || !api_ok(&data) {
        return Err(ChannelError::new(format!(
            "Slack delivery failed: {}",
            failure_reason(&data, &response)
        )));
    }
    Ok(str_field(&data, "ts"))
}
