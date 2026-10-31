//! Port of `src/server/model-hub/Models/openai-codex/parsers/sseParser.ts`.
//!
//! The TypeScript reads `response.body` through `getReader()` and keeps the
//! incomplete tail in a `buffer` between reads. [`CodexSseAccumulator`]
//! reproduces that loop push by push, so [`parse_codex_sse_response`] can fold a
//! whole buffered body in one go while a future streaming transport can feed
//! chunks. Both entry points are the same state machine.
//!
//! Three behaviours of the loop are worth naming, because they are visible:
//!
//! - **The residual tail is error-only.** `sseParser.ts:147-162` re-parses
//!   whatever is left after the last `\n\n` and only reacts to `error` and
//!   `response.failed`. A final `response.output_text.delta` without its blank
//!   line is therefore *dropped*, and its text never reaches the result. The
//!   chunking of the stream cannot change that: the residual is everything after
//!   the last `\n\n` in the payload, whatever the read boundaries were.
//! - **`deltas.length` counts events, not characters.** `sseParser.ts:116` and
//!   `:140` ask whether *any* delta event arrived, even an empty one, which is
//!   what the `delta_count` field tracks. The concatenation is trimmed only at
//!   the very end (`:164`), so whitespace inside a delta survives — that is what
//!   `openai-codex-models.test.ts:154-200` pins.
//! - **`JSON.parse('null')` throws on the first property read.** A `data: null`
//!   line reaches `toNonEmptyString(event.type)` and raises a `TypeError`, so
//!   the parse fails rather than skipping the event ([`CodexSseEvent::property`]).
//! - **The fixture of `openai-codex-models.test.ts` exercises exactly that
//!   residual path.** Its body ends with one `\n`, so the `response.completed`
//!   block never reaches the folding path and the fixture's `model` and `usage`
//!   are dropped — which is why the TypeScript test never asserts them.
//!
//! # Seam difference
//!
//! `sseParser.ts:48-50` throws `'OpenAI Codex response stream was empty.'` when
//! `response.body` is `null`. The injected
//! [`HttpResponse`](crate::model_hub::http::HttpResponse) has no `body === null`
//! state — a bodyless response arrives as an empty `String` — so that branch has
//! no counterpart here. A `200` with an empty stream is the same in both
//! languages: no events, `text: ''`.

use serde_json::Value;

use super::super::types::{CodexError, CodexSseEvent};
use super::super::utils::{to_non_empty_string, to_string_or_null};
use super::error_parser::to_codex_stream_error;
use super::response_parser::{
    append_unique_function_calls, extract_function_calls_from_codex_output,
    extract_text_from_codex_output, map_codex_usage, map_function_call_args, message_item_text,
};
use crate::model_hub::types::{GatewayFunctionCall, GatewayUsage};

/// `'[DONE]'` — the legacy SSE terminator, skipped by
/// `sseParser.ts:27`.
const SSE_DONE_MARKER: &str = "[DONE]";

/// `'OpenAI Codex stream failed.'` from `sseParser.ts:77`.
pub const STREAM_FAILED: &str = "OpenAI Codex stream failed.";
/// `'OpenAI Codex response failed.'` from `sseParser.ts:84`.
pub const RESPONSE_FAILED: &str = "OpenAI Codex response failed.";

/// `parseSseEvents` from `sseParser.ts:13-37`.
///
/// Blocks are split on `\n\n` after dropping every `\r`; a block contributes
/// the `data:` lines only, trimmed, joined with `\n` and trimmed again. An empty
/// payload, the `[DONE]` marker and anything `JSON.parse` rejects are skipped,
/// so the caller sees only the events that parsed.
pub fn parse_sse_events(chunk: &str) -> Vec<CodexSseEvent> {
    let normalized = chunk.replace('\r', "");
    let mut events: Vec<CodexSseEvent> = Vec::new();

    for entry in normalized.split("\n\n") {
        if entry.trim().is_empty() {
            continue;
        }
        let data_lines: Vec<&str> = entry
            .split('\n')
            .map(str::trim)
            .filter(|line| line.starts_with("data:"))
            .map(|line| line["data:".len()..].trim())
            .collect();
        if data_lines.is_empty() {
            continue;
        }
        let payload = data_lines.join("\n").trim().to_string();
        if payload.is_empty() || payload == SSE_DONE_MARKER {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(&payload) {
            events.push(CodexSseEvent::new(parsed));
        }
    }

    events
}

/// Return value of `parseCodexSseResponse` (`sseParser.ts:39-47`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CodexStreamParseResult {
    pub text: String,
    /// `response.model` of the last `response.completed` event that carried one.
    pub model: Option<String>,
    pub usage: Option<GatewayUsage>,
    /// `undefined` when no call was seen, matching `:169`.
    pub function_calls: Option<Vec<GatewayFunctionCall>>,
}

