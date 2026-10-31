//! JavaScript text helpers shared by the S11 handlers.
//!
//! The TypeScript handlers count text in UTF-16 code units (`String.length`,
//! `String.prototype.slice`), and `URLSearchParams` builds query strings. These helpers do
//! the same arithmetic on Rust strings. A cut never splits a code point. Where a surrogate
//! pair would be cut in half, the cut stops one unit earlier, as `file_read.rs` does.

use std::fmt::Write as _;

use serde_json::{json, Value};

/// `text.length`.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, end)` for an integer `end`. A negative `end` counts back from the end.
pub fn js_slice_to(text: &str, end: i64) -> &str {
    let total = utf16_len(text) as i64;
    let clamped = if end < 0 {
        (total + end).max(0)
    } else {
        end.min(total)
    };
    let limit = clamped as usize;
    let mut used = 0usize;
    for (index, character) in text.char_indices() {
        let width = character.len_utf16();
        if used + width > limit {
            return &text[..index];
        }
        used += width;
    }
    text
}

/// A JSON number for a JavaScript number. Integral values print without a fraction, and
/// `NaN` and the infinities become `null`, as `JSON.stringify` writes them.
pub fn json_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `new URLSearchParams(pairs).toString()`: `application/x-www-form-urlencoded`. A space
/// becomes `+`, and ASCII letters, digits and `*-._` stay as they are.
pub fn form_urlencode(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (index, (key, value)) in pairs.iter().enumerate() {
        if index > 0 {
            out.push('&');
        }
        push_form_encoded(&mut out, key);
        out.push('=');
        push_form_encoded(&mut out, value);
    }
    out
}

fn push_form_encoded(out: &mut String, text: &str) {
    for byte in text.bytes() {
        match byte {
            b' ' => out.push('+'),
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(byte));
            }
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_slices_count_units_and_keep_pairs_whole() {
        let text = "a\u{1F600}b"; // the emoji is two UTF-16 units
        assert_eq!(utf16_len(text), 4);
        assert_eq!(
            js_slice_to(text, 2),
            "a",
            "the pair does not fit in one unit"
        );
        assert_eq!(js_slice_to(text, 3), "a\u{1F600}");
        assert_eq!(
            js_slice_to(text, -1),
            "a\u{1F600}",
            "negative counts from the end"
        );
        assert_eq!(js_slice_to(text, 100), text);
        assert_eq!(js_slice_to(text, -100), "");
    }

    #[test]
    fn json_numbers_match_javascript_output() {
        assert_eq!(json_number(5.0).to_string(), "5");
        assert_eq!(json_number(2.5).to_string(), "2.5");
        assert_eq!(json_number(f64::INFINITY), Value::Null);
        assert_eq!(json_number(f64::NAN), Value::Null);
    }

    #[test]
    fn form_urlencode_matches_urlsearchparams() {
        assert_eq!(
            form_urlencode(&[("q", "a b&c"), ("n", "1*-._")]),
            "q=a+b%26c&n=1*-._"
        );
    }
}
