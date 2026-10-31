//! Shared helpers for the WS handlers.
//!
//! Ports the request validators of `src/server/gateway/methods/agent-v2/helpers.ts`
//! (the swarm helpers stay with S12), the emitter of
//! `src/server/channels/inbox/events.ts` without its metrics and trace calls
//! (OP-2), and the JavaScript coercions the TypeScript handlers depend on.

use serde_json::{json, Map, Value};

use crate::gateway::events::INBOX_UPDATED;
use crate::gateway::protocol::{make_error, ErrorCode, FrameId};

use super::ports::{EventSink, PersonaStore};

pub const MAX_TITLE_CHARS: usize = 160;
pub const MAX_TASK_CHARS: usize = 8_000;
pub const MAX_GUIDANCE_CHARS: usize = 2_000;

/// An error from a handler or a port. `code` is the code `toErrorCode()` would send.
#[derive(Debug, Clone, PartialEq)]
pub struct HandlerError {
    pub code: ErrorCode,
    pub message: String,
}

impl HandlerError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// `new Error(message)`. It has no `code`, so the wire code is UNAVAILABLE.
    pub fn plain(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unavailable, message)
    }

    /// `createInvalidRequestError` and `AgentV2Error(..., 'INVALID_REQUEST')`.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }

    /// The `res` error frame that `method-router.ts` sends for this error.
    pub fn to_frame(&self, id: &FrameId) -> Value {
        make_error(id, self.code, &self.message)
    }
}

/// `params[key]` when it is a string, otherwise `""` (`normalizeStringParam`).
pub fn str_param<'a>(params: &'a Value, key: &str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or("")
}

/// The string when it is non-empty.
pub fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

/// `if (!value) throw new Error(`${key} is required`)` for raw, untrimmed values.
pub fn required_raw(params: &Value, key: &str) -> Result<String, HandlerError> {
    non_empty(str_param(params, key))
        .ok_or_else(|| HandlerError::plain(format!("{key} is required")))
}

