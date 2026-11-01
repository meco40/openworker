//! Port of `src/server/channels/outbound/whatsapp.ts` (`deliverWhatsApp`).
//!
//! The bridge URL is read from `WHATSAPP_BRIDGE_URL` at call time, as
//! `process.env` is read in the source. A missing URL logs and returns `None`.

use serde_json::{json, Value};
use tracing::error;

use super::types::{non_empty, response_json, value_as_id, ChannelError};
use crate::channels::pairing::bridge_accounts::parse_scoped_bridge_external_chat_id;
use crate::channels::pairing::credentials::ChannelEnv;
use crate::model_hub::http::{fetch_with_timeout, HttpRequest, HttpTransport};

/// Sends `text` to a WhatsApp chat. `scoped_chat_id` may carry an account
/// scope (`acct:...`); `metadata.accountId` overrides the scope's account.
pub async fn deliver_whatsapp(
    transport: &dyn HttpTransport,
    env: &ChannelEnv,
    scoped_chat_id: &str,
    text: &str,
    metadata: Option<&Value>,
) -> Result<Option<String>, ChannelError> {
    let Some(bridge_url) = non_empty(env.get("WHATSAPP_BRIDGE_URL")) else {
        error!("WHATSAPP_BRIDGE_URL not configured.");
        return Ok(None);
    };

    let scoped = parse_scoped_bridge_external_chat_id(scoped_chat_id);
    let account_from_metadata = metadata
        .and_then(|meta| meta.get("accountId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let account_id = if account_from_metadata.is_empty() {
        scoped.account_id
    } else {
        account_from_metadata
    };

    let mut body = json!({
        "to": scoped.external_chat_id,
        "message": text,
        "accountId": account_id,
    });
    if let Some(meta) = metadata {
        body["metadata"] = meta.clone();
    }

    let url = format!(
        "{}/send",
        bridge_url.strip_suffix('/').unwrap_or(bridge_url.as_str())
    );
    let request = HttpRequest::post(url)
        .header("Content-Type", "application/json")
        .header("x-betaclaw-account-id", &account_id)
        .json_body(&body);
    let response = fetch_with_timeout(transport, request).await?;
    if !response.is_ok() {
        return Err(ChannelError::new(format!(
            "WhatsApp delivery failed with status {}",
            response.status.as_u16()
        )));
    }

    let answer = response_json(&response);
    Ok(answer
        .get("messageId")
        .and_then(value_as_id)
        .or_else(|| answer.get("id").and_then(value_as_id)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::channels::pairing::bridge_accounts::scope_bridge_external_chat_id;
    use crate::channels::pairing::test_support::{isolated_env, json_response, ScriptedTransport};

    #[tokio::test]
    async fn a_scoped_chat_id_is_split_into_recipient_and_account() {
        let transport = ScriptedTransport::new();
        transport.then("/send", json_response(200, json!({"id": "w-1"})));
        let env = isolated_env();
        env.set("WHATSAPP_BRIDGE_URL", "http://bridge.local");
        let scoped = scope_bridge_external_chat_id("sales", "491234@s.whatsapp.net")
            .expect("valid account id");

        let id = deliver_whatsapp(transport.as_ref(), &env, &scoped, "hello", None)
            .await
            .expect("delivered");

        assert_eq!(id.as_deref(), Some("w-1"));
        let calls = transport.calls("/send");
        assert_eq!(calls.len(), 1);
        let body = ScriptedTransport::body_of(&calls[0]);
        assert_eq!(body["to"], "491234@s.whatsapp.net");
        assert_eq!(body["accountId"], "sales");
        assert_eq!(body["message"], "hello");
        assert_eq!(
            calls[0]
                .headers
                .get("x-betaclaw-account-id")
                .map(|value| value.to_str().ok()),
            Some(Some("sales"))
        );
    }

    #[tokio::test]
    async fn a_missing_bridge_url_sends_nothing() {
        let transport = ScriptedTransport::new();
        let env = isolated_env();

        let id = deliver_whatsapp(
            transport.as_ref(),
            &env,
            "491234@s.whatsapp.net",
            "hi",
            None,
        )
        .await
        .expect("not an error");

        assert_eq!(id, None);
        assert!(transport.requests().is_empty());
    }
}
