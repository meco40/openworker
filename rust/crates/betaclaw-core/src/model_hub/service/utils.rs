//! Port of `src/server/model-hub/service/utils.ts`.
//!
//! Two functions are *not* re-implemented here, because the shared
//! OpenAI-compatible layer already carries a verified port:
//! `normalizeBearerSecret` is [`crate::model_hub::openai_compatible::utils::normalize_bearer_secret`]
//! and the bearer header helper is `build_optional_auth_headers`.

use serde_json::Value;

use crate::model_hub::types::{
    GatewayReasoningEffort, PipelineModelEntry, PipelineReasoningEffort,
};

/// `asPositiveInteger` from `utils.ts:5-9`.
///
/// `typeof value !== 'number' || !Number.isFinite(value)` — a non-number or a
/// non-finite number is absent. `Math.floor` then decides the sign, and only a
/// strictly positive integer survives. JSON never carries `NaN` or `Infinity`,
/// so the `Number.isFinite` half is unreachable for parsed input and only the
/// type check remains.
pub fn as_positive_integer(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    let normalized = number.floor();
    if normalized > 0.0 {
        Some(normalized as u64)
    } else {
        None
    }
}

/// `extractTextParts` from `utils.ts:18-44`.
///
/// A string contributes its trimmed self when non-empty; an array walks its
/// entries, taking strings directly and `parts[].text` from objects. Anything
/// else — including a nested array — contributes nothing.
pub fn extract_text_parts(value: &Value) -> Vec<String> {
    if let Some(text) = value.as_str() {
        return match text.trim() {
            "" => Vec::new(),
            trimmed => vec![trimmed.to_string()],
        };
    }

    let Some(entries) = value.as_array() else {
        return Vec::new();
    };

    let mut texts = Vec::new();
    for entry in entries {
        if let Some(text) = entry.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                texts.push(trimmed.to_string());
            }
            continue;
        }
        let Some(parts) = entry.get("parts").and_then(Value::as_array) else {
            continue;
        };
        for part in parts {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    texts.push(trimmed.to_string());
                }
            }
        }
    }
    texts
}

/// The `{ model, contents }` half of `tryExtractBatchPayloadAsEmbedContent`
/// (`utils.ts:46-92`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchEmbedContent {
    pub model: String,
    pub contents: Vec<String>,
}

impl BatchEmbedContent {
    /// `{ model: firstModel.trim(), contents }` in the TypeScript object
    /// literal order, which is what the Gemini SDK receives.
    pub fn to_payload(&self) -> Value {
        let mut payload = serde_json::Map::new();
        payload.insert("model".to_string(), Value::String(self.model.clone()));
        payload.insert(
            "contents".to_string(),
            Value::Array(
                self.contents
                    .iter()
                    .map(|text| Value::String(text.clone()))
                    .collect(),
            ),
        );
        Value::Object(payload)
    }
}

/// `tryExtractBatchPayloadAsEmbedContent` from `utils.ts:46-92`.
///
/// Requires a non-empty `requests` array whose first element carries a non-empty
/// string `model`. Each request then contributes either its `contents` entries
/// (strings or `parts[].text`) or its `content.parts[].text`. `null` in
/// TypeScript becomes `None` here.
pub fn try_extract_batch_payload_as_embed_content(payload: &Value) -> Option<BatchEmbedContent> {
    let requests = payload.get("requests").and_then(Value::as_array)?;
    let first = requests.first()?;
    let model = first.get("model").and_then(Value::as_str)?.trim();
    if model.is_empty() {
        return None;
    }

    let mut contents = Vec::new();
    for request in requests {
        if let Some(entries) = request.get("contents").and_then(Value::as_array) {
            for entry in entries {
                collect_batch_texts(entry, &mut contents);
            }
        } else if let Some(parts) = request
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
        {
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    push_trimmed(text, &mut contents);
                }
            }
        }
    }

    if contents.is_empty() {
        return None;
    }

    Some(BatchEmbedContent {
        model: model.to_string(),
        contents,
    })
}

