//! Port of `src/server/master/execution/runtime/jsonParsing.ts:1-23`.
//!
//! `parseJsonObject` accepts a JSON object only — `null`, arrays and scalars are
//! rejected, and a parse failure returns `None`. `extractJsonObjectFromText`
//! first tries the whole trimmed text, then the span from the first `{` to the
//! last `}`.

use serde_json::Value;

/// `parseJsonObject` — `jsonParsing.ts:1-11`.
pub fn parse_json_object(payload: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(payload) {
        // `!parsed || typeof parsed !== 'object' || Array.isArray(parsed)`.
        Ok(Value::Object(object)) => Some(Value::Object(object)),
        _ => None,
    }
}

/// `extractJsonObjectFromText` — `jsonParsing.ts:13-23`.
pub fn extract_json_object_from_text(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(direct) = parse_json_object(trimmed) {
        return Some(direct);
    }

    let first = trimmed.find('{')?;
    // `lastIndexOf('}')` — the byte index of the final `}`.
    let last = trimmed.rfind('}')?;
    if last <= first {
        return None;
    }
    parse_json_object(&trimmed[first..=last])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_objects_are_accepted() {
        assert!(parse_json_object("{}").is_some());
        assert!(parse_json_object("{\"a\":1}").is_some());
        assert!(parse_json_object("[]").is_none());
        assert!(parse_json_object("null").is_none());
        assert!(parse_json_object("42").is_none());
        assert!(parse_json_object("not json").is_none());
        assert!(parse_json_object("").is_none());
    }

    #[test]
    fn extraction_finds_the_outer_braces() {
        assert_eq!(
            extract_json_object_from_text("prefix {\"a\":1} suffix"),
            Some(serde_json::json!({ "a": 1 }))
        );
        assert_eq!(
            extract_json_object_from_text("```json\n{\"a\":1}\n```"),
            Some(serde_json::json!({ "a": 1 }))
        );
    }

    #[test]
    fn extraction_rejects_missing_or_inverted_braces() {
        assert_eq!(extract_json_object_from_text("   "), None);
        assert_eq!(extract_json_object_from_text("no braces"), None);
        assert_eq!(extract_json_object_from_text("}{"), None);
    }
}
