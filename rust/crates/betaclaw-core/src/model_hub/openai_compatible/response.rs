//! Port of `src/server/model-hub/Models/shared/openai-compatible/response/`:
//! `parse.ts`, `error.ts` and `stream.ts`.
//!
//! The parsers are deliberately shape-agnostic: TypeScript walks the response with
//! optional chaining and `typeof` guards, so every field is treated as
//! `serde_json::Value` and the guards are reproduced with `is_object`/`as_str`
//! checks. That keeps behaviour identical for a provider that returns an
//! unexpected type instead of silently skipping it.

use std::collections::BTreeMap;

use serde_json::Value;

use super::constants::{SSE_DATA_PREFIX, SSE_DONE_MARKER};
use super::utils::strip_thinking_blocks;
use crate::model_hub::types::{
    GatewayFunctionCall, GatewayResponse, GatewayUsage, RateLimitSnapshot,
};

// ─── response/parse.ts ─────────────────────────────────────────────────────

/// `mapUsage` from `response/parse.ts:62-71`.
///
/// `usage.prompt_tokens ?? 0` only substitutes for `null`/`undefined`, so a
/// non-number value would be forwarded as-is in TypeScript. A non-number cannot
/// be placed in [`GatewayUsage`], so it falls back to 0 here.
fn map_usage(usage: Option<&Value>) -> Option<GatewayUsage> {
    let usage = usage?;
    Some(GatewayUsage {
        prompt_tokens: usage
            .get("prompt_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        completion_tokens: usage
            .get("completion_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        total_tokens: usage
            .get("total_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    })
}

/// `mapToolCalls` from `response/parse.ts:10-39`.
///
/// A call without a trimmed `function.name` is dropped. A string `arguments` is
/// parsed as JSON, and a parse failure keeps the raw text under `{ raw }` — the
/// same fallback the streaming path uses.
fn map_tool_calls(tool_calls: Option<&Value>) -> Vec<GatewayFunctionCall> {
    let Some(items) = tool_calls.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|tool_call| {
            let name = tool_call
                .get("function")
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())?;
            Some(GatewayFunctionCall {
                name: name.to_string(),
                args: parse_tool_arguments(
                    tool_call.get("function").and_then(|f| f.get("arguments")),
                ),
            })
        })
        .collect()
}

/// `JSON.parse(rawArgs)` with the `{ raw: rawArgs }` fallback, shared by the
/// tool-call and legacy function-call paths (`parse.ts:25-38` and `:49-58`).
fn parse_tool_arguments(raw_args: Option<&Value>) -> Option<Value> {
    match raw_args? {
        Value::String(text) => Some(
            serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::Object(raw_object(text))),
        ),
        value if value.is_object() => Some(value.clone()),
        _ => None,
    }
}

fn raw_object(raw: &str) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert("raw".to_string(), Value::from(raw));
    map
}

/// `mapLegacyFunctionCall` from `response/parse.ts:41-60`.
fn map_legacy_function_call(function_call: Option<&Value>) -> Option<GatewayFunctionCall> {
    let function_call = function_call?;
    // A call without a trimmed `function.name` is dropped.
    let name = function_call
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    Some(GatewayFunctionCall {
        name: name.to_string(),
        args: parse_tool_arguments(function_call.get("arguments")),
    })
}

/// `parseChatResponse` from `response/parse.ts:73-103`.
///
/// `functionCalls` is `undefined` rather than an empty array when nothing was
/// mapped, so the JSON key is absent.
pub fn parse_chat_response(
    json: &Value,
    request_model: &str,
    provider_id: &str,
) -> GatewayResponse {
    let message = json
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"));

    let mut text = message
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    text = strip_thinking_blocks(&text);

    let mut mapped_tool_calls = message
        .and_then(|message| message.get("tool_calls"))
        .map(|tool_calls| map_tool_calls(Some(tool_calls)))
        .unwrap_or_default();

    if mapped_tool_calls.is_empty() {
        if let Some(legacy) = message
            .and_then(|message| message.get("function_call"))
            .and_then(|function_call| map_legacy_function_call(Some(function_call)))
        {
            mapped_tool_calls.push(legacy);
        }
    }

    GatewayResponse {
        ok: true,
        text,
        model: json
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(request_model)
            .to_string(),
        provider: provider_id.to_string(),
        usage: map_usage(json.get("usage")),
        function_calls: (!mapped_tool_calls.is_empty()).then_some(mapped_tool_calls),
        rate_limits: None,
        error: None,
    }
}

// ─── response/error.ts ─────────────────────────────────────────────────────

/// `parseErrorResponse` from `response/error.ts:4-32`.
///
/// The `errorText || `HTTP ${status}`` fallback is a `||`, so an empty body — and
/// an `error` field that is the empty string — both yield `HTTP <status>`.
pub fn parse_error_response(
    status: u16,
    error_text: &str,
    request_model: &str,
    provider_id: &str,
) -> GatewayResponse {
    let fallback = || {
        if error_text.is_empty() {
            format!("HTTP {status}")
        } else {
            error_text.to_string()
        }
    };

    let error_message = match serde_json::from_str::<Value>(error_text) {
        Ok(json) => {
            if let Some(error) = json.get("error") {
                if let Some(text) = error.as_str() {
                    text.to_string()
                } else if let Some(text) = error.get("message").and_then(Value::as_str) {
                    text.to_string()
                } else {
                    fallback()
                }
            } else {
                fallback()
            }
        }
        Err(_) => fallback(),
    };

    GatewayResponse::failure(request_model, provider_id, error_message)
}

/// `createErrorResponse` from `response/error.ts:34-47`.
pub fn create_error_response(
    message: &str,
    request_model: &str,
    provider_id: &str,
) -> GatewayResponse {
    GatewayResponse::failure(request_model, provider_id, message)
}

// ─── response/stream.ts ────────────────────────────────────────────────────

/// `extractSsePayloads` from `response/stream.ts:5-17`.
///
/// Every `data:` line of one event block is trimmed and joined with a newline, so
/// a block always yields zero or one payload.
pub fn extract_sse_payloads(raw_event_block: &str) -> Vec<String> {
    let data_lines: Vec<String> = raw_event_block
        .split('\n')
        .map(|line| line.trim())
        .filter(|line| line.starts_with(SSE_DATA_PREFIX))
        .map(|line| line[SSE_DATA_PREFIX.len()..].trim().to_string())
        .collect();
    if data_lines.is_empty() {
        return Vec::new();
    }
    vec![data_lines.join("\n")]
}

/// `mapStreamUsage` from `response/stream.ts:19-48`.
///
/// Differences from `mapUsage`, and they matter: a non-number or non-finite value
/// becomes 0, a missing `total_tokens` falls back to `prompt + completion`, and
/// every count is clamped at 0.
pub fn map_stream_usage(raw_usage: Option<&Value>) -> Option<GatewayUsage> {
    let raw_usage = raw_usage?;
    if !raw_usage.is_object() {
        return None;
    }
    let finite = |key: &str| -> Option<i64> {
        raw_usage.get(key).and_then(Value::as_i64).filter(|_value| {
            raw_usage
                .get(key)
                .and_then(Value::as_f64)
                .is_some_and(f64::is_finite)
        })
    };
    let prompt = finite("prompt_tokens").unwrap_or(0);
    let completion = finite("completion_tokens").unwrap_or(0);
    let total = finite("total_tokens").unwrap_or_else(|| prompt + completion);
    Some(GatewayUsage {
        prompt_tokens: prompt.max(0),
        completion_tokens: completion.max(0),
        total_tokens: total.max(0),
    })
}

#[derive(Debug, Clone, Default)]
struct ToolCallAccumulator {
    name: String,
    args_buffer: String,
}

/// `parseOpenAICompatibleSseResponse` from `response/stream.ts:55-168`, as a
/// reusable state machine.
///
/// The TypeScript version reads the body incrementally and splits on `\n\n`. This
/// accumulator performs exactly the same split-and-fold, but the caller decides
/// how much text to push at a time, so the gateway can feed it chunk by chunk once
/// the streaming client lands in S4b. Feeding the whole body in one `push` — which
/// is what this slice does — yields the same text, usage and tool calls.
#[derive(Debug, Default)]
pub struct SseAccumulator {
    buffer: String,
    text: String,
    model: Option<String>,
    usage: Option<GatewayUsage>,
    tool_calls_by_index: BTreeMap<i64, ToolCallAccumulator>,
    rate_limits: Option<RateLimitSnapshot>,
}

impl SseAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends a chunk and folds every complete `\n\n`-terminated block.
    pub fn push(&mut self, chunk: &str, mut on_delta: Option<&mut dyn FnMut(&str)>) {
        self.append(chunk, &mut on_delta);
    }

    /// Folds the trailing block, which only exists when the stream did not end
    /// with a blank line.
    pub fn finish(&mut self, mut on_delta: Option<&mut dyn FnMut(&str)>) -> StreamParseResult {
        self.finish_trailing(&mut on_delta)
    }

    /// [`SseAccumulator::push`] behind a borrowed sink.
    ///
    /// Rust cannot reborrow a `&mut dyn FnMut` out of an `Option` and hand it to
    /// two successive calls, so the sink is passed as `&mut Option<_>` instead:
    /// that makes the trait-object lifetime independent of the borrow and lets
    /// one callback survive several folds.
    fn append(&mut self, chunk: &str, on_delta: &mut Option<&mut dyn FnMut(&str)>) {
        self.buffer.push_str(chunk);
        while let Some(boundary) = self.buffer.find("\n\n") {
            let block: String = self.buffer[..boundary].to_string();
            self.buffer = self.buffer[boundary + 2..].to_string();
            self.process_block(&block, on_delta);
        }
    }

    /// [`SseAccumulator::finish`] behind a borrowed sink.
    fn finish_trailing(
        &mut self,
        on_delta: &mut Option<&mut dyn FnMut(&str)>,
    ) -> StreamParseResult {
        if !self.buffer.trim().is_empty() {
            let block = std::mem::take(&mut self.buffer);
            self.process_block(&block, on_delta);
        }
        self.result()
    }

    fn process_block(&mut self, block: &str, on_delta: &mut Option<&mut dyn FnMut(&str)>) {
        for payload in extract_sse_payloads(block) {
            if payload.is_empty() || payload == SSE_DONE_MARKER {
                continue;
            }
            let Ok(chunk) = serde_json::from_str::<Value>(&payload) else {
                continue;
            };
            if !chunk.is_object() {
                continue;
            }

            if let Some(model) = chunk.get("model").and_then(Value::as_str) {
                if !model.trim().is_empty() {
                    self.model = Some(model.trim().to_string());
                }
            }

            if let Some(usage) = map_stream_usage(chunk.get("usage")) {
                self.usage = Some(usage);
            }

            let delta = chunk
                .get("choices")
                .and_then(|choices| choices.get(0))
                .and_then(|choice| choice.get("delta"));

            if let Some(text) = delta
                .and_then(|delta| delta.get("content"))
                .and_then(Value::as_str)
            {
                if !text.is_empty() {
                    self.text.push_str(text);
                    if let Some(callback) = on_delta.as_deref_mut() {
                        callback(text);
                    }
                }
            }

            if let Some(tool_calls) = delta
                .and_then(|delta| delta.get("tool_calls"))
                .and_then(Value::as_array)
            {
                for tool_call in tool_calls {
                    self.accumulate_tool_call(tool_call);
                }
            }
        }
    }

    /// The `toolCallsByIndex` bookkeeping from `response/stream.ts:100-121`. A
    /// missing or non-numeric `index` defaults to 0, which is what makes a
    /// provider that omits the field collapse every call into one.
    fn accumulate_tool_call(&mut self, tool_call: &Value) {
        let index = tool_call
            .get("index")
            .and_then(Value::as_f64)
            .filter(|index| index.is_finite())
            .map(|index| index as i64)
            .unwrap_or(0);

        let accumulator = self.tool_calls_by_index.entry(index).or_default();

        if let Some(name) = tool_call
            .get("function")
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
        {
            if !name.trim().is_empty() {
                accumulator.name = name.trim().to_string();
            }
        }

        if let Some(args) = tool_call
            .get("function")
            .and_then(|function| function.get("arguments"))
            .and_then(Value::as_str)
        {
            if !args.is_empty() {
                accumulator.args_buffer.push_str(args);
            }
        }
    }

    fn result(&self) -> StreamParseResult {
        // `BTreeMap` iteration is already ordered by index, matching the explicit
        // `.sort((a, b) => a[0] - b[0])`.
        let function_calls: Vec<GatewayFunctionCall> = self
            .tool_calls_by_index
            .values()
            .filter_map(|accumulator| {
                let name = accumulator.name.trim();
                if name.is_empty() {
                    return None;
                }
                let raw_args = accumulator.args_buffer.trim();
                let args = if raw_args.is_empty() {
                    None
                } else {
                    Some(
                        serde_json::from_str::<Value>(raw_args)
                            .unwrap_or_else(|_| Value::Object(raw_object(raw_args))),
                    )
                };
                Some(GatewayFunctionCall {
                    name: name.to_string(),
                    args,
                })
            })
            .collect();

        StreamParseResult {
            text: self.text.clone(),
            model: self.model.clone(),
            usage: self.usage,
            function_calls: (!function_calls.is_empty()).then_some(function_calls),
            rate_limits: self.rate_limits.clone(),
        }
    }
}

