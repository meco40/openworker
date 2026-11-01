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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::channels::pairing::test_support::{isolated_env, json_response, ScriptedTransport};

    #[tokio::test]
    async fn without_a_bridge_url_nothing_is_sent() {
        let transport = ScriptedTransport::new();
        let env = isolated_env();

        let id = deliver_imessage(transport.as_ref(), &env, "chat-1", "Hello")
            .await
            .expect("not an error");

        assert_eq!(id, None);
        assert!(transport.requests().is_empty());
    }

    #[tokio::test]
    async fn the_chat_guid_and_message_go_to_the_send_route() {
        let transport = ScriptedTransport::new();
        transport.then("/send", json_response(200, json!({"messageId": "m-1"})));
        let env = isolated_env();
        env.set("IMESSAGE_BRIDGE_URL", "https://bridge.example.com/");

        let id = deliver_imessage(transport.as_ref(), &env, "chat-1", "Hello")
            .await
            .expect("delivered");

        assert_eq!(id.as_deref(), Some("m-1"));
        let calls = transport.calls("/send");
        assert_eq!(calls[0].url, "https://bridge.example.com/send");
        assert_eq!(
            ScriptedTransport::body_of(&calls[0]),
            json!({"chatGuid": "chat-1", "message": "Hello"})
        );
    }

    #[tokio::test]
    async fn one_trailing_slash_of_the_bridge_url_is_dropped() {
        let transport = ScriptedTransport::new();
        transport.then("/send", json_response(200, json!({"id": 7})));
        let env = isolated_env();
        env.set("IMESSAGE_BRIDGE_URL", "https://bridge.example.com");

        let id = deliver_imessage(transport.as_ref(), &env, "chat-1", "Hello")
            .await
            .expect("delivered");

        assert_eq!(id.as_deref(), Some("7"));
        assert_eq!(
            transport.calls("/send")[0].url,
            "https://bridge.example.com/send"
        );
    }

    #[tokio::test]
    async fn a_non_ok_answer_is_an_error_with_the_status() {
        let transport = ScriptedTransport::new();
        transport.then("/send", json_response(500, json!({})));
        let env = isolated_env();
        env.set("IMESSAGE_BRIDGE_URL", "https://bridge.example.com/");

        let error = deliver_imessage(transport.as_ref(), &env, "chat-1", "Hello")
            .await
            .expect_err("a 500 is an error");

        assert_eq!(error.0, "iMessage delivery failed with status 500");
    }
}
