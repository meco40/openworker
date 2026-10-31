//! Port of `src/server/knowledge/repositories/utils.ts`.
//!
//! | TypeScript                              | Rust |
//! | --------------------------------------- | ---- |
//! | `utils.ts:1-9` (`parseJsonArray`)        | [`parse_json_array`] |
//! | `utils.ts:11-20` (`parseJsonObject`)     | [`parse_json_object`] |
//! | `utils.ts:22-27` (`parseIso`)            | [`parse_iso`] |
//! | `utils.ts:29-32` (`asLimit`)             | [`as_limit`] |
//! | `utils.ts:34-36` (`toStringArray`)       | [`to_string_array`] |
//! | `utils.ts:38-47` (`toSourceRefs`)        | [`to_source_refs`] |
//!
//! # JavaScript semantics that are reproduced explicitly
//!
//! * `parseJsonArray` returns `[]` for a non-string, blank, non-array or
//!   unparsable value. The port reads the column through `Option<&str>`, so a
//!   `NULL` and a non-text column both take the `[]` branch — the same branch
//!   `typeof value !== 'string'` takes.
//! * `parseIso` is `new Date(Date.parse(text)).toISOString()`: the output always
//!   carries `T`, a three-digit millisecond fraction and a `Z`.
//! * `asLimit` is `Math.max(1, Math.min(200, Math.floor(value)))` after a
//!   `typeof number` + `Number.isFinite` guard.
//!
//! # Deviations
//!
//! 1. **`JSON.parse` element shapes.** `parseJsonArray<T>` casts the parsed array
//!    without inspecting the elements. The port deserializes element by element
//!    and skips an element whose shape does not match `T`, instead of letting a
//!    wrong shape survive into later arithmetic. For the two shapes this slice
//!    actually stores (`string`, `{seq, quote}`) a value written by the
//!    TypeScript always matches.
//! 2. **`Date.parse` coverage.** V8 accepts implementation-specific formats the
//!    port does not (`'Jan 2 2026'`, a bare time, a zone-less local timestamp).
//!    [`parse_iso`] implements the ISO 8601 shapes the slice stores — RFC 3339
//!    with an offset, `YYYY-MM-DDTHH:MM:SS[.f]`, `YYYY-MM-DD`, `YYYY-MM` and
//!    `YYYY` — and returns [`None`] for the rest. A zone-less timestamp is read
//!    as UTC, while V8 reads it as local time; see the S7 hand-over.
//! 3. **`asLimit` takes an integer.** The TypeScript `filter.limit` is a `number`
//!    and `Math.floor`s a fraction. Every Rust filter field is `Option<i64>`, so
//!    the `typeof`/`floor` branches collapse and only the clamp remains.

use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::knowledge::repository::KnowledgeSourceRef;

/// `parseJsonArray<T>` (`utils.ts:1-9`).
pub fn parse_json_array<T: DeserializeOwned>(value: Option<&str>) -> Vec<T> {
    let Some(text) = value else {
        return Vec::new();
    };
    if text.trim().is_empty() {
        return Vec::new();
    }
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Value::Array(items) = parsed else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| serde_json::from_value(item).ok())
        .collect()
}

/// `parseJsonObject` (`utils.ts:11-20`).
///
/// A non-string, blank, non-object, array or unparsable value yields an empty
/// map. The returned map preserves the JSON key order.
pub fn parse_json_object(value: Option<&str>) -> Map<String, Value> {
    let Some(text) = value else {
        return Map::new();
    };
    if text.trim().is_empty() {
        return Map::new();
    }
    let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(text) else {
        return Map::new();
    };
    parsed
}

/// `parseIso` (`utils.ts:22-27`).
pub fn parse_iso(input: Option<&str>) -> Option<String> {
    let text = input.unwrap_or("").trim();
    if text.is_empty() {
        return None;
    }
    let parsed = parse_date(text)?;
    Some(parsed.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// The subset of V8's `Date.parse` this slice needs (see deviation 2).
fn parse_date(text: &str) -> Option<DateTime<Utc>> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
        return Some(parsed.with_timezone(&Utc));
    }
    if let Ok(parsed) = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(Utc.from_utc_datetime(&parsed));
    }
    if let Ok(parsed) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Some(Utc.from_utc_datetime(&parsed.and_hms_opt(0, 0, 0)?));
    }
    // `Date.parse('2026-01')` and `Date.parse('2026')` are both
    // `2026-01-01T00:00:00.000Z` in V8, while chrono's date parser needs the
    // day, so both shapes are read by hand.
    parse_short_iso_date(text)
}

/// The `YYYY-MM` and `YYYY` shapes of V8's `Date.parse`, both UTC midnight.
fn parse_short_iso_date(text: &str) -> Option<DateTime<Utc>> {
    let mut parts = text.split('-');
    let year = i32::try_from(iso_field(parts.next()?, 4)?).ok()?;
    let month = match parts.next() {
        None => 1,
        Some(month) => iso_field(month, 2)?,
    };
    if parts.next().is_some() {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(year, month, 1)?;
    Some(Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0)?))
}

