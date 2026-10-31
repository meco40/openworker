//! Port of `src/server/channels/outbound/imessage.ts` (`deliveriMessage` in the
//! source, which the port names `deliver_imessage`).
//!
//! iMessage goes through a bridge (BlueBubbles or AirMessage). The bridge URL
//! is read from `IMESSAGE_BRIDGE_URL` at call time.

use serde_json::{json, Value};
use tracing::error;

use super::types::{non_empty, response_json, value_as_id, ChannelError};
use crate::channels::pairing::credentials::ChannelEnv;
use crate::model_hub::http::{fetch_with_timeout, HttpRequest, HttpTransport};

pub async fn deliver_imessage(
    transport: &dyn HttpTransport,
    env: &ChannelEnv,
    chat_id: &str,
    text: &str,
) -> Result<Option<String>, ChannelError> {
    let Some(bridge_url) = non_empty(env.get("IMESSAGE_BRIDGE_URL")) else {
        error!("IMESSAGE_BRIDGE_URL not configured.");
        return Ok(None);
    };

    let url = format!(
        "{}/send",
        bridge_url.strip_suffix('/').unwrap_or(bridge_url.as_str())
    );
    let request = HttpRequest::post(url)
        .header("Content-Type", "application/json")
        .json_body(&json!({ "chatGuid": chat_id, "message": text }));
    let response = fetch_with_timeout(transport, request).await?;
    if !response.is_ok() {
        return Err(ChannelError::new(format!(
            "iMessage delivery failed with status {}",
            response.status.as_u16()
        )));
    }

    let answer: Value = response_json(&response);
    Ok(answer
        .get("messageId")
        .and_then(value_as_id)
        .or_else(|| answer.get("id").and_then(value_as_id)))
}