/// One `contents` entry: a non-empty string, or an object with `parts[].text`.
fn collect_batch_texts(entry: &Value, contents: &mut Vec<String>) {
    if let Some(text) = entry.as_str() {
        push_trimmed(text, contents);
        return;
    }
    let Some(parts) = entry.get("parts").and_then(Value::as_array) else {
        return;
    };
    for part in parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            push_trimmed(text, contents);
        }
    }
}

fn push_trimmed(text: &str, contents: &mut Vec<String>) {
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        contents.push(trimmed.to_string());
    }
}

/// `mapPipelineReasoningEffort` from `utils.ts:94-113`.
///
/// The provider-specific rule is `off`: OpenCode and Refuseless use `none` to disable
/// reasoning, every other provider keeps the historical omission semantics, i.e.
/// `None` here means "leave the caller's value in place".
pub fn map_pipeline_reasoning_effort(
    reasoning_effort: Option<&PipelineReasoningEffort>,
    provider_id: &str,
) -> Option<GatewayReasoningEffort> {
    let effort = reasoning_effort?;
    match effort {
        PipelineReasoningEffort::Off => {
            matches!(provider_id, "opencode" | "refuseless").then_some(GatewayReasoningEffort::None)
        }
        PipelineReasoningEffort::Minimal => Some(GatewayReasoningEffort::Low),
        PipelineReasoningEffort::Xhigh => Some(GatewayReasoningEffort::High),
        PipelineReasoningEffort::Low => Some(GatewayReasoningEffort::Low),
        PipelineReasoningEffort::Medium => Some(GatewayReasoningEffort::Medium),
        PipelineReasoningEffort::High => Some(GatewayReasoningEffort::High),
        // An unknown value from the unconstrained column is treated exactly like
        // the TypeScript fall-through: no override.
        PipelineReasoningEffort::Other(_) => None,
    }
}