/// A field of exactly `width` ASCII digits — the only spelling `Date.parse`
/// accepts (`'+2026'` is `NaN`, `parse::<i32>` would accept it).
fn iso_field(value: &str, width: usize) -> Option<u32> {
    if value.len() != width || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

/// `asLimit` (`utils.ts:29-32`).
///
/// The default `fallback` is `20`, the value the TypeScript parameter declares.
pub fn as_limit(value: Option<i64>, fallback: i64) -> i64 {
    match value {
        None => fallback,
        Some(limit) => limit.clamp(1, 200),
    }
}

/// `toStringArray` (`utils.ts:34-36`).
///
/// `values.map((value) => String(value || '').trim()).filter((value) => value.length > 0)`.
/// The Rust receiver is already `&[String]`, so the `String(value || '')` step
/// collapses to the identity for a non-empty element and to `''` for an empty
/// one — both are then trimmed and blanks dropped.
pub fn to_string_array(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

/// `toSourceRefs` (`utils.ts:38-47`).
///
/// `Number.isFinite(row.seq)` is always true for the `i64` the Rust struct
/// carries, so the filter that survives is the non-empty quote.
pub fn to_source_refs(rows: &[KnowledgeSourceRef]) -> Vec<KnowledgeSourceRef> {
    rows.iter()
        .map(|row| KnowledgeSourceRef {
            seq: row.seq,
            quote: row.quote.trim().to_string(),
        })
        .filter(|row| !row.quote.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_array_matches_the_typescript_branches() {
        let facts: Vec<String> = parse_json_array(Some(r#"["a","b"]"#));
        assert_eq!(facts, vec!["a", "b"]);
        // blank / non-array / unparsable / absent all yield []
        assert!(parse_json_array::<String>(Some("   ")).is_empty());
        assert!(parse_json_array::<String>(Some("null")).is_empty());
        assert!(parse_json_array::<String>(Some(r#"{"a":1}"#)).is_empty());
        assert!(parse_json_array::<String>(Some("not json")).is_empty());
        assert!(parse_json_array::<String>(None).is_empty());
        // an element of the wrong shape is skipped (deviation 1).
        let refs: Vec<KnowledgeSourceRef> = parse_json_array(Some(r#"[{"seq":1,"quote":"q"},7]"#));
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].seq, 1);
    }

    #[test]
    fn parse_json_object_keeps_only_object_shapes() {
        let map = parse_json_object(Some(r#"{"b":1,"a":"x"}"#));
        assert_eq!(map.len(), 2);
        assert_eq!(map["b"], serde_json::json!(1));
        assert!(parse_json_object(Some("[]")).is_empty());
        assert!(parse_json_object(Some("3")).is_empty());
        assert!(parse_json_object(Some("")).is_empty());
        assert!(parse_json_object(None).is_empty());
    }

    #[test]
    fn parse_iso_normalizes_to_utc_milliseconds() {
        assert_eq!(
            parse_iso(Some("2026-01-02T03:04:05Z")).as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
        assert_eq!(
            parse_iso(Some("2026-01-02T03:04:05.12Z")).as_deref(),
            Some("2026-01-02T03:04:05.120Z")
        );
        // An offset is normalized to UTC, like `toISOString()`.
        assert_eq!(
            parse_iso(Some("2026-01-02T05:04:05+02:00")).as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
        // A date-only value is UTC midnight (V8 agrees).
        assert_eq!(
            parse_iso(Some("2026-01-02")).as_deref(),
            Some("2026-01-02T00:00:00.000Z")
        );
        // V8 accepts a bare `YYYY-MM` and a bare `YYYY` (checked against Node:
        // `Date.parse('2026-01')` and `Date.parse('2026')` are both 2026-01-01Z).
        assert_eq!(
            parse_iso(Some("2026-01")).as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(
            parse_iso(Some("2026")).as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        // Shapes V8 only accepts through implementation-specific heuristics
        // (`Date.parse('2026-1')` and `Date.parse('+2026')` are the local
        // midnight of 2025-12-31 here); deviation 2 leaves them unsupported.
        assert_eq!(parse_iso(Some("+2026")), None);
        assert_eq!(parse_iso(Some("2026-1")), None);
        assert_eq!(parse_iso(Some("")), None);
        assert_eq!(parse_iso(Some("   ")), None);
        assert_eq!(parse_iso(None), None);
        assert_eq!(parse_iso(Some("not a date")), None);
    }

    #[test]
    fn as_limit_clamps_into_one_to_two_hundred() {
        assert_eq!(as_limit(None, 20), 20);
        assert_eq!(as_limit(None, 25), 25);
        assert_eq!(as_limit(Some(0), 20), 1);
        assert_eq!(as_limit(Some(-7), 20), 1);
        assert_eq!(as_limit(Some(1), 20), 1);
        assert_eq!(as_limit(Some(200), 20), 200);
        assert_eq!(as_limit(Some(201), 20), 200);
        assert_eq!(as_limit(Some(50), 20), 50);
    }

    #[test]
    fn to_string_array_trims_and_drops_blanks() {
        let values = vec![
            "  alpha ".to_string(),
            String::new(),
            "   ".to_string(),
            "beta".to_string(),
        ];
        assert_eq!(to_string_array(&values), vec!["alpha", "beta"]);
    }

    #[test]
    fn to_source_refs_trims_and_drops_blank_quotes() {
        let rows = vec![
            KnowledgeSourceRef {
                seq: 3,
                quote: "  hello  ".to_string(),
            },
            KnowledgeSourceRef {
                seq: 4,
                quote: "   ".to_string(),
            },
        ];
        let refs = to_source_refs(&rows);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].seq, 3);
        assert_eq!(refs[0].quote, "hello");
    }
}
