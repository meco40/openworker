//! JavaScript regex semantics for the S8 text heuristics. No TypeScript original: a
//! helper for the regex literals in `types.ts`, `projectGuard.ts`, `core/*` and
//! `dispatchers/ai/*`.
//!
//! JavaScript `\b` and `\W` are ASCII-only when the `u` flag is absent. The `regex`
//! crate uses Unicode word classes by default, so `"früher"` splits differently.
//! `\b` maps to the zero-width `(?-u:\b)`, which stays valid UTF-8. `\W` maps to
//! `[^0-9A-Za-z_]`: `(?-u:\W)` would match single non-ASCII bytes and be rejected.

use regex::Regex;

/// Compiles a JavaScript-flavoured pattern. Panics on an invalid pattern, which is
/// a programming error because every caller passes a literal.
pub fn js_regex(pattern: &str) -> Regex {
    let rewritten = pattern
        .replace(r"\W", "[^0-9A-Za-z_]")
        .replace(r"\b", r"(?-u:\b)");
    Regex::new(&rewritten).expect("JavaScript regex literal must compile")
}

/// `String.prototype.slice(0, limit)` in UTF-16 code units, without splitting a
/// character. JavaScript may split a surrogate pair; Rust cannot represent that, so
/// the cut moves back to the previous character boundary.
pub fn slice_utf16(text: &str, limit: usize) -> &str {
    let mut units = 0usize;
    for (index, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if units + width > limit {
            return &text[..index];
        }
        units += width;
    }
    text
}

/// `String.prototype.slice(-limit)` in UTF-16 code units, the last `limit` units.
pub fn suffix_utf16(text: &str, limit: usize) -> &str {
    let mut units = 0usize;
    let mut start = text.len();
    for (index, ch) in text.char_indices().rev() {
        let width = ch.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        start = index;
    }
    &text[start..]
}

/// `String.prototype.length` in UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_boundary_is_ascii_only() {
        // JS: /\bfrueher\b/ does not match inside "frueherx".
        assert!(js_regex(r"(?i)\bfrueher\b").is_match("frueher gesagt"));
        assert!(!js_regex(r"(?i)\bfrueher\b").is_match("frueherx"));
        // An accented letter is not a word character in JS, so "früher" still ends a
        // word boundary before a space.
        assert!(js_regex(r"(?i)\bfrüher\b").is_match("war früher da"));
    }

    #[test]
    fn non_word_class_is_ascii() {
        assert!(js_regex(r"^ab\W*$").is_match("ab!!"));
        assert!(!js_regex(r"^ab\W*$").is_match("ab_"));
    }

    #[test]
    fn utf16_slice_counts_code_units_and_keeps_characters_whole() {
        assert_eq!(slice_utf16("abcdef", 3), "abc");
        assert_eq!(slice_utf16("abc", 10), "abc");
        // U+1F600 is two UTF-16 units; a budget of 1 cannot hold it.
        assert_eq!(slice_utf16("\u{1F600}x", 1), "");
        assert_eq!(slice_utf16("\u{1F600}x", 2), "\u{1F600}");
        assert_eq!(utf16_len("\u{1F600}"), 2);
    }
}
