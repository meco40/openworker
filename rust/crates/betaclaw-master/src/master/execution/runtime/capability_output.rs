//! Port of `src/server/master/execution/runtime/capabilityOutput.ts:1-32`.
//!
//! `toSummaryFromSearchResult` turns a `web_search` tool result into the first
//! three rows of a numbered list; a missing row array falls back to a fixed
//! sentence. `normalizeCapabilityOutput` prefixes the merged output per
//! capability.
//!
//! # JavaScript truthiness and coercion
//!
//! `String(row.title || row.url || \`Result ${index + 1}\`)` (`:10`) short-circuits
//! on any JavaScript-falsy value, then coerces with `String`. Both steps are
//! reproduced by [`js_truthy`] and [`js_string_of`]; `NaN` cannot occur in a
//! parsed JSON number.

use serde_json::Value;

use super::types::Capability;

/// `String(value)` for a JSON scalar (nested containers use compact JSON).
fn js_string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// JavaScript truthiness for a parsed JSON value.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        // Arrays and objects are always truthy in JavaScript.
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `row.title` on a non-object row is `undefined`; the port returns `None`.
fn field<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row.as_object().and_then(|object| object.get(key))
}

/// `toSummaryFromSearchResult` — `capabilityOutput.ts:3-16`.
pub fn to_summary_from_search_result(input: &Value) -> String {
    let rows: Vec<&Value> = match field(input, "results") {
        Some(Value::Array(entries)) => entries.iter().collect(),
        _ => Vec::new(),
    };
    if rows.is_empty() {
        return "No web sources returned. Generated fallback summary from task contract."
            .to_string();
    }
    rows.iter()
        .take(3)
        .enumerate()
        .map(|(index, row)| {
            let title = match field(row, "title") {
                Some(value) if js_truthy(value) => js_string_of(value),
                _ => match field(row, "url") {
                    Some(value) if js_truthy(value) => js_string_of(value),
                    _ => format!("Result {}", index + 1),
                },
            };
            let url = field(row, "url").map(js_string_of).unwrap_or_default();
            let url = url.trim();
            let snippet = field(row, "snippet").map(js_string_of).unwrap_or_default();
            let snippet = snippet.trim();
            format!(
                "{}. {}{}{}",
                index + 1,
                title,
                if url.is_empty() {
                    String::new()
                } else {
                    format!(" ({url})")
                },
                if snippet.is_empty() {
                    String::new()
                } else {
                    format!(" - {snippet}")
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `normalizeCapabilityOutput` — `capabilityOutput.ts:18-32`.
pub fn normalize_capability_output(capability: Capability, output: &str) -> String {
    match capability {
        Capability::CodeGeneration => format!("Generated code artifact:\n{output}"),
        Capability::Notes => format!("Created note:\n{output}"),
        Capability::Reminders => format!("Created reminder:\n{output}"),
        Capability::SystemOps => format!("System operation report:\n{output}"),
        Capability::WebSearch => output.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_result_list_falls_back() {
        assert_eq!(
            to_summary_from_search_result(&serde_json::json!({ "results": [] })),
            "No web sources returned. Generated fallback summary from task contract."
        );
        assert_eq!(
            to_summary_from_search_result(&serde_json::json!({})),
            "No web sources returned. Generated fallback summary from task contract."
        );
        assert_eq!(
            to_summary_from_search_result(&serde_json::json!(5)),
            "No web sources returned. Generated fallback summary from task contract."
        );
    }

    #[test]
    fn rows_are_numbered_and_limited_to_three() {
        let input = serde_json::json!({
            "results": [
                { "title": "A", "url": "https://a", "snippet": "sa" },
                { "url": "https://b" },
                {},
                { "title": "D" }
            ]
        });
        let summary = to_summary_from_search_result(&input);
        assert_eq!(
            summary,
            "1. A (https://a) - sa\n2. https://b (https://b)\n3. Result 3"
        );
    }

    #[test]
    fn normalize_prefixes_per_capability() {
        assert_eq!(
            normalize_capability_output(Capability::Notes, "body"),
            "Created note:\nbody"
        );
        assert_eq!(
            normalize_capability_output(Capability::WebSearch, "body"),
            "body"
        );
        assert_eq!(
            normalize_capability_output(Capability::SystemOps, "body"),
            "System operation report:\nbody"
        );
    }
}
