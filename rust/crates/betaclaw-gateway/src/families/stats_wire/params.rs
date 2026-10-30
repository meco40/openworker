//! Query-string and number helpers. They follow `URLSearchParams.get` and the
//! parsers of `src/server/http/params.ts` that the TypeScript routes of this
//! family use.

use betaclaw_core::stats::util::js_parse_int;

/// `URLSearchParams.get(name)`: the first value of `name`, percent-decoded.
pub fn query_value(query: Option<&str>, name: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (decode(key) == name).then(|| decode(value))
    })
}

/// `value || undefined`: an empty string counts as absent.
pub fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

/// `parsePositiveIntOrFallback`: a positive integer, else the fallback.
pub fn positive_int_or(raw: Option<&str>, fallback: i64) -> i64 {
    match raw.and_then(js_parse_int) {
        Some(value) if value > 0 => value,
        _ => fallback,
    }
}

/// `parseBoundedIntOrNull`: the fallback when the text is absent or empty, `None`
/// when it is not a finite number, else the value floored and clamped.
pub fn bounded_int(raw: Option<&str>, fallback: i64, min: i64, max: i64) -> Option<i64> {
    let Some(text) = raw.filter(|text| !text.is_empty()) else {
        return Some(fallback);
    };
    let number = js_number_text(text);
    number
        .is_finite()
        .then(|| (number.floor() as i64).clamp(min, max))
}

/// `Number(text)` for a query value. Only the decimal spellings Rust parses are
/// accepted; JavaScript's `0x` and `0b` forms give `NaN` here.
fn js_number_text(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        0.0
    } else {
        trimmed.parse::<f64>().unwrap_or(f64::NAN)
    }
}

/// Decodes `+` as a space and `%XX` escapes. An invalid escape stays literal.
fn decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'+' {
            out.push(b' ');
        } else if byte == b'%' && index + 2 < bytes.len() {
            if let Some(decoded) = hex_pair(bytes[index + 1], bytes[index + 2]) {
                out.push(decoded);
                index += 3;
                continue;
            }
            out.push(byte);
        } else {
            out.push(byte);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_pair(high: u8, low: u8) -> Option<u8> {
    let digit = |byte: u8| (byte as char).to_digit(16).map(|value| value as u8);
    Some(digit(high)? * 16 + digit(low)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_value_takes_the_first_decoded_occurrence() {
        let query = Some("a=1&a=2&name=x+y%21&bare");
        assert_eq!(query_value(query, "a").as_deref(), Some("1"));
        assert_eq!(query_value(query, "name").as_deref(), Some("x y!"));
        assert_eq!(query_value(query, "bare").as_deref(), Some(""));
        assert_eq!(query_value(query, "missing"), None);
        assert_eq!(query_value(None, "a"), None);
    }

    #[test]
    fn bounded_int_follows_the_typescript_helper() {
        assert_eq!(bounded_int(None, 250, 1, 500), Some(250));
        assert_eq!(bounded_int(Some(""), 250, 1, 500), Some(250));
        assert_eq!(bounded_int(Some("12.9"), 250, 1, 500), Some(12));
        assert_eq!(bounded_int(Some("9999"), 250, 1, 500), Some(500));
        assert_eq!(bounded_int(Some("-4"), 250, 1, 500), Some(1));
        assert_eq!(bounded_int(Some("abc"), 250, 1, 500), None);
    }

    #[test]
    fn positive_int_or_falls_back_below_one() {
        assert_eq!(positive_int_or(Some("7"), 50), 7);
        assert_eq!(positive_int_or(Some("0"), 50), 50);
        assert_eq!(positive_int_or(Some("x"), 50), 50);
        assert_eq!(positive_int_or(None, 0), 0);
    }
}
