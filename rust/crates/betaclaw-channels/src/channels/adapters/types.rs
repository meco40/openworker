//! Port of `src/server/channels/adapters/types.ts`.
//!
//! `ChannelKey` is shared with [`crate::messages_store::ChannelKey`]. The error
//! type and the JSON helpers used by every adapter and pairing module live here
//! too, so all of them report failures and read provider answers the same way.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::model_hub::http::{HttpError, HttpResponse};

/// `ChannelCapabilities` from `types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCapabilities {
    pub supports_inbound: bool,
    pub supports_outbound: bool,
    pub supports_pairing: bool,
    pub supports_streaming: bool,
}

/// `OutboundDeliveryReceipt` from `types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundDeliveryReceipt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_message_id: Option<String>,
    pub delivered_at: String,
}

/// Failure of an adapter or pairing operation. The text is the message the
/// TypeScript `Error` carried, so the route layer can show it unchanged.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ChannelError(pub String);

impl ChannelError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl From<HttpError> for ChannelError {
    fn from(error: HttpError) -> Self {
        Self(error.to_string())
    }
}

/// `await response.json().catch(() => ({}))`: a body that is not JSON reads as
/// an empty object.
pub fn response_json(response: &HttpResponse) -> Value {
    serde_json::from_str(&response.body).unwrap_or_else(|_| Value::Object(Map::new()))
}

/// `body.ok` is truthy only when it is the boolean `true`, which is how the
/// Telegram, Slack and bridge answers are checked.
pub fn api_ok(body: &Value) -> bool {
    body.get("ok").and_then(Value::as_bool) == Some(true)
}

/// A string field, read only when it is non-empty (`value.field || fallback`).
pub fn str_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Reads an identifier that a provider sends either as a string or as a number.
pub fn value_as_id(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// `JSON.stringify(value)` for error messages.
pub fn json_text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// A credential or environment value where the empty string counts as absent,
/// as `||` does in the TypeScript fallbacks.
pub fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}