/// `event.type` through [`to_non_empty_string`], which is also the first
/// property read and therefore the point where a `null` payload throws.
fn event_type(event: &CodexSseEvent) -> Result<Option<String>, CodexError> {
    Ok(to_non_empty_string(event.property("type")?))
}

/// `toCodexStreamError(event) || 'OpenAI Codex stream failed.'` (`:77`).
fn error_event_message(event: &CodexSseEvent) -> String {
    to_codex_stream_error(event).unwrap_or_else(|| STREAM_FAILED.to_string())
}

/// The `response.failed` precedence of `:80-86`.
fn failed_event_message(event: &CodexSseEvent) -> String {
    let nested = to_non_empty_string(
        event
            .value()
            .get("response")
            .and_then(|response| response.get("error"))
            .and_then(|error| error.get("message")),
    );
    nested
        .or_else(|| to_codex_stream_error(event))
        .unwrap_or_else(|| RESPONSE_FAILED.to_string())
}

/// The incremental state machine of `parseCodexSseResponse`
/// (`sseParser.ts:52-145`).
#[derive(Debug, Default)]
pub struct CodexSseAccumulator {
    buffer: String,
    deltas: String,
    delta_count: usize,
    fallback_text: String,
    model: Option<String>,
    usage: Option<GatewayUsage>,
    function_calls: Vec<GatewayFunctionCall>,
}

impl CodexSseAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends one chunk and folds every `\n\n`-terminated block.
    ///
    /// Returns the error the TypeScript would have thrown, which aborts the
    /// whole parse.
    pub fn push(
        &mut self,
        chunk: &str,
        mut on_delta: Option<&mut dyn FnMut(&str)>,
    ) -> Result<(), CodexError> {
        self.append(chunk, &mut on_delta)
    }

    /// Folds the residual block and produces the result.
    ///
    /// There is no delta sink here on purpose: `sseParser.ts:147-162` looks for
    /// the two failure events only, so nothing in the residual is ever streamed.
    pub fn finish(&mut self) -> Result<CodexStreamParseResult, CodexError> {
        if !self.buffer.trim().is_empty() {
            let residual = std::mem::take(&mut self.buffer);
            for event in parse_sse_events(&residual) {
                match event_type(&event)?.as_deref() {
                    Some("error") => return Err(CodexError::new(error_event_message(&event))),
                    Some("response.failed") => {
                        return Err(CodexError::new(failed_event_message(&event)))
                    }
                    _ => {}
                }
            }
        }
        Ok(self.result())
    }

    /// [`CodexSseAccumulator::push`] behind a borrowed sink.
    ///
    /// Rust cannot reborrow a `&mut dyn FnMut` out of an `Option` and hand it to
    /// two successive calls, so the sink travels as `&mut Option<_>` — the same
    /// shape `openai_compatible::response::SseAccumulator` uses.
    fn append(
        &mut self,
        chunk: &str,
        on_delta: &mut Option<&mut dyn FnMut(&str)>,
    ) -> Result<(), CodexError> {
        self.buffer.push_str(chunk);
        while let Some(boundary) = self.buffer.find("\n\n") {
            let block: String = self.buffer[..boundary].to_string();
            self.buffer = self.buffer[boundary + 2..].to_string();
            self.process_block(&block, on_delta)?;
        }
        Ok(())
    }

    /// The per-event dispatch of `sseParser.ts:72-144`.
    fn process_block(
        &mut self,
        block: &str,
        on_delta: &mut Option<&mut dyn FnMut(&str)>,
    ) -> Result<(), CodexError> {
        for event in parse_sse_events(block) {
            let Some(event_type) = event_type(&event)? else {
                continue;
            };

            match event_type.as_str() {
                "error" => return Err(CodexError::new(error_event_message(&event))),
                "response.failed" => return Err(CodexError::new(failed_event_message(&event))),
                "response.output_text.delta" | "response.refusal.delta" => {
                    if let Some(delta) = to_string_or_null(event.value().get("delta")) {
                        self.deltas.push_str(&delta);
                        self.delta_count += 1;
                        if let Some(callback) = on_delta.as_deref_mut() {
                            callback(&delta);
                        }
                    }
                }
                "response.output_item.done" => self.process_item_done(&event),
                "response.completed" | "response.done" => self.process_response_done(&event),
                _ => {}
            }
        }
        Ok(())
    }

    /// `sseParser.ts:96-129`.
    ///
    /// A `function_call` item is recorded and ends the iteration; a `message`
    /// item only becomes the fallback text while no delta has been seen yet.
    fn process_item_done(&mut self, event: &CodexSseEvent) {
        let Some(item) = event.value().get("item") else {
            return;
        };
        // `!item || typeof item !== 'object'` — an array passes this guard.
        if !(item.is_object() || item.is_array()) {
            return;
        }

        if item.get("type").and_then(Value::as_str) == Some("function_call") {
            if let Some(name) = to_non_empty_string(item.get("name")) {
                append_unique_function_calls(
                    &mut self.function_calls,
                    vec![GatewayFunctionCall {
                        name,
                        args: map_function_call_args(item.get("arguments")),
                    }],
                );
            }
            return;
        }

        if self.delta_count > 0 || !self.fallback_text.is_empty() {
            return;
        }
        self.fallback_text = message_item_text(item).trim().to_string();
    }

    /// `sseParser.ts:131-143`.
    fn process_response_done(&mut self, event: &CodexSseEvent) {
        let response = event.value().get("response");

        if let Some(model) = to_non_empty_string(response.and_then(|value| value.get("model"))) {
            self.model = Some(model);
        }
        let usage = map_codex_usage(response.and_then(|value| value.get("usage")));
        if usage.is_some() {
            self.usage = usage;
        }

        append_unique_function_calls(
            &mut self.function_calls,
            extract_function_calls_from_codex_output(
                response.and_then(|value| value.get("output")),
            ),
        );

        if self.delta_count == 0 && self.fallback_text.is_empty() {
            self.fallback_text =
                extract_text_from_codex_output(response.and_then(|value| value.get("output")));
        }
    }

    /// `sseParser.ts:164-170`: the joined deltas are trimmed, and the fallback
    /// text stands in when nothing was streamed.
    fn result(&self) -> CodexStreamParseResult {
        let joined = self.deltas.trim();
        let text = if joined.is_empty() {
            self.fallback_text.clone()
        } else {
            joined.to_string()
        };

        CodexStreamParseResult {
            text,
            model: self.model.clone(),
            usage: self.usage,
            function_calls: (!self.function_calls.is_empty()).then(|| self.function_calls.clone()),
        }
    }
}

