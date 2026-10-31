//! Port of `src/server/master/repository/helpers.ts:1-19`.
//!
//! Four scalar helpers shared by the store modules. The two coercions are the
//! interesting ones because JavaScript is looser than SQLite's declared types:
//!
//! * [`to_bool`] is `Boolean(value)`, so an integer `0`, the empty string and
//!   `NULL` are `false` and everything else — including a non-empty text — is
//!   `true`.
//! * [`parse_json_array`] swallows every parse failure and returns `[]`; a
//!   successful parse that is not an array also returns `[]`. Each element is
//!   `String(entry)`, so a stored `["a","b"]` round-trips unchanged while a
//!   stored `[1]` becomes `["1"]`.

use rusqlite::types::Value as SqliteValue;
use serde_json::Value;

/// `SqlPatch` from `helpers.ts:1`.
///
/// The TypeScript patch bag a store builds before an `UPDATE`. The port keeps
/// it as a JSON object so the key set survives exactly; see
/// [`crate::master::repository::mappers`] for the row side.
pub type SqlPatch = serde_json::Map<String, Value>;

/// `nowIso` from `helpers.ts:3-5`.
///
/// `new Date().toISOString()` — millisecond precision, always UTC, `Z` suffix.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `toBool` from `helpers.ts:7-9` — `Boolean(value)`.
pub fn to_bool(value: &SqliteValue) -> bool {
    match value {
        SqliteValue::Null => false,
        SqliteValue::Integer(number) => *number != 0,
        SqliteValue::Real(number) => *number != 0.0 && !number.is_nan(),
        SqliteValue::Text(text) => !text.is_empty(),
        // A `Buffer`/`ArrayBuffer` is an object in JavaScript and therefore truthy.
        SqliteValue::Blob(blob) => !blob.is_empty(),
    }
}

/// `parseJsonArray` from `helpers.ts:11-19`.
pub fn parse_json_array(value: Option<&str>) -> Vec<String> {
    let Some(text) = value else {
        return Vec::new();
    };
    if text.trim().is_empty() {
        return Vec::new();
    }
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Value::Array(entries) = parsed else {
        return Vec::new();
    };
    entries.iter().map(js_string).collect()
}

/// `String(entry)` for a JSON array element.
///
/// Scalars use the JavaScript spellings; a nested array or object falls back to
/// the compact JSON text, which is the closest stable stand-in for JavaScript's
/// `String([...])` / `String({...})` coercion (see the module header).
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::types::Value as SqliteValue;

    #[test]
    fn now_iso_is_utc_millisecond_iso() {
        let stamp = now_iso();
        assert!(stamp.ends_with('Z'), "{stamp}");
        // `YYYY-MM-DDTHH:MM:SS.sssZ`
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert_eq!(&stamp[10..11], "T");
        assert_eq!(&stamp[19..20], ".");
    }

    #[test]
    fn to_bool_matches_javascript_truthiness() {
        assert!(!to_bool(&SqliteValue::Null));
        assert!(!to_bool(&SqliteValue::Integer(0)));
        assert!(!to_bool(&SqliteValue::Real(0.0)));
        assert!(!to_bool(&SqliteValue::Real(f64::NAN)));
        assert!(!to_bool(&SqliteValue::Text(String::new())));
        assert!(!to_bool(&SqliteValue::Blob(Vec::new())));
        assert!(to_bool(&SqliteValue::Integer(1)));
        assert!(to_bool(&SqliteValue::Text("no".to_string())));
        assert!(to_bool(&SqliteValue::Blob(vec![0])));
    }

    #[test]
    fn parse_json_array_handles_the_source_cases() {
        assert_eq!(parse_json_array(None), Vec::<String>::new());
        assert_eq!(parse_json_array(Some("")), Vec::<String>::new());
        assert_eq!(parse_json_array(Some("   ")), Vec::<String>::new());
        assert_eq!(parse_json_array(Some("{not json")), Vec::<String>::new());
        assert_eq!(parse_json_array(Some("{\"a\":1}")), Vec::<String>::new());
        assert_eq!(parse_json_array(Some("42")), Vec::<String>::new());
        assert_eq!(
            parse_json_array(Some("[\"a\",\"b\"]")),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(parse_json_array(Some("[1,2]")), vec!["1", "2"]);
        assert_eq!(parse_json_array(Some("[true,null]")), vec!["true", "null"]);
    }
}
