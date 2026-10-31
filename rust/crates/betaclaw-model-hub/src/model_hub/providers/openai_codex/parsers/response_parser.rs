//! Port of `src/server/model-hub/Models/openai-codex/parsers/responseParser.ts`.
//!
//! Every helper walks a `serde_json::Value` with the same `typeof`/`Array.isArray`
//! guards as the TypeScript, because the payloads are declared `unknown` there.
//! Two details that are easy to get wrong:
//!
//! - `!item || typeof item !== 'object'` also lets an **array** through. Such an
//!   item reads `.type` as `undefined` and is skipped by the following `type`
//!   comparison, so `is_object()` in the port yields the same result. Only
//!   [`extract_function_calls_from_codex_output`] excludes arrays explicitly
//!   (`responseParser.ts:46`).
//! - [`map_function_call_args`] of `'null'` yields `Some(Value::Null)`, not
//!   `None`: `JSON.parse('null')` is `null` and `null !== undefined`.

use serde_json::Value;

use crate::model_hub::types::{GatewayFunctionCall, GatewayUsage};

use super::super::utils::{js_int, to_non_empty_string, to_number_or_null};

/// `extractTextFromCodexOutput` from `responseParser.ts:5-23`.
///
/// Concatenates every `output_text.text` and `refusal.refusal` of the `message`
/// items and trims the result, so an empty list and a list without matching
/// parts both yield `''`.
pub fn extract_text_from_codex_output(output: Option<&Value>) -> String {
    let Some(items) = output.and_then(Value::as_array) else {
        return String::new();
    };

    let mut chunks = String::new();
    for item in items {
        if !item.is_object() {
            continue;
        }
        chunks.push_str(&message_item_text(item));
    }
    chunks.trim().to_string()
}

/// The concatenated `output_text.text` and `refusal.refusal` of one `message`
/// item (`responseParser.ts:8-21`).
///
/// Shared with the SSE item handler in
/// [`super::sse_parser`], which applies the same two guards (`type` is
/// `message`, `content` is an array) before it calls this.
pub(super) fn message_item_text(item: &Value) -> String {
    if item.get("type").and_then(Value::as_str) != Some("message") {
        return String::new();
    }
    let Some(content) = item.get("content").and_then(Value::as_array) else {
        return String::new();
    };

    let mut chunks = String::new();
    for content_part in content {
        if !content_part.is_object() {
            continue;
        }
        match content_part.get("type").and_then(Value::as_str) {
            Some("output_text") => {
                if let Some(text) = content_part.get("text").and_then(Value::as_str) {
                    chunks.push_str(text);
                }
            }
            Some("refusal") => {
                if let Some(text) = content_part.get("refusal").and_then(Value::as_str) {
                    chunks.push_str(text);
                }
            }
            _ => {}
        }
    }
    chunks
}

/// `mapFunctionCallArgs` from `responseParser.ts:25-37`.
///
/// A string is parsed as JSON and falls back to `{ raw }` when that fails; any
/// other object (including an array) passes through; everything else — a
/// number, a boolean, `null`, `undefined` — reads as "no arguments".
pub fn map_function_call_args(raw_args: Option<&Value>) -> Option<Value> {
    match raw_args {
        Some(Value::String(text)) => Some(
            serde_json::from_str::<Value>(text)
                .unwrap_or_else(|_| serde_json::json!({ "raw": text })),
        ),
        Some(value @ (Value::Object(_) | Value::Array(_))) => Some(value.clone()),
        _ => None,
    }
}

/// `extractFunctionCallsFromCodexOutput` from `responseParser.ts:39-59`.
///
/// Unlike the SSE item handler this one skips arrays outright (`:46`) and drops
/// a call without a trimmed name.
pub fn extract_function_calls_from_codex_output(
    output: Option<&Value>,
) -> Vec<GatewayFunctionCall> {
    let Some(items) = output.and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut calls: Vec<GatewayFunctionCall> = Vec::new();
    for item in items {
        if !item.is_object() {
            continue;
        }
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        let Some(name) = to_non_empty_string(item.get("name")) else {
            continue;
        };
        calls.push(GatewayFunctionCall {
            name,
            args: map_function_call_args(item.get("arguments")),
        });
    }
    calls
}