/// `parseCodexSseResponse(response, onStreamDelta)` for an already-buffered
/// body.
pub fn parse_codex_sse_response(
    body: &str,
    mut on_stream_delta: Option<&mut dyn FnMut(&str)>,
) -> Result<CodexStreamParseResult, CodexError> {
    let mut accumulator = CodexSseAccumulator::new();
    accumulator.append(body, &mut on_stream_delta)?;
    accumulator.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The fixture of `openai-codex-models.test.ts:93-98`:
    /// `['data: …', '', 'data: …', ''].join('\n')`.
    const DELTA_THEN_COMPLETED: &str = concat!(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",",
        "\"model\":\"gpt-5.3-codex\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1,",
        "\"total_tokens\":3}}}\n"
    );

    fn parse(body: &str) -> Result<CodexStreamParseResult, CodexError> {
        parse_codex_sse_response(body, None)
    }

    fn parse_with_deltas(body: &str) -> (Result<CodexStreamParseResult, CodexError>, Vec<String>) {
        let mut deltas: Vec<String> = Vec::new();
        let mut sink = |delta: &str| deltas.push(delta.to_string());
        let result = parse_codex_sse_response(body, Some(&mut sink));
        (result, deltas)
    }

    /// Splits a decoded body into chunks of `size` characters.
    fn split_by_chars(text: &str, size: usize) -> Vec<String> {
        let chars: Vec<char> = text.chars().collect();
        chars
            .chunks(size)
            .map(|chunk| chunk.iter().collect())
            .collect()
    }

    fn parse_in_chunks(
        body: &str,
        size: usize,
    ) -> (Result<CodexStreamParseResult, CodexError>, Vec<String>) {
        let mut accumulator = CodexSseAccumulator::new();
        let mut deltas: Vec<String> = Vec::new();
        let mut sink = |delta: &str| deltas.push(delta.to_string());
        let mut failure: Option<CodexError> = None;
        for chunk in split_by_chars(body, size) {
            if let Err(error) = accumulator.push(&chunk, Some(&mut sink)) {
                failure = Some(error);
                break;
            }
        }
        let result = match failure {
            Some(error) => Err(error),
            None => accumulator.finish(),
        };
        (result, deltas)
    }

    /// `parseSseEvents`: only `data:` lines count, `[DONE]` and unparsable
    /// payloads are skipped, `\r` is dropped, and two `data:` lines in one block
    /// are joined with `\n` — which makes the payload invalid JSON here.
    #[test]
    fn sse_events_follow_the_typescript_filters() {
        let body = concat!(
            ": comment\n\n",
            "event: ping\n\n",
            "data:\n\n",
            "data: [DONE]\n\n",
            "data: {not json}\n\n",
            "data: {\"a\":1}\ndata: {\"b\":2}\n\n",
            "data: {\"type\":\"response.completed\"}\r\n\r\n"
        );
        let events = parse_sse_events(body);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].value(), &json!({ "type": "response.completed" }));
    }

    /// The fixture body of `openai-codex-models.test.ts:90-152`:
    /// `['data: …', '', 'data: …', ''].join('\n')` ends with a *single* `\n`, so
    /// the `response.completed` block is the residual tail and
    /// `sseParser.ts:147-162` never folds it — its model and usage are dropped.
    /// That is why the TypeScript test asserts the text, the URL, the headers
    /// and the absent `temperature`, but nothing about the model or the usage.
    #[test]
    fn the_typescript_fixture_parses_into_text_model_and_usage() {
        let result = parse(DELTA_THEN_COMPLETED).expect("parsed");
        assert_eq!(result.text, "hello");
        assert_eq!(result.model, None);
        assert_eq!(result.usage, None);
        assert_eq!(result.function_calls, None);
    }

    /// The same events with a terminated final block do surface the model, the
    /// usage and the calls.
    #[test]
    fn a_terminated_completed_block_supplies_model_and_usage() {
        let result = parse(&format!("{DELTA_THEN_COMPLETED}\n")).expect("parsed");
        assert_eq!(result.text, "hello");
        assert_eq!(result.model.as_deref(), Some("gpt-5.3-codex"));
        assert_eq!(
            result.usage,
            Some(GatewayUsage {
                prompt_tokens: 2,
                completion_tokens: 1,
                total_tokens: 3,
            })
        );
    }

    /// The fixture body of `openai-codex-models.test.ts:154-200`.
    #[test]
    fn whitespace_survives_across_deltas_and_every_delta_is_streamed() {
        let body = concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Ich\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\" bin\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\" ein Modell\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",",
            "\"model\":\"gpt-5.3-codex\"}}\n"
        );
        let (result, deltas) = parse_with_deltas(body);
        let result = result.expect("parsed");
        assert_eq!(result.text, "Ich bin ein Modell");
        assert_eq!(deltas, vec!["Ich", " bin", " ein Modell"]);
        assert_eq!(result.usage, None);
    }

    /// The result must not depend on where the transport happens to split the
    /// stream: every chunk size yields the same text, model, usage, calls and
    /// delta sequence — including splits inside `data:`, inside the JSON and
    /// between the two `\n` of a block separator.
    #[test]
    fn chunking_across_any_boundary_yields_the_same_result() {
        let body = DELTA_THEN_COMPLETED;
        let expected = parse_with_deltas(body);
        let char_count = body.chars().count();
        for size in 1..=char_count {
            assert_eq!(
                parse_in_chunks(body, size),
                expected,
                "chunk size {size} changed the result"
            );
        }
    }

    /// The same for a body with a refusal delta, a tool call and a residual
    /// block that never ends in a blank line.
    #[test]
    fn chunking_across_any_boundary_covers_tool_calls_and_the_tail() {
        let body = concat!(
            "data: {\"type\":\"response.refusal.delta\",\"delta\":\"no\"}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",",
            "\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\\\"x\\\"}\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",",
            "\"content\":[{\"type\":\"output_text\",\"text\":\"ignored\"}]}]}}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"lost\"}"
        );
        let expected = parse_with_deltas(body);
        let parsed = expected.0.as_ref().expect("parsed");
        assert_eq!(parsed.text, "no");
        assert_eq!(parsed.function_calls.as_ref().expect("calls").len(), 1);
        // The unterminated trailing delta is dropped by the error-only residual
        // fold, so the callback never sees its text.
        assert_eq!(expected.1, vec!["no"]);

        let char_count = body.chars().count();
        for size in 1..=char_count {
            assert_eq!(
                parse_in_chunks(body, size),
                expected,
                "chunk size {size} changed the result"
            );
        }
    }

    /// `sseParser.ts:147-162`: the residual block only reports the two failure
    /// events.
    #[test]
    fn the_residual_block_is_error_only() {
        let dropped = parse("data: {\"type\":\"response.output_text.delta\",\"delta\":\"lost\"}")
            .expect("parsed");
        assert_eq!(dropped.text, "");
        assert_eq!(dropped.function_calls, None);

        let error = parse(concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"kept\"}\n\n",
            "data: {\"type\":\"error\",\"message\":\"late failure\"}"
        ))
        .expect_err("residual error");
        assert_eq!(error.message, "late failure");

        let failed = parse("data: {\"type\":\"response.failed\",\"code\":\"late\"}")
            .expect_err("residual failure");
        assert_eq!(failed.message, "late");
    }

    /// A `type: error` event throws its message, then its code, then the
    /// generic text.
    #[test]
    fn error_events_abort_the_parse() {
        let error =
            parse("data: {\"type\":\"error\",\"message\":\"boom\"}\n\n").expect_err("error");
        assert_eq!(error.message, "boom");

        let coded =
            parse("data: {\"type\":\"error\",\"code\":\"rate_limited\"}\n\n").expect_err("error");
        assert_eq!(coded.message, "rate_limited");

        let bare = parse("data: {\"type\":\"error\"}\n\n").expect_err("error");
        assert_eq!(bare.message, STREAM_FAILED);
    }

    /// `response.failed` prefers `response.error.message` over the event's own
    /// message and code.
    #[test]
    fn response_failed_prefers_the_nested_message() {
        let nested = parse(concat!(
            "data: {\"type\":\"response.failed\",\"message\":\"outer\",\"response\":{",
            "\"error\":{\"message\":\"inner\"}}}\n\n"
        ))
        .expect_err("failed");
        assert_eq!(nested.message, "inner");

        let outer = parse("data: {\"type\":\"response.failed\",\"message\":\"outer\"}\n\n")
            .expect_err("failed");
        assert_eq!(outer.message, "outer");

        let bare = parse("data: {\"type\":\"response.failed\"}\n\n").expect_err("failed");
        assert_eq!(bare.message, RESPONSE_FAILED);
    }

    /// A `function_call` item becomes a function call and a repeated event is
    /// dropped by the shared deduplication.
    #[test]
    fn function_call_items_are_recorded_once() {
        let block = concat!(
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",",
            "\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\\\"x\\\"}\"}}"
        );
        let body = format!("{block}\n\n{block}\n\ndata: {{\"type\":\"response.completed\"}}\n\n");

        let result = parse(&body).expect("parsed");
        let calls = result.function_calls.expect("calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "lookup");
        assert_eq!(calls[0].args, Some(json!({ "q": "x" })));
        assert_eq!(result.text, "");
    }

    /// `response.completed` supplies the text when nothing was streamed, and a
    /// `message` item does the same for `response.output_item.done`.
    #[test]
    fn the_fallback_text_comes_from_the_completed_payload() {
        let completed = parse(concat!(
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",",
            "\"content\":[{\"type\":\"output_text\",\"text\":\" from output \"}]}]}}\n\n"
        ))
        .expect("parsed");
        assert_eq!(completed.text, "from output");

        let item_done = parse(concat!(
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",",
            "\"content\":[{\"type\":\"output_text\",\"text\":\" from item \"}]}}\n\n"
        ))
        .expect("parsed");
        assert_eq!(item_done.text, "from item");

        // A streamed delta wins over the payload text.
        let streamed = parse(concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"streamed\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",",
            "\"content\":[{\"type\":\"output_text\",\"text\":\"ignored\"}]}]}}\n\n"
        ))
        .expect("parsed");
        assert_eq!(streamed.text, "streamed");
    }

    /// `deltas.length` counts events: an empty delta already blocks the
    /// fallback, and a non-string `delta` does not count at all.
    #[test]
    fn the_delta_count_gates_the_fallback_on_events_not_characters() {
        let empty_delta = parse(concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"\"}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",",
            "\"content\":[{\"type\":\"output_text\",\"text\":\"ignored\"}]}}\n\n"
        ))
        .expect("parsed");
        assert_eq!(empty_delta.text, "");

        let numeric_delta = parse(concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":5}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",",
            "\"content\":[{\"type\":\"output_text\",\"text\":\"kept\"}]}}\n\n"
        ))
        .expect("parsed");
        assert_eq!(numeric_delta.text, "kept");
    }

    /// `JSON.parse('null')` reaches the parser and the first property read
    /// raises the Node `TypeError`.
    #[test]
    fn a_null_event_fails_like_the_typescript() {
        let error = parse("data: null\n\n").expect_err("null event");
        assert_eq!(
            error.message,
            "Cannot read properties of null (reading 'type')"
        );
    }
}
