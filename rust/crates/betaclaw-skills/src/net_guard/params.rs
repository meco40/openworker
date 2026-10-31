//! Port of `src/server/http/params.ts`.
//!
//! The memory API routes read query and body values with these helpers. The inputs are JSON
//! values (`unknown` in TypeScript). `None`, `null` and `""` count as absent, as they do in
//! TypeScript.

use serde_json::Value;

/// `parseBoundedIntOrNull`: the fallback when the value is absent, `None` when it is not a
/// finite number, otherwise `floor(value)` clamped to `[min, max]`.
pub fn parse_bounded_int_or_null(
    raw: Option<&Value>,
    fallback: i64,
    min: i64,
    max: i64,
) -> Option<i64> {
    if is_absent(raw) {
        return Some(fallback);
    }
    let number = to_number(raw.unwrap_or(&Value::Null));
    if !number.is_finite() {
        return None;
    }
    Some((number.floor() as i64).max(min).min(max))
}

/// `parseBoundedIntOrFallback`.
pub fn parse_bounded_int_or_fallback(
    raw: Option<&Value>,
    fallback: i64,
    min: i64,
    max: i64,
) -> i64 {
    parse_bounded_int_or_null(raw, fallback, min, max).unwrap_or(fallback)
}

/// `parsePositiveIntOrFallback`: `parseInt(String(raw ?? ''), 10)`, or the fallback when that
/// is not a positive number.
pub fn parse_positive_int_or_fallback(raw: Option<&Value>, fallback: i64) -> i64 {
    let text = match raw {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    };
    match parse_int_prefix(&text) {
        Some(value) if value > 0 => value,
        _ => fallback,
    }
}

fn is_absent(raw: Option<&Value>) -> bool {
    match raw {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.is_empty(),
        Some(_) => false,
    }
}

/// `Number(value)` for the JSON values the routes pass in.
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

/// `parseInt(text, 10)`: optional whitespace and sign, then digits. Trailing text is ignored.
fn parse_int_prefix(text: &str) -> Option<i64> {
    let trimmed = text.trim_start();
    let (negative, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let value = digits.parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bounded_int_uses_the_fallback_for_absent_values_and_clamps_the_rest() {
        assert_eq!(parse_bounded_int_or_null(None, 50, 1, 200), Some(50));
        assert_eq!(
            parse_bounded_int_or_null(Some(&json!("")), 50, 1, 200),
            Some(50)
        );
        assert_eq!(
            parse_bounded_int_or_null(Some(&json!("7.9")), 50, 1, 200),
            Some(7)
        );
        assert_eq!(
            parse_bounded_int_or_null(Some(&json!(999)), 50, 1, 200),
            Some(200)
        );
        assert_eq!(
            parse_bounded_int_or_null(Some(&json!(-4)), 50, 1, 200),
            Some(1)
        );
        assert_eq!(
            parse_bounded_int_or_null(Some(&json!("abc")), 50, 1, 200),
            None
        );
        assert_eq!(
            parse_bounded_int_or_fallback(Some(&json!("abc")), 50, 1, 200),
            50
        );
    }

    #[test]
    fn positive_int_reads_the_leading_digits() {
        assert_eq!(parse_positive_int_or_fallback(Some(&json!("12px")), 3), 12);
        assert_eq!(parse_positive_int_or_fallback(Some(&json!(0)), 3), 3);
        assert_eq!(parse_positive_int_or_fallback(Some(&json!("-5")), 3), 3);
        assert_eq!(parse_positive_int_or_fallback(None, 3), 3);
    }
}