/// JavaScript truthiness of a JSON value. A missing key counts as `undefined`.
pub fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value || fallback)`. Objects and arrays give the fallback, because no
/// caller sends them and JavaScript would print `[object Object]`.
pub fn js_string_or(value: Option<&Value>, fallback: &str) -> String {
    if !js_truthy(value) {
        return fallback.to_string();
    }
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => fallback.to_string(),
    }
}

/// `Number(value)`. A missing key is NaN, null is 0, booleans are 0 or 1, and
/// strings are parsed after trimming.
pub fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// `Number.parseInt(text, 10)`: leading whitespace, an optional sign, then digits.
/// Anything after the digits is ignored.
pub fn parse_int_prefix(text: &str) -> Option<f64> {
    let trimmed = text.trim_start();
    let (sign, unsigned) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = unsigned.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<f64>().ok().map(|n| sign * n)
}

/// `requiredString`: trimmed and non-empty.
pub fn required_string(params: &Value, key: &str) -> Result<String, HandlerError> {
    let value = js_string_or(params.get(key), "").trim().to_string();
    if value.is_empty() {
        return Err(HandlerError::invalid(format!("{key} is required")));
    }
    Ok(value)
}

/// `requiredBoundedString`.
pub fn required_bounded_string(
    params: &Value,
    key: &str,
    max_chars: usize,
) -> Result<String, HandlerError> {
    let value = required_string(params, key)?;
    check_max(key, &value, max_chars)?;
    Ok(value)
}

/// `optionalString`: trimmed, `None` when empty.
pub fn optional_string(params: &Value, key: &str) -> Option<String> {
    non_empty(js_string_or(params.get(key), "").trim())
}

/// `optionalBoundedString`.
pub fn optional_bounded_string(
    params: &Value,
    key: &str,
    max_chars: usize,
) -> Result<Option<String>, HandlerError> {
    match optional_string(params, key) {
        Some(value) => {
            check_max(key, &value, max_chars)?;
            Ok(Some(value))
        }
        None => Ok(None),
    }
}

/// `requiredBoolean`: the key must be present, and its value is read by truthiness.
pub fn required_boolean(params: &Value, key: &str) -> Result<bool, HandlerError> {
    if params.get(key).is_none() {
        return Err(HandlerError::invalid(format!("{key} is required")));
    }
    Ok(js_truthy(params.get(key)))
}

/// Length is counted in UTF-16 units, as JavaScript's `.length` counts them.
fn check_max(key: &str, value: &str, max_chars: usize) -> Result<(), HandlerError> {
    if value.encode_utf16().count() > max_chars {
        return Err(HandlerError::invalid(format!(
            "{key} exceeds max size ({max_chars})."
        )));
    }
    Ok(())
}

/// `ensurePersonaExists`, for the personas of `user_id` only.
pub fn ensure_persona_exists(
    personas: &dyn PersonaStore,
    persona_id: &str,
    user_id: &str,
) -> Result<(), HandlerError> {
    match personas.find_persona(persona_id, user_id)? {
        Some(_) => Ok(()),
        None => Err(HandlerError::invalid(format!(
            "Persona not found: {persona_id}"
        ))),
    }
}

/// `new Date().toISOString()`: UTC with millisecond precision.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `areInboxEventsEnabled()`: every value except `false` (any case) is on.
pub fn inbox_events_enabled(raw: Option<&str>) -> bool {
    raw.filter(|value| !value.is_empty())
        .unwrap_or("true")
        .to_lowercase()
        != "false"
}

/// `emitInboxUpdated()` from `channels/inbox/events.ts`, without its metrics and
/// logs (OP-2).
pub fn emit_inbox_updated(
    events: &dyn EventSink,
    user_id: &str,
    action: &str,
    conversation_id: &str,
    item: Option<Value>,
) {
    if !inbox_events_enabled(std::env::var("INBOX_V2_EVENTS_ENABLED").ok().as_deref()) {
        return;
    }
    let payload = json!({
        "version": "v2",
        "action": action,
        "conversationId": conversation_id,
        "item": item,
        "serverTs": now_iso(),
    });
    events.broadcast_to_user(user_id, INBOX_UPDATED, payload);
}

/// Adds `key` only when `value` is present. `JSON.stringify` drops `undefined`
/// keys, so the wire omits them.
pub fn insert_if_some(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthiness_follows_javascript() {
        assert!(!js_truthy(None));
        assert!(!js_truthy(Some(&json!(0))));
        assert!(!js_truthy(Some(&json!(""))));
        assert!(!js_truthy(Some(&Value::Null)));
        assert!(js_truthy(Some(&json!("no"))));
        assert!(js_truthy(Some(&json!([]))));
    }

    #[test]
    fn number_coercion_follows_javascript() {
        assert!(js_number(None).is_nan());
        assert_eq!(js_number(Some(&Value::Null)), 0.0);
        assert_eq!(js_number(Some(&json!(""))), 0.0);
        assert_eq!(js_number(Some(&json!(" 12 "))), 12.0);
        assert!(js_number(Some(&json!("x"))).is_nan());
    }

    #[test]
    fn parse_int_reads_only_the_leading_integer() {
        assert_eq!(parse_int_prefix("  5000ms"), Some(5000.0));
        assert_eq!(parse_int_prefix("-3"), Some(-3.0));
        assert_eq!(parse_int_prefix("abc"), None);
    }

    #[test]
    fn string_validators_trim_and_bound() {
        let params = json!({"name": "  ", "text": "\u{1F600}"});
        assert_eq!(
            required_string(&params, "name"),
            Err(HandlerError::invalid("name is required"))
        );
        // One emoji is two UTF-16 units, so it exceeds a bound of one.
        assert_eq!(
            required_bounded_string(&params, "text", 1),
            Err(HandlerError::invalid("text exceeds max size (1)."))
        );
        assert_eq!(
            required_bounded_string(&params, "text", 2).unwrap(),
            "\u{1F600}"
        );
    }

    #[test]
    fn required_boolean_needs_the_key_but_not_a_truthy_value() {
        assert_eq!(
            required_boolean(&json!({}), "approved"),
            Err(HandlerError::invalid("approved is required"))
        );
        assert_eq!(
            required_boolean(&json!({"approved": null}), "approved"),
            Ok(false)
        );
    }

    #[test]
    fn errors_reach_the_wire_with_the_typescript_code() {
        let id = FrameId::number(4);
        assert_eq!(
            HandlerError::plain("x").to_frame(&id)["error"]["code"],
            "UNAVAILABLE"
        );
        assert_eq!(
            HandlerError::invalid("x").to_frame(&id)["error"]["code"],
            "INVALID_REQUEST"
        );
    }

    #[test]
    fn inbox_events_are_on_unless_disabled() {
        assert!(inbox_events_enabled(None));
        assert!(inbox_events_enabled(Some("")));
        assert!(!inbox_events_enabled(Some("FALSE")));
    }
}
