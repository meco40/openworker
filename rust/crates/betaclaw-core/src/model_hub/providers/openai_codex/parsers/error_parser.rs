//! Port of `src/server/model-hub/Models/openai-codex/parsers/errorParser.ts`.
//!
//! Both functions answer a different question than the shared
//! `parseErrorMessage` of `Models/shared/http.ts`: [`to_codex_stream_error`]
//! reads an SSE event, [`parse_codex_http_error`] reads a raw body without
//! looking at the content type.

use serde_json::Value;

use super::super::types::CodexSseEvent;
use super::super::utils::to_non_empty_string;

/// `toCodexStreamError` from `errorParser.ts:4-12`.
///
/// The precedence is `message`, then `error.message`, then `code` — each one
/// trimmed and skipped when empty. The caller has already read `event.type`,
/// so a `null` payload has thrown before this runs; here the fields are read
/// tolerantly and report `None`.
pub fn to_codex_stream_error(event: &CodexSseEvent) -> Option<String> {
    let explicit = to_non_empty_string(event.value().get("message"));
    if explicit.is_some() {
        return explicit;
    }
    let nested = to_non_empty_string(
        event
            .value()
            .get("error")
            .and_then(|error| error.get("message")),
    );
    if nested.is_some() {
        return nested;
    }
    to_non_empty_string(event.value().get("code"))
}

/// `parseCodexHttpError` from `errorParser.ts:14-41`.
///
/// An empty body yields `` HTTP {status} ``. A JSON body is read for
/// `error` (string), `error.message`, `message` and `detail`, in that order;
/// anything else — an unparsable body, a non-object body, or an object without
/// those keys — falls back to the trimmed raw text.
///
/// A body of literal `null` makes the TypeScript raise a `TypeError` on
/// `parsed.error`, which its own `catch` swallows, so the result is the raw
/// text; reading the non-object case as "no keys" is the same outcome.
pub fn parse_codex_http_error(raw: &str, status: u16) -> String {
    if raw.trim().is_empty() {
        return format!("HTTP {status}");
    }

    if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(raw) {
        if let Some(error) = parsed
            .get("error")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|error| !error.is_empty())
        {
            return error.to_string();
        }
        if let Some(message) = parsed
            .get("error")
            .filter(|error| error.is_object())
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|message| !message.is_empty())
        {
            return message.to_string();
        }
        for key in ["message", "detail"] {
            if let Some(text) = parsed
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                return text.to_string();
            }
        }
    }

    raw.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(value: Value) -> CodexSseEvent {
        CodexSseEvent::new(value)
    }

    #[test]
    fn the_top_level_message_wins() {
        assert_eq!(
            to_codex_stream_error(&event(json!({
                "message": "  boom  ",
                "error": { "message": "nested" },
                "code": "code"
            }))),
            Some("boom".to_string())
        );
    }

    #[test]
    fn the_nested_message_wins_over_the_code() {
        assert_eq!(
            to_codex_stream_error(&event(json!({
                "message": "   ",
                "error": { "message": " nested " },
                "code": "code"
            }))),
            Some("nested".to_string())
        );
        assert_eq!(
            to_codex_stream_error(&event(json!({ "error": "not-an-object", "code": "code" }))),
            Some("code".to_string())
        );
    }

    #[test]
    fn an_event_without_error_fields_has_no_message() {
        assert_eq!(
            to_codex_stream_error(&event(json!({ "type": "response.failed" }))),
            None
        );
        assert_eq!(to_codex_stream_error(&event(json!({ "code": 500 }))), None);
    }

    #[test]
    fn an_empty_http_body_reports_the_status() {
        assert_eq!(parse_codex_http_error("", 429), "HTTP 429");
        assert_eq!(parse_codex_http_error("   \n ", 500), "HTTP 500");
    }

    #[test]
    fn the_error_key_precedence_is_string_object_message_detail() {
        assert_eq!(
            parse_codex_http_error(r#"{"error":"quota","detail":"detail"}"#, 429),
            "quota"
        );
        assert_eq!(
            parse_codex_http_error(r#"{"error":{"message":"nested"},"message":"top"}"#, 500),
            "nested"
        );
        assert_eq!(
            parse_codex_http_error(r#"{"error":{"code":"x"},"message":"top"}"#, 500),
            "top"
        );
        assert_eq!(
            parse_codex_http_error(r#"{"detail":"detail"}"#, 500),
            "detail"
        );
    }

    #[test]
    fn an_unreadable_body_falls_back_to_the_raw_text() {
        assert_eq!(parse_codex_http_error("not json", 500), "not json");
        assert_eq!(
            parse_codex_http_error(r#"{"error":{}}"#, 500),
            r#"{"error":{}}"#
        );
        assert_eq!(parse_codex_http_error("null", 500), "null");
        assert_eq!(parse_codex_http_error("42", 500), "42");
        assert_eq!(parse_codex_http_error("  spaced  ", 500), "spaced");
    }
}
