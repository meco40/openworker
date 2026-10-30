//! JavaScript-compatible helpers for the stats port.
//!
//! The TypeScript sources rely on `Math.round`, `Number(...)`, `parseInt`,
//! `parseFloat`, truthiness and `Date.parse`. Their edge cases are observable:
//! a `null` metric counts as `0` in the rollout gates. The helpers reproduce
//! those cases instead of using Rust's defaults.

use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use serde_json::Value;

/// `Math.round`: a half rounds towards +infinity (`-2.5` gives `-2`).
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `Math.round(value * 10^places) / 10^places`, the rounding of all rates.
pub fn round_places(value: f64, places: i32) -> f64 {
    let factor = 10f64.powi(places);
    js_round(value * factor) / factor
}

/// `value` when it is finite, else `None`.
pub fn finite(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}

/// `new Date(ms).toISOString()`: millisecond precision, `Z` suffix.
pub fn iso_millis(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    iso_millis(Utc::now())
}

/// ISO string for epoch milliseconds, `None` when the value is out of range.
pub fn iso_from_ms(ms: i64) -> Option<String> {
    DateTime::from_timestamp_millis(ms).map(iso_millis)
}

/// `Date.now()`.
pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// First eight hex characters of a fresh UUID, the id suffix of the stores.
pub fn short_uuid() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// `Date.parse(value)` for the ISO-like strings the stores hold, in
/// milliseconds since the epoch. Date-times without an offset are read as UTC;
/// JavaScript would read them as local time, which is UTC on the servers.
pub fn parse_iso_ms(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.timestamp_millis());
    }
    const DATE_TIME_FORMATS: [&str; 4] = [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
    ];
    for format in DATE_TIME_FORMATS {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, format) {
            return Some(naive.and_utc().timestamp_millis());
        }
    }
    let date = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d").ok()?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}

/// `Number.parseInt(value, 10)`: leading whitespace and a sign are allowed, and
/// trailing characters are ignored (`"7.5"` gives `7`).
pub fn js_parse_int(value: &str) -> Option<i64> {
    let trimmed = value.trim_start();
    let (sign, unsigned) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = unsigned.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().map(|parsed| sign * parsed)
}

/// `Number.parseFloat(value)`: the longest numeric prefix, or `None`.
pub fn js_parse_float(value: &str) -> Option<f64> {
    let bytes = value.trim_start().as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end += 1;
    }
    let int_start = end;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    let int_digits = end - int_start;
    let mut frac_digits = 0;
    if end < bytes.len() && bytes[end] == b'.' {
        let mut frac_end = end + 1;
        while frac_end < bytes.len() && bytes[frac_end].is_ascii_digit() {
            frac_end += 1;
        }
        frac_digits = frac_end - end - 1;
        if frac_digits > 0 {
            end = frac_end;
        }
    }
    if int_digits + frac_digits == 0 {
        return None;
    }
    if end < bytes.len() && matches!(bytes[end], b'e' | b'E') {
        let mut exp_end = end + 1;
        if exp_end < bytes.len() && matches!(bytes[exp_end], b'+' | b'-') {
            exp_end += 1;
        }
        let digits_start = exp_end;
        while exp_end < bytes.len() && bytes[exp_end].is_ascii_digit() {
            exp_end += 1;
        }
        if exp_end > digits_start {
            end = exp_end;
        }
    }
    std::str::from_utf8(&bytes[..end]).ok()?.parse::<f64>().ok()
}

/// `Number(value)` as it applies to snapshot payloads: a missing key is `NaN`,
/// `null` and `""` are `0`, `true` is `1`. Arrays and objects stay `NaN`, a
/// deliberate simplification (JavaScript coerces `[]` to `0`). Non-finite
/// results are returned as they are; callers check with [`finite`].
pub fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// JavaScript truthiness of an optional JSON value.
pub fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_halves_towards_positive_infinity() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.4), 2.0);
    }

    #[test]
    fn round_places_divides_back_after_rounding() {
        assert_eq!(round_places(0.12345, 2), 0.12);
        assert_eq!(round_places(0.66666, 4), 0.6667);
    }

    #[test]
    fn parse_int_follows_js_prefix_rules() {
        assert_eq!(js_parse_int("7abc"), Some(7));
        assert_eq!(js_parse_int(" -3"), Some(-3));
        assert_eq!(js_parse_int("7.5"), Some(7));
        assert_eq!(js_parse_int("x7"), None);
    }

    #[test]
    fn parse_float_takes_the_numeric_prefix() {
        assert_eq!(js_parse_float("12.5kg"), Some(12.5));
        assert_eq!(js_parse_float(".5"), Some(0.5));
        assert_eq!(js_parse_float("5."), Some(5.0));
        assert_eq!(js_parse_float("1e3x"), Some(1000.0));
        assert_eq!(js_parse_float("abc"), None);
    }

    #[test]
    fn number_coercion_matches_js_for_payload_values() {
        assert!(js_number(None).is_nan());
        assert_eq!(js_number(Some(&Value::Null)), 0.0);
        assert_eq!(js_number(Some(&json!(""))), 0.0);
        assert_eq!(js_number(Some(&json!("12"))), 12.0);
        assert_eq!(js_number(Some(&json!(true))), 1.0);
        assert!(js_number(Some(&json!("x"))).is_nan());
    }

    #[test]
    fn truthiness_matches_js() {
        assert!(!js_truthy(None));
        assert!(!js_truthy(Some(&json!(0))));
        assert!(!js_truthy(Some(&json!(""))));
        assert!(js_truthy(Some(&json!({}))));
        assert!(js_truthy(Some(&json!([]))));
    }

    #[test]
    fn parses_iso_and_sqlite_style_timestamps() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(parse_iso_ms("1970-01-01 00:00:01"), Some(1000));
        assert_eq!(parse_iso_ms("1970-01-02"), Some(86_400_000));
        assert_eq!(parse_iso_ms("not a date"), None);
    }
}
