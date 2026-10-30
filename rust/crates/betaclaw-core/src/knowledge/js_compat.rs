//! JavaScript coercions that the Knowledge TypeScript relies on, applied to
//! untyped LLM JSON (`serde_json::Value`) and to UTF-16 string positions.
//!
//! Rust-only seam module: no TypeScript file of its own. The helpers mirror the
//! expressions they replace:
//!
//! | Helper | JavaScript |
//! | --- | --- |
//! | [`js_string`] | `String(x)` (`undefined` becomes `"undefined"`) |
//! | [`js_string_or_empty`] | `String(x \|\| '')` |
//! | [`js_truthy`] | the truthiness test in `x && …`, `x ? … : …`, `!x` |
//! | [`js_number`] | `Number(x)` (`undefined` becomes `NaN`, `null` becomes `0`) |
//! | [`js_slice_prefix`] | `str.slice(0, end)` in UTF-16 units |
//!
//! `js_string_or_empty` of an object gives `"[object Object]"`, as in
//! JavaScript, so a model that returns an object where text was expected yields
//! the same visible text.

use serde_json::Value;

use crate::knowledge::retrieval::js_str_len;

/// `String(value)`. `None` stands for a missing property (`undefined`).
pub(crate) fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => js_number_text(number.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(text)) => text.clone(),
        // `Array#toString` joins with "," and prints null and undefined as "".
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// `String(value || '')`.
pub(crate) fn js_string_or_empty(value: Option<&Value>) -> String {
    if js_truthy(value) {
        js_string(value)
    } else {
        String::new()
    }
}

/// Truthiness: `null`, `undefined`, `false`, `0`, `NaN` and `""` are falsy.
pub(crate) fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => {
            let numeric = number.as_f64().unwrap_or(f64::NAN);
            numeric != 0.0 && !numeric.is_nan()
        }
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `Number(value)`. `None` is `undefined` and gives `NaN`.
pub(crate) fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        // `Number([])` is 0 and `Number([x])` is `Number(x)`; longer arrays and
        // objects are `NaN`.
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [single] => js_number(Some(single)),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `String(number)` for the JSON numbers the models produce: integers print
/// without a fraction, everything else uses the shortest round-trip form.
fn js_number_text(numeric: f64) -> String {
    if numeric.is_nan() {
        return "NaN".to_string();
    }
    if numeric.fract() == 0.0 && numeric.abs() < 1e15 {
        return format!("{}", numeric as i64);
    }
    format!("{numeric}")
}

/// `text.slice(0, end)` in UTF-16 units. A negative `end` counts from the end.
///
/// A cut that would split a surrogate pair stops before the character: a Rust
/// `str` cannot hold the lone surrogate JavaScript would keep.
pub(crate) fn js_slice_prefix(text: &str, end: i64) -> String {
    let length = js_str_len(text) as i64;
    let end = if end < 0 {
        (length + end).max(0)
    } else {
        end.min(length)
    };
    let mut units = 0_i64;
    let mut out = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16() as i64;
        if units + width > end {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn string_follows_javascript_for_each_json_kind() {
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&Value::Null)), "null");
        assert_eq!(js_string(Some(&json!(true))), "true");
        assert_eq!(js_string(Some(&json!(7))), "7");
        assert_eq!(js_string(Some(&json!(2.5))), "2.5");
        assert_eq!(js_string(Some(&json!(["a", null, 1]))), "a,,1");
        assert_eq!(js_string(Some(&json!({"k": "v"}))), "[object Object]");
    }

    #[test]
    fn string_or_empty_drops_falsy_values() {
        assert_eq!(js_string_or_empty(None), "");
        assert_eq!(js_string_or_empty(Some(&json!(""))), "");
        assert_eq!(js_string_or_empty(Some(&json!(0))), "");
        assert_eq!(js_string_or_empty(Some(&json!("Max"))), "Max");
    }

    #[test]
    fn number_follows_javascript() {
        assert!(js_number(None).is_nan());
        assert_eq!(js_number(Some(&Value::Null)), 0.0);
        assert_eq!(js_number(Some(&json!(true))), 1.0);
        assert_eq!(js_number(Some(&json!(" 3 "))), 3.0);
        assert_eq!(js_number(Some(&json!(""))), 0.0);
        assert!(js_number(Some(&json!("drei"))).is_nan());
        assert_eq!(js_number(Some(&json!([4]))), 4.0);
        assert!(js_number(Some(&json!({}))).is_nan());
    }

    #[test]
    fn truthiness_matches_javascript() {
        assert!(!js_truthy(Some(&json!(""))));
        assert!(!js_truthy(Some(&json!(0))));
        assert!(js_truthy(Some(&json!("0"))));
        assert!(js_truthy(Some(&json!([]))));
        assert!(!js_truthy(None));
    }

    #[test]
    fn slice_counts_utf16_units_and_never_splits_a_pair() {
        assert_eq!(js_slice_prefix("😀a", 1), "");
        assert_eq!(js_slice_prefix("😀a", 2), "😀");
        assert_eq!(js_slice_prefix("abc", -1), "ab");
        assert_eq!(js_slice_prefix("abc", 99), "abc");
    }
}
