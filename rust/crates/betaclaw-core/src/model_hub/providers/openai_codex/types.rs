//! Port of `src/server/model-hub/Models/openai-codex/types.ts`.
//!
//! The TypeScript payload interfaces (`CodexUsagePayload`, `CodexResponsePayload`,
//! `CodexSseEvent`) declare every field as `unknown` and the parsers read them
//! behind `typeof` guards. Mirroring that, the Rust port keeps the raw
//! [`serde_json::Value`] and reads fields through the helpers in
//! [`crate::model_hub::providers::openai_codex::utils`].
//!
//! [`CodexSseEvent`] does keep one behavioural detail of the TypeScript: reading a
//! property of `null` throws a `TypeError` in Node, and `JSON.parse('null')`
//! yields exactly that. [`CodexSseEvent::property`] therefore reports
//! [`CodexError`] instead of `None` for a `null` payload, so the parser fails the
//! same way instead of silently skipping the event.

use serde_json::Value;

use crate::model_hub::types::GatewayReasoningEffort;

/// `CodexReasoningEffort` from `types.ts:3-6`:
/// `NonNullable<GatewayRequest['reasoning_effort']> | 'minimal' | 'xhigh'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodexReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

impl CodexReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexReasoningEffort::None => "none",
            CodexReasoningEffort::Minimal => "minimal",
            CodexReasoningEffort::Low => "low",
            CodexReasoningEffort::Medium => "medium",
            CodexReasoningEffort::High => "high",
            CodexReasoningEffort::Xhigh => "xhigh",
        }
    }

    /// The inverse of [`CodexReasoningEffort::as_str`], used by the tests and by
    /// callers that carry the effort as a string.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(CodexReasoningEffort::None),
            "minimal" => Some(CodexReasoningEffort::Minimal),
            "low" => Some(CodexReasoningEffort::Low),
            "medium" => Some(CodexReasoningEffort::Medium),
            "high" => Some(CodexReasoningEffort::High),
            "xhigh" => Some(CodexReasoningEffort::Xhigh),
            _ => None,
        }
    }
}

impl From<GatewayReasoningEffort> for CodexReasoningEffort {
    fn from(effort: GatewayReasoningEffort) -> Self {
        match effort {
            GatewayReasoningEffort::None => CodexReasoningEffort::None,
            GatewayReasoningEffort::Low => CodexReasoningEffort::Low,
            GatewayReasoningEffort::Medium => CodexReasoningEffort::Medium,
            GatewayReasoningEffort::High => CodexReasoningEffort::High,
        }
    }
}

/// A `throw new Error(message)` from the Codex parsers.
///
/// The TypeScript parsers throw plain `Error`s that `client/dispatch.ts:83-93`
/// catches and turns into `{ ok: false, error: error.message }`. Carrying only
/// the message keeps that mapping exact.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct CodexError {
    pub message: String,
}

impl CodexError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// `CodexSseEvent` from `types.ts:27-40`.
#[derive(Debug, Clone, PartialEq)]
pub struct CodexSseEvent(pub Value);

impl CodexSseEvent {
    pub fn new(value: Value) -> Self {
        Self(value)
    }

    pub fn value(&self) -> &Value {
        &self.0
    }

    /// `event.<key>`.
    ///
    /// `Err` reproduces the `TypeError` V8 raises for a property read on `null`
    /// (`JSON.parse('null')` is the only payload that reaches the parsers as
    /// `null`). For every other payload — including a string, number or array,
    /// where the property is simply absent — the result is `Ok(None)`.
    pub fn property(&self, key: &str) -> Result<Option<&Value>, CodexError> {
        if self.0.is_null() {
            return Err(CodexError::new(format!(
                "Cannot read properties of null (reading '{key}')"
            )));
        }
        Ok(self.0.get(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reasoning_effort_strings_round_trip() {
        for effort in [
            CodexReasoningEffort::None,
            CodexReasoningEffort::Minimal,
            CodexReasoningEffort::Low,
            CodexReasoningEffort::Medium,
            CodexReasoningEffort::High,
            CodexReasoningEffort::Xhigh,
        ] {
            assert_eq!(
                CodexReasoningEffort::parse(effort.as_str()),
                Some(effort),
                "{}",
                effort.as_str()
            );
        }
        assert_eq!(CodexReasoningEffort::parse("MINIMAL"), None);
    }

    #[test]
    fn gateway_efforts_map_onto_the_codex_subset() {
        assert_eq!(
            CodexReasoningEffort::from(GatewayReasoningEffort::High),
            CodexReasoningEffort::High
        );
        assert_eq!(
            CodexReasoningEffort::from(GatewayReasoningEffort::None),
            CodexReasoningEffort::None
        );
    }

    /// A `null` payload raises the Node `TypeError` instead of reading as
    /// "absent".
    #[test]
    fn a_null_event_reports_the_typescript_type_error() {
        let event = CodexSseEvent::new(Value::Null);
        let error = event.property("type").expect_err("null throws");
        assert_eq!(
            error.message,
            "Cannot read properties of null (reading 'type')"
        );
    }

    /// A scalar payload reads every property as absent, exactly like
    /// `(42).type` in JavaScript.
    #[test]
    fn a_scalar_event_has_no_properties() {
        let event = CodexSseEvent::new(json!(42));
        assert_eq!(event.property("type").expect("no throw"), None);
        let event = CodexSseEvent::new(json!({"type": "response.completed"}));
        assert_eq!(
            event.property("type").expect("no throw"),
            Some(&json!("response.completed"))
        );
    }
}