/// The pipeline entry the model-hub embedding pipeline walks first.
///
/// `dispatchEmbedding` filters to `status === 'active'` and then sorts by
/// priority; `slice::sort_by_key` is stable, so entries with an equal priority
/// keep the repository order, matching V8's stable `Array.prototype.sort`.
pub fn preferred_embedding_entry<'a>(
    pipeline: impl IntoIterator<Item = &'a PipelineModelEntry>,
) -> Option<&'a PipelineModelEntry> {
    let mut active: Vec<&PipelineModelEntry> = pipeline
        .into_iter()
        .filter(|entry| entry.status == crate::model_hub::types::PipelineStatus::Active)
        .collect();
    active.sort_by_key(|entry| entry.priority);
    active.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::types::PipelineStatus;

    fn entry(model: &str, priority: i64, status: PipelineStatus) -> PipelineModelEntry {
        PipelineModelEntry {
            id: format!("id-{model}"),
            profile_id: "p1".to_string(),
            account_id: "acc".to_string(),
            provider_id: "openai".to_string(),
            model_name: model.to_string(),
            reasoning_effort: None,
            priority,
            status,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    /// `Math.floor` decides the sign and only a positive value survives.
    #[test]
    fn as_positive_integer_matches_javascript() {
        assert_eq!(
            as_positive_integer(Some(&serde_json::json!(1536))),
            Some(1536)
        );
        assert_eq!(
            as_positive_integer(Some(&serde_json::json!(1536.9))),
            Some(1536)
        );
        assert_eq!(as_positive_integer(Some(&serde_json::json!(0))), None);
        assert_eq!(as_positive_integer(Some(&serde_json::json!(-2))), None);
        assert_eq!(as_positive_integer(Some(&serde_json::json!(0.5))), None);
        assert_eq!(as_positive_integer(Some(&serde_json::json!("1536"))), None);
        assert_eq!(as_positive_integer(Some(&serde_json::json!(null))), None);
        assert_eq!(as_positive_integer(None), None);
    }

    /// Strings are trimmed and dropped when empty; nested arrays are ignored.
    #[test]
    fn extract_text_parts_walks_strings_and_parts() {
        assert_eq!(
            extract_text_parts(&serde_json::json!("  hi  ")),
            vec!["hi".to_string()]
        );
        assert!(extract_text_parts(&serde_json::json!("   ")).is_empty());

        let value =
            serde_json::json!([" a ", { "parts": [{ "text": "b" }, { "text": "  " }] }, 7, null]);
        assert_eq!(
            extract_text_parts(&value),
            vec!["a".to_string(), "b".to_string()]
        );

        // A nested array is not walked at all in TypeScript either.
        assert!(extract_text_parts(&serde_json::json!([["nested"]])).is_empty());
        assert!(extract_text_parts(&serde_json::json!({ "nope": 1 })).is_empty());
    }

    /// The batch extraction needs a non-empty first `model`, and falls back from
    /// `contents` to `content.parts`.
    #[test]
    fn batch_payload_extraction_needs_a_model_and_contents() {
        let payload = serde_json::json!({
            "requests": [
                { "model": " text-embedding-004 ", "contents": ["alpha", { "parts": [{ "text": "beta" }] }] },
                { "model": "x", "content": { "parts": [{ "text": "gamma" }] } },
            ],
        });
        let extracted = try_extract_batch_payload_as_embed_content(&payload).expect("extracted");
        assert_eq!(extracted.model, "text-embedding-004");
        assert_eq!(
            extracted.contents,
            vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()]
        );
        assert_eq!(
            extracted.to_payload(),
            serde_json::json!({ "model": "text-embedding-004", "contents": ["alpha", "beta", "gamma"] }),
            "the Gemini SDK receives model first, then contents"
        );

        assert!(try_extract_batch_payload_as_embed_content(&serde_json::json!({})).is_none());
        assert!(
            try_extract_batch_payload_as_embed_content(&serde_json::json!({ "requests": [] }))
                .is_none()
        );
        assert!(try_extract_batch_payload_as_embed_content(
            &serde_json::json!({ "requests": [{ "model": "" }] })
        )
        .is_none());
        // Contents present but nothing extractable.
        assert!(
            try_extract_batch_payload_as_embed_content(&serde_json::json!({
                "requests": [{ "model": "m", "contents": [] }],
            }))
            .is_none()
        );
    }

    /// The full mapping table, including the OpenCode exception for `off`.
    #[test]
    fn map_pipeline_reasoning_effort_follows_the_typescript_table() {
        let cases = [
            (
                PipelineReasoningEffort::Off,
                Some(GatewayReasoningEffort::None),
            ),
            (
                PipelineReasoningEffort::Minimal,
                Some(GatewayReasoningEffort::Low),
            ),
            (
                PipelineReasoningEffort::Xhigh,
                Some(GatewayReasoningEffort::High),
            ),
            (
                PipelineReasoningEffort::Low,
                Some(GatewayReasoningEffort::Low),
            ),
            (
                PipelineReasoningEffort::Medium,
                Some(GatewayReasoningEffort::Medium),
            ),
            (
                PipelineReasoningEffort::High,
                Some(GatewayReasoningEffort::High),
            ),
            (PipelineReasoningEffort::Other("turbo".into()), None),
        ];
        for (effort, expected) in cases {
            let provider = if effort == PipelineReasoningEffort::Off {
                "opencode"
            } else {
                "openai"
            };
            assert_eq!(
                map_pipeline_reasoning_effort(Some(&effort), provider),
                expected,
                "{effort:?} on {provider}"
            );
        }

        // `off` omits the field for every other provider.
        assert_eq!(
            map_pipeline_reasoning_effort(Some(&PipelineReasoningEffort::Off), "openai"),
            None
        );
        // A missing effort never overrides the caller.
        assert_eq!(map_pipeline_reasoning_effort(None, "opencode"), None);
    }

    /// Only active entries are considered, in ascending priority.
    #[test]
    fn preferred_embedding_entry_filters_active_then_sorts_by_priority() {
        let pipeline = vec![
            entry("c", 3, PipelineStatus::Active),
            entry("offline", 0, PipelineStatus::Offline),
            entry("a", 9, PipelineStatus::Active),
            entry("b", 1, PipelineStatus::Active),
        ];
        let preferred = preferred_embedding_entry(&pipeline).expect("active entry");
        assert_eq!(preferred.model_name, "b");

        assert!(preferred_embedding_entry(&[]).is_none());
        assert!(preferred_embedding_entry(vec![&entry(
            "only-offline",
            1,
            PipelineStatus::Offline
        )])
        .is_none());
    }
}