/// `StreamParseResult` from `openai-compatible/types.ts:3-8`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StreamParseResult {
    pub text: String,
    pub model: Option<String>,
    pub usage: Option<GatewayUsage>,
    pub function_calls: Option<Vec<GatewayFunctionCall>>,
    pub rate_limits: Option<RateLimitSnapshot>,
}

/// `parseOpenAICompatibleSseResponse(response, onDelta)` for an already-buffered
/// body.
///
/// Both folds — the complete blocks and the trailing one — see the same sink,
/// exactly like the single `processBlock` closure in `stream.ts:125-142`.
pub fn parse_openai_compatible_sse_response(
    body: &str,
    mut on_delta: Option<&mut dyn FnMut(&str)>,
) -> StreamParseResult {
    let mut accumulator = SseAccumulator::new();
    accumulator.append(body, &mut on_delta);
    accumulator.finish_trailing(&mut on_delta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_chat_response() {
        let json = serde_json::json!({
            "choices": [{ "message": { "content": "ok" } }],
            "model": "gpt-4o-mini"
        });
        let response = parse_chat_response(&json, "requested", "openai");
        assert!(response.ok);
        assert_eq!(response.text, "ok");
        assert_eq!(response.model, "gpt-4o-mini");
        assert_eq!(response.provider, "openai");
        assert_eq!(response.usage, None);
        assert_eq!(response.function_calls, None);
    }

    /// `json.model ?? requestModel` — a response without a model falls back to
    /// the requested one.
    #[test]
    fn missing_model_falls_back_to_the_requested_model() {
        let json = serde_json::json!({ "choices": [] });
        let response = parse_chat_response(&json, "requested", "kimi");
        assert_eq!(response.text, "");
        assert_eq!(response.model, "requested");
    }

    /// Case 2 of `openai-compatible-tools.test.ts`.
    #[test]
    fn maps_tool_calls_into_function_calls() {
        let json = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{
                        "type": "function",
                        "function": {
                            "name": "safe_files",
                            "arguments": "{\"operation\":\"read\",\"path\":\"README.md\"}"
                        }
                    }]
                }
            }],
            "model": "gpt-4o-mini"
        });
        let response = parse_chat_response(&json, "requested", "openai");
        let calls = response.function_calls.expect("function calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "safe_files");
        assert_eq!(
            calls[0].args.clone().expect("args"),
            serde_json::json!({ "operation": "read", "path": "README.md" })
        );
    }

    /// Unparsable arguments keep the raw text under `{ raw }`.
    #[test]
    fn unparsable_tool_arguments_keep_the_raw_string() {
        let json = serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [{ "function": { "name": "f", "arguments": "{oops" } }]
                }
            }]
        });
        let calls = parse_chat_response(&json, "m", "openai")
            .function_calls
            .expect("function calls");
        assert_eq!(calls[0].args, Some(serde_json::json!({ "raw": "{oops" })));
    }

    /// A call without a name is dropped; object arguments pass through.
    #[test]
    fn nameless_calls_are_dropped_and_object_arguments_pass_through() {
        let json = serde_json::json!({
            "choices": [{
                "message": {
                    "tool_calls": [
                        { "function": { "name": "   " } },
                        { "function": { "name": "keep", "arguments": { "a": 1 } } }
                    ]
                }
            }]
        });
        let calls = parse_chat_response(&json, "m", "openai")
            .function_calls
            .expect("function calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "keep");
        assert_eq!(calls[0].args, Some(serde_json::json!({ "a": 1 })));
    }

    #[test]
    fn maps_the_legacy_function_call_field() {
        let json = serde_json::json!({
            "choices": [{
                "message": {
                    "function_call": { "name": "old_tool", "arguments": "{\"x\":2}" }
                }
            }]
        });
        let calls = parse_chat_response(&json, "m", "openai")
            .function_calls
            .expect("function calls");
        assert_eq!(calls[0].name, "old_tool");
        assert_eq!(calls[0].args, Some(serde_json::json!({ "x": 2 })));
    }

    #[test]
    fn strips_thinking_blocks_from_the_message_text() {
        let json = serde_json::json!({
            "choices": [{ "message": { "content": "a<think>hidden</think>b" } }]
        });
        assert_eq!(parse_chat_response(&json, "m", "openai").text, "ab");
    }

    #[test]
    fn maps_usage_with_defaults() {
        let json = serde_json::json!({
            "choices": [{ "message": { "content": "x" } }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 }
        });
        assert_eq!(
            parse_chat_response(&json, "m", "openai").usage,
            Some(GatewayUsage {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 0
            }),
            "`mapUsage` defaults total_tokens to 0, unlike the streaming variant"
        );
    }

    /// `errorText || `HTTP ${status}`` semantics.
    #[test]
    fn error_response_precedence() {
        assert_eq!(
            parse_error_response(400, r#"{"error":"boom"}"#, "m", "p").error,
            Some("boom".to_string())
        );
        assert_eq!(
            parse_error_response(400, r#"{"error":{"message":"nested"}}"#, "m", "p").error,
            Some("nested".to_string())
        );
        // An `error` that is neither a string nor has a message falls back.
        assert_eq!(
            parse_error_response(400, r#"{"error":{"code":1}}"#, "m", "p").error,
            Some(r#"{"error":{"code":1}}"#.to_string())
        );
        // Empty body.
        assert_eq!(
            parse_error_response(429, "", "m", "p").error,
            Some("HTTP 429".to_string())
        );
        // Not JSON at all.
        assert_eq!(
            parse_error_response(500, "upstream exploded", "m", "p").error,
            Some("upstream exploded".to_string())
        );
        let response = parse_error_response(500, "", "m", "p");
        assert!(!response.ok);
        assert_eq!(response.text, "");
        assert_eq!(response.model, "m");
        assert_eq!(response.provider, "p");
    }

    /// `typeof errorJson.error === 'string'` accepts an empty string, which then
    /// reaches the UI as an empty message rather than as the status fallback.
    #[test]
    fn empty_string_error_is_forwarded_verbatim() {
        assert_eq!(
            parse_error_response(400, r#"{"error":""}"#, "m", "p").error,
            Some(String::new())
        );
    }

    #[test]
    fn extract_sse_payloads_joins_data_lines() {
        // `extractSsePayloads` splits on a single `\n`, so a second block that
        // ends up in the same input is folded into the one payload.
        assert_eq!(
            extract_sse_payloads("data: {\"a\":1}\n\ndata: [ignored]"),
            vec!["{\"a\":1}\n[ignored]".to_string()]
        );
        assert_eq!(extract_sse_payloads("event: ping"), Vec::<String>::new());
        assert_eq!(
            extract_sse_payloads("data:{\"a\":1}"),
            vec!["{\"a\":1}".to_string()]
        );
        assert_eq!(
            extract_sse_payloads("data: {\"a\":1}\ndata: {\"b\":2}"),
            vec!["{\"a\":1}\n{\"b\":2}".to_string()]
        );
    }

    #[test]
    fn stream_usage_derives_the_total_and_clamps() {
        assert_eq!(
            map_stream_usage(Some(&serde_json::json!({
                "prompt_tokens": 3, "completion_tokens": 4
            }))),
            Some(GatewayUsage {
                prompt_tokens: 3,
                completion_tokens: 4,
                total_tokens: 7
            })
        );
        assert_eq!(
            map_stream_usage(Some(&serde_json::json!({
                "prompt_tokens": -5, "completion_tokens": 4, "total_tokens": -1
            }))),
            Some(GatewayUsage {
                prompt_tokens: 0,
                completion_tokens: 4,
                total_tokens: 0
            })
        );
        assert_eq!(map_stream_usage(Some(&Value::Null)), None);
        assert_eq!(map_stream_usage(Some(&Value::from(7))), None);
        assert_eq!(map_stream_usage(None), None);
    }

    #[test]
    fn parses_a_full_sse_stream() {
        let body = concat!(
            "data: {\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: {\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\n",
            "data: [DONE]\n\n"
        );
        let result = parse_openai_compatible_sse_response(body, None);
        assert_eq!(result.text, "Hello");
        assert_eq!(result.model, Some("m".to_string()));
        assert_eq!(
            result.usage,
            Some(GatewayUsage {
                prompt_tokens: 2,
                completion_tokens: 1,
                total_tokens: 3
            })
        );
        assert_eq!(result.function_calls, None);
    }

    /// The streaming tool-call accumulator joins argument fragments per index.
    #[test]
    fn accumulates_streamed_tool_calls() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"p\\\":\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"1}\"}}]}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let calls = parse_openai_compatible_sse_response(body, None)
            .function_calls
            .expect("function calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read");
        assert_eq!(calls[0].args, Some(serde_json::json!({ "p": 1 })));
    }

    /// A provider that omits `index` collapses every fragment into index 0.
    #[test]
    fn missing_tool_call_index_defaults_to_zero() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"function\":{\"name\":\"a\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"function\":{\"name\":\"b\"}}]}}]}\n\n"
        );
        let calls = parse_openai_compatible_sse_response(body, None)
            .function_calls
            .expect("function calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "b", "the later name wins");
    }

    #[test]
    fn streamed_tool_calls_are_sorted_by_index() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":2,\"function\":{\"name\":\"second\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"first\"}}]}}]}\n\n"
        );
        let calls = parse_openai_compatible_sse_response(body, None)
            .function_calls
            .expect("function calls");
        let names: Vec<&str> = calls.iter().map(|call| call.name.as_str()).collect();
        assert_eq!(names, vec!["first", "second"]);
    }

    #[test]
    fn a_trailing_block_without_a_blank_line_is_still_folded() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"tail\"}}]}";
        assert_eq!(
            parse_openai_compatible_sse_response(body, None).text,
            "tail"
        );
    }

    #[test]
    fn unparsable_payloads_are_skipped() {
        let body = "data: not json\n\ndata: [DONE]\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n";
        assert_eq!(parse_openai_compatible_sse_response(body, None).text, "ok");
    }

    #[test]
    fn deltas_are_reported_in_order() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n"
        );
        let mut seen = String::new();
        {
            let mut callback = |delta: &str| seen.push_str(delta);
            let result = parse_openai_compatible_sse_response(body, Some(&mut callback));
            assert_eq!(result.text, "ab");
        }
        assert_eq!(seen, "ab");
    }

    /// Feeding the accumulator one byte at a time must produce the same result as
    /// one big push, which is what makes the incremental client in S4b safe.
    #[test]
    fn incremental_and_batched_parsing_agree() {
        let body = concat!(
            "data: {\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"delta\":{\"content\":\"!\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let batched = parse_openai_compatible_sse_response(body, None);

        let mut accumulator = SseAccumulator::new();
        for chunk in body.split_inclusive('\n') {
            accumulator.push(chunk, None);
        }
        assert_eq!(accumulator.finish(None), batched);
    }

    #[test]
    fn create_error_response_carries_the_message() {
        let response = create_error_response("Network request failed.", "m", "p");
        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("Network request failed."));
        assert_eq!(response.text, "");
    }
}