/// `${call.name}::${JSON.stringify(call.args ?? null)}` from
/// `responseParser.ts:66`.
///
/// `serde_json` preserves object key order for values that came out of
/// `JSON.parse` (the workspace enables `serde_json/preserve_order`), so the key
/// matches `JSON.stringify` for anything the parsers produce.
fn function_call_key(call: &GatewayFunctionCall) -> String {
    let args = match call.args.as_ref() {
        Some(args) => serde_json::to_string(args).unwrap_or_default(),
        None => "null".to_string(),
    };
    format!("{}::{}", call.name, args)
}

/// `appendUniqueFunctionCalls` from `responseParser.ts:61-74`.
///
/// The existing keys are recomputed on every call, exactly like the
/// TypeScript, so a handler that appends twice keeps the deduplication.
pub fn append_unique_function_calls(
    target: &mut Vec<GatewayFunctionCall>,
    incoming: Vec<GatewayFunctionCall>,
) {
    let mut existing: Vec<String> = target.iter().map(function_call_key).collect();
    for call in incoming {
        let key = function_call_key(&call);
        if existing.contains(&key) {
            continue;
        }
        existing.push(key);
        target.push(call);
    }
}

/// `mapCodexUsage` from `responseParser.ts:76-95`.
///
/// Returns `None` when all three token fields are absent, so a payload without
/// usage never replaces an earlier one. `total_tokens` is used as sent — it is
/// not recomputed from the other two when it is present — and
/// `input_tokens_details.cached_tokens` is subtracted from `input_tokens`, so
/// `prompt_tokens` is the uncached part. Both results are floored at zero.
pub fn map_codex_usage(payload: Option<&Value>) -> Option<GatewayUsage> {
    // `!payload || typeof payload !== 'object'`: an array reaches the field
    // reads in TypeScript and finds nothing, which is the same `None`.
    let object = payload.and_then(Value::as_object)?;

    let input_tokens = to_number_or_null(object.get("input_tokens"));
    let output_tokens = to_number_or_null(object.get("output_tokens"));
    let total_tokens = to_number_or_null(object.get("total_tokens"));
    if input_tokens.is_none() && output_tokens.is_none() && total_tokens.is_none() {
        return None;
    }

    let cached_tokens = to_number_or_null(
        object
            .get("input_tokens_details")
            .and_then(|details| details.get("cached_tokens")),
    )
    .unwrap_or(0.0);

    let prompt_tokens = (input_tokens.unwrap_or(0.0) - cached_tokens.max(0.0)).max(0.0);
    let completion_tokens = output_tokens.unwrap_or(0.0).max(0.0);
    let total = total_tokens
        .unwrap_or(prompt_tokens + completion_tokens)
        .max(0.0);

    Some(GatewayUsage {
        prompt_tokens: js_int(Some(prompt_tokens)),
        completion_tokens: js_int(Some(completion_tokens)),
        total_tokens: js_int(Some(total)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_is_collected_from_message_items_and_trimmed() {
        let output = json!([
            { "type": "reasoning", "summary": [] },
            {
                "type": "message",
                "content": [
                    { "type": "output_text", "text": "  hallo" },
                    { "type": "refusal", "refusal": " welt  " }
                ]
            }
        ]);
        assert_eq!(extract_text_from_codex_output(Some(&output)), "hallo welt");
    }

    #[test]
    fn text_ignores_non_message_items_and_absent_content() {
        assert_eq!(extract_text_from_codex_output(None), "");
        assert_eq!(extract_text_from_codex_output(Some(&json!({}))), "");
        assert_eq!(
            extract_text_from_codex_output(Some(&json!([{ "type": "message" }]))),
            ""
        );
        assert_eq!(
            extract_text_from_codex_output(Some(&json!([{ "type": "message", "content": {} }]))),
            ""
        );
    }

    #[test]
    fn function_call_arguments_follow_the_string_fallbacks() {
        assert_eq!(
            map_function_call_args(Some(&json!("{\"a\":1}"))),
            Some(json!({ "a": 1 }))
        );
        assert_eq!(
            map_function_call_args(Some(&json!("{oops"))),
            Some(json!({ "raw": "{oops" }))
        );
        // `JSON.parse('null')` returns `null`, which is *not* `undefined`.
        assert_eq!(
            map_function_call_args(Some(&json!("null"))),
            Some(Value::Null)
        );
        assert_eq!(
            map_function_call_args(Some(&json!({ "a": 1 }))),
            Some(json!({ "a": 1 }))
        );
        assert_eq!(map_function_call_args(Some(&json!([1]))), Some(json!([1])));
        assert_eq!(map_function_call_args(Some(&json!(7))), None);
        assert_eq!(map_function_call_args(None), None);
    }

    #[test]
    fn function_calls_skip_arrays_and_nameless_entries() {
        let output = json!([
            [{ "type": "function_call", "name": "ignored" }],
            { "type": "function_call", "name": "   " },
            {
                "type": "function_call",
                "name": " lookup ",
                "arguments": "{\"q\":\"x\"}"
            }
        ]);
        let calls = extract_function_calls_from_codex_output(Some(&output));
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "lookup");
        assert_eq!(calls[0].args, Some(json!({ "q": "x" })));
    }

    /// The deduplication key is the name plus the serialised arguments.
    #[test]
    fn append_unique_function_calls_deduplicates_by_name_and_arguments() {
        let mut target = Vec::new();
        append_unique_function_calls(
            &mut target,
            vec![GatewayFunctionCall {
                name: "f".to_string(),
                args: None,
            }],
        );
        append_unique_function_calls(
            &mut target,
            vec![
                GatewayFunctionCall {
                    name: "f".to_string(),
                    args: None,
                },
                GatewayFunctionCall {
                    name: "f".to_string(),
                    args: Some(Value::Null),
                },
                GatewayFunctionCall {
                    name: "f".to_string(),
                    args: Some(json!({ "a": 1 })),
                },
            ],
        );
        // `f` without arguments and `f` with `null` share the key `f::null`.
        assert_eq!(target.len(), 2);
        assert_eq!(target[0].args, None);
        assert_eq!(target[1].args, Some(json!({ "a": 1 })));
    }

    #[test]
    fn usage_needs_at_least_one_token_field() {
        assert_eq!(map_codex_usage(None), None);
        assert_eq!(map_codex_usage(Some(&json!({}))), None);
        assert_eq!(map_codex_usage(Some(&json!([]))), None);
    }

    /// The usage payload of `openai-codex-models.test.ts:96`.
    #[test]
    fn usage_without_cache_details_maps_the_raw_counts() {
        let usage = map_codex_usage(Some(&json!({
            "input_tokens": 2,
            "output_tokens": 1,
            "total_tokens": 3
        })))
        .expect("usage");
        assert_eq!(usage.prompt_tokens, 2);
        assert_eq!(usage.completion_tokens, 1);
        assert_eq!(usage.total_tokens, 3);
    }

    /// `input_tokens_details.cached_tokens` is removed from `input_tokens`.
    #[test]
    fn usage_subtracts_the_cached_tokens() {
        let usage = map_codex_usage(Some(&json!({
            "input_tokens": 10,
            "output_tokens": 4,
            "input_tokens_details": { "cached_tokens": 3 }
        })))
        .expect("usage");
        assert_eq!(usage.prompt_tokens, 7);
        assert_eq!(usage.completion_tokens, 4);
        assert_eq!(usage.total_tokens, 11);
    }

    /// An explicit `total_tokens` wins over the computed sum, and a negative
    /// difference is floored at zero.
    #[test]
    fn usage_keeps_an_explicit_total_and_floors_at_zero() {
        let usage = map_codex_usage(Some(&json!({
            "input_tokens": 2,
            "output_tokens": 1,
            "total_tokens": 99,
            "input_tokens_details": { "cached_tokens": 8 }
        })))
        .expect("usage");
        assert_eq!(usage.prompt_tokens, 0);
        assert_eq!(usage.completion_tokens, 1);
        assert_eq!(usage.total_tokens, 99);
    }
}
