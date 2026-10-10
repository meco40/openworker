//! Port of `src/server/model-hub/service/types.ts` plus the constants that live
//! in `service/utils.ts` (the ported half of that file is [`utils`]).
//!
//! Two shapes here keep the tolerant parsing that TypeScript performs on
//! unconstrained database values:
//!
//! - `EmbeddingOperation` is a closed union in TypeScript, but the callers
//!   (`dispatchEmbedding`) pass whatever the route received. The TypeScript test
//!   `tests/unit/model-hub/service-embeddings.test.ts:355` deliberately feeds
//!   `'unknown'` through it and expects
//!   `{ error: 'Unknown embedding operation: unknown' }`, so unknown values are
//!   preserved verbatim instead of rejected.
//! - `EmbeddingInput['payload']` is `Record<string, unknown>`; `serde_json::Value`
//!   keeps that openness, and the embedding code reads it through
//!   [`Value::get`](serde_json::Value::get), which returns `None` for an absent
//!   key exactly like a property access on a non-object in JavaScript.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model_hub::http::AbortSignal;
use crate::model_hub::openai_compatible::StreamDeltaCallback;

/// `EMBEDDING_PROFILE_ID` from `service/utils.ts:3`.
pub const EMBEDDING_PROFILE_ID: &str = "p1-embeddings";

/// `EmbeddingInput['operation']` from `service/types.ts:44`.
///
/// Hand-written `Serialize`/`Deserialize` for the same reason as
/// [`crate::model_hub::types::PipelineReasoningEffort`]: the wire form is the
/// bare string, and an unknown value has to survive a round-trip so
/// `dispatchEmbedding` can report it verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbeddingOperation {
    EmbedContent,
    BatchEmbedContents,
    /// A value outside the TypeScript union.
    Other(String),
}

impl EmbeddingOperation {
    pub fn as_str(&self) -> &str {
        match self {
            EmbeddingOperation::EmbedContent => "embedContent",
            EmbeddingOperation::BatchEmbedContents => "batchEmbedContents",
            EmbeddingOperation::Other(raw) => raw.as_str(),
        }
    }

    /// What `toPipelineEntry`-style tolerance looks like on a plain string: the
    /// two known spellings, everything else preserved.
    pub fn parse(value: &str) -> Self {
        match value {
            "embedContent" => EmbeddingOperation::EmbedContent,
            "batchEmbedContents" => EmbeddingOperation::BatchEmbedContents,
            other => EmbeddingOperation::Other(other.to_string()),
        }
    }
}

impl Serialize for EmbeddingOperation {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for EmbeddingOperation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Ok(EmbeddingOperation::parse(&raw))
    }
}

impl FromStr for EmbeddingOperation {
    type Err = std::convert::Infallible;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(EmbeddingOperation::parse(value))
    }
}

impl fmt::Display for EmbeddingOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `EmbeddingInput` from `service/types.ts:43-46`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingInput {
    pub operation: EmbeddingOperation,
    pub payload: Value,
}

/// `DispatchWithFallbackOptions` from `service/types.ts:48-52`.
///
/// The TypeScript interface carries `signal` and `onStreamDelta`, which the port
/// expresses as [`AbortSignal`] and [`StreamDeltaCallback`] - the same objects
/// `dispatchOpenAICompatibleChat` already consumes.
///
/// `Debug` is hand-written: [`StreamDeltaCallback`] is a boxed closure, which has
/// no `Debug`, and the TypeScript tests print the option object freely.
#[derive(Clone, Default)]
pub struct DispatchWithFallbackOptions {
    /// `options.signal`.
    pub abort: Option<AbortSignal>,
    /// `options.modelOverride`.
    pub model_override: Option<String>,
    /// `options.onStreamDelta`.
    pub on_stream_delta: Option<StreamDeltaCallback>,
}

impl std::fmt::Debug for DispatchWithFallbackOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DispatchWithFallbackOptions")
            .field("abort", &self.abort)
            .field("model_override", &self.model_override)
            .field(
                "on_stream_delta",
                &self.on_stream_delta.as_ref().map(|_| "<callback>"),
            )
            .finish()
    }
}

impl DispatchWithFallbackOptions {
    pub fn with_model_override(model_override: impl Into<String>) -> Self {
        Self {
            model_override: Some(model_override.into()),
            ..Self::default()
        }
    }

    /// `options?.signal?.aborted` — an absent signal is never aborted.
    pub fn is_aborted(&self) -> bool {
        self.abort
            .as_ref()
            .is_some_and(crate::model_hub::http::AbortSignal::is_aborted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The union values keep their spellings and unknown values survive the
    /// round-trip, because `dispatchEmbedding` echoes them back.
    #[test]
    fn embedding_operation_round_trips_unknown_values() {
        assert_eq!(
            EmbeddingOperation::parse("embedContent"),
            EmbeddingOperation::EmbedContent
        );
        assert_eq!(
            EmbeddingOperation::parse("batchEmbedContents"),
            EmbeddingOperation::BatchEmbedContents
        );

        let unknown = EmbeddingOperation::parse("unknown");
        assert_eq!(unknown.as_str(), "unknown");
        assert_eq!(
            serde_json::to_value(&unknown).expect("serialize"),
            Value::String("unknown".to_string())
        );
        assert_eq!(
            serde_json::from_value::<EmbeddingOperation>(Value::String("unknown".to_string()))
                .expect("deserialize"),
            unknown
        );
    }

    /// `payload` is an opaque JSON value in both languages, so the double is
    /// built from the same shape the routes hand over.
    #[test]
    fn embedding_input_uses_the_wire_field_names() {
        let input: EmbeddingInput = serde_json::from_value(serde_json::json!({
            "operation": "embedContent",
            "payload": { "model": "m", "contents": ["hi"] },
        }))
        .expect("deserialize");

        assert_eq!(input.operation, EmbeddingOperation::EmbedContent);
        assert_eq!(input.payload["model"], "m");
        assert_eq!(
            serde_json::to_value(&input).expect("serialize"),
            serde_json::json!({
                "operation": "embedContent",
                "payload": { "model": "m", "contents": ["hi"] },
            })
        );
    }

    #[test]
    fn an_absent_signal_is_never_aborted() {
        assert!(!DispatchWithFallbackOptions::default().is_aborted());
        assert!(!DispatchWithFallbackOptions::with_model_override("m").is_aborted());
        let signal = AbortSignal::new();
        signal.abort();
        assert!(DispatchWithFallbackOptions {
            abort: Some(signal),
            ..DispatchWithFallbackOptions::default()
        }
        .is_aborted());
    }
}
