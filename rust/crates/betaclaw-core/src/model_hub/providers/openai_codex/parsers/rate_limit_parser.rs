//! Port of `src/server/model-hub/Models/openai-codex/parsers/rateLimitParser.ts`.
//!
//! The header walk reproduces three properties of the WHATWG `Headers` object
//! the TypeScript iterates, none of which a Rust `HeaderMap` provides on its
//! own:
//!
//! 1. `headers.entries()` yields the list **sorted by name** (`Headers` keeps a
//!    sorted, combined list), so the port sorts the entries too.
//! 2. A repeated name is **combined with `", "`** before the parser sees it, so
//!    the values of one name are joined the same way here.
//! 3. The parser reads the name and the value without any further casing rule,
//!    so a name is lowercased once, up front.
//!
//! The regular expressions use explicit ASCII classes and an ASCII word
//! boundary (`(?-u:\b)`), because JavaScript's `\d`, `\w` and `\b` are ASCII
//! while the `regex` crate is Unicode-aware by default. A name or value that
//! contains something like an Arabic-Indic digit therefore reads the same in
//! both languages.

use std::sync::LazyLock;

use http::HeaderMap;
use regex::Regex;

use crate::model_hub::types::{RateLimitSnapshot, RateLimitWindow};

/// `Number.MAX_SAFE_INTEGER`, the sentinel `parseWindow` returns for a token it
/// cannot read (`rateLimitParser.ts:19`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `/(?:^|[-_])(\d+[hdwm])(?:$|[-_])/i` from `rateLimitParser.ts:11`.
static WINDOW_FROM_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[-_])([0-9]+[hdwm])(?:$|[-_])").expect("WINDOW_FROM_NAME is a valid regex")
});

/// `/\b(\d+[hdwm])\b/i` from `rateLimitParser.ts:13`, with the ASCII word
/// boundary of JavaScript.
static WINDOW_FROM_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b([0-9]+[hdwm])\b)").expect("WINDOW_FROM_VALUE is a valid regex")
});

/// `/(^|[-_])remaining([-_]|$)/` from `rateLimitParser.ts:49`.
static REMAINING_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|[-_])remaining([-_]|$)").expect("REMAINING_TOKEN is a valid regex")
});

/// `/(^|[-_])reset([-_]|$)/` from `rateLimitParser.ts:50`.
static RESET_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[-_])reset([-_]|$)").expect("RESET_TOKEN is a valid regex"));

/// `/(^|[-_])limit([-_]|$)/` from `rateLimitParser.ts:51`.
static LIMIT_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[-_])limit([-_]|$)").expect("LIMIT_TOKEN is a valid regex"));

/// `/-?\d+/` from `rateLimitParser.ts:4`.
static INTEGER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-?[0-9]+").expect("INTEGER is a valid regex"));

/// `/^(\d+)([hdwm])$/i` from `rateLimitParser.ts:18`.
static WINDOW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]+)([hdwm])$").expect("WINDOW is a valid regex"));

/// `parseInteger` from `rateLimitParser.ts:3-8`.
///
/// `Number.parseInt(match[0], 10)` on the first `-?\d+` run. A run longer than
/// 2^53 rounds to the nearest `f64` in both languages, so the comparison of two
/// such values stays identical.
fn parse_integer(value: &str) -> Option<f64> {
    let matched = INTEGER.find(value)?.as_str();
    matched
        .parse::<f64>()
        .ok()
        .filter(|parsed| parsed.is_finite())
}

/// `extractWindowToken` from `rateLimitParser.ts:10-15`.
///
/// The name wins over the value, and the result is lowercased.
fn extract_window_token(header_name: &str, header_value: &str) -> Option<String> {
    let from_name = WINDOW_FROM_NAME
        .captures(&header_name.to_lowercase())
        .and_then(|captures| captures.get(1))
        .map(|token| token.as_str().to_lowercase());
    if from_name.is_some() {
        return from_name;
    }
    WINDOW_FROM_VALUE
        .captures(&header_value.to_lowercase())
        .and_then(|captures| captures.get(1))
        .map(|token| token.as_str().to_string())
}

/// `parseWindow` from `rateLimitParser.ts:17-24`: the unit rank orders `h < d <
/// w < m`, and an unreadable token sorts last in both parts.
fn parse_window(value: &str) -> (f64, f64) {
    let normalized = value.to_lowercase();
    let Some(captures) = WINDOW.captures(&normalized) else {
        return (MAX_SAFE_INTEGER, MAX_SAFE_INTEGER);
    };
    let amount = captures
        .get(1)
        .map(|amount| amount.as_str())
        .and_then(|amount| amount.parse::<f64>().ok())
        .unwrap_or(MAX_SAFE_INTEGER);
    let unit_rank = match captures.get(2).map(|unit| unit.as_str()) {
        Some("h") => 0.0,
        Some("d") => 1.0,
        Some("w") => 2.0,
        Some("m") => 3.0,
        _ => MAX_SAFE_INTEGER,
    };
    (amount, unit_rank)
}

/// `compareWindow` from `rateLimitParser.ts:26-33`.
fn compare_window(left: &str, right: &str) -> std::cmp::Ordering {
    let (left_amount, left_rank) = parse_window(left);
    let (right_amount, right_rank) = parse_window(right);
    left_rank
        .partial_cmp(&right_rank)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then(
            left_amount
                .partial_cmp(&right_amount)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
}

/// `headers.entries()` for a WHATWG `Headers`: one lowercased name per entry,
/// the values of a repeated name joined with `", "`, sorted by name.
fn combined_header_entries(headers: &HeaderMap) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();
    for name in headers.keys() {
        let values: Vec<&str> = headers
            .get_all(name)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect();
        if values.is_empty() {
            continue;
        }
        entries.push((name.as_str().to_lowercase(), values.join(", ")));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}

/// `parseCodexRateLimitsFromHeaders` from `rateLimitParser.ts:35-73`.
///
/// Only header names containing `ratelimit` are considered, and a name needs a
/// window token either in itself (`…-limit-1h`) or in its value (`…: 1h`). An
/// entry whose name carries `remaining`/`reset`/`limit` is recorded even when
/// its number cannot be parsed — that is how a bare `{ window }` entry reaches
/// the snapshot. The result is sorted by unit rank and then by amount, and
/// `None` is returned for an empty result.
pub fn parse_codex_rate_limits_from_headers(headers: &HeaderMap) -> Option<RateLimitSnapshot> {
    let mut windows: Vec<(String, RateLimitWindow)> = Vec::new();

    for (header_name, raw_value) in combined_header_entries(headers) {
        if !header_name.contains("ratelimit") {
            continue;
        }
        let value = raw_value.trim();
        if value.is_empty() {
            continue;
        }
        let Some(window) = extract_window_token(&header_name, value) else {
            continue;
        };

        let existing = windows.iter().position(|(key, _)| key == &window);
        let mut entry = match existing {
            Some(index) => windows[index].1.clone(),
            None => RateLimitWindow {
                window: window.clone(),
                ..Default::default()
            },
        };

        if REMAINING_TOKEN.is_match(&header_name) {
            if let Some(remaining) = parse_integer(value) {
                entry.remaining = Some(remaining);
            }
        } else if RESET_TOKEN.is_match(&header_name) {
            entry.reset = Some(value.to_string());
        } else if LIMIT_TOKEN.is_match(&header_name) {
            if let Some(limit) = parse_integer(value) {
                entry.limit = Some(limit);
            }
        } else {
            continue;
        }

        match existing {
            Some(index) => windows[index] = (window, entry),
            None => windows.push((window, entry)),
        }
    }

    if windows.is_empty() {
        return None;
    }

    windows.sort_by(|left, right| compare_window(&left.0, &right.0));
    Some(RateLimitSnapshot {
        windows: windows.into_iter().map(|(_, window)| window).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::header::{HeaderName, HeaderValue};

    fn headers(entries: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in entries {
            let name = HeaderName::from_bytes(name.as_bytes()).expect("valid header name");
            headers.append(
                name,
                HeaderValue::from_str(value).expect("valid header value"),
            );
        }
        headers
    }

    fn windows(snapshot: &RateLimitSnapshot) -> Vec<&RateLimitWindow> {
        snapshot.windows.iter().collect()
    }

    fn window_names(snapshot: &RateLimitSnapshot) -> Vec<&str> {
        snapshot
            .windows
            .iter()
            .map(|window| window.window.as_str())
            .collect()
    }

    #[test]
    fn a_window_is_built_from_the_name_token() {
        let snapshot = parse_codex_rate_limits_from_headers(&headers(&[
            ("x-codex-ratelimit-limit-1h", "100"),
            ("x-codex-ratelimit-remaining-1h", " 90 "),
            ("x-codex-ratelimit-reset-1h", "2026-01-01T00:00:00Z"),
        ]))
        .expect("snapshot");
        assert_eq!(windows(&snapshot).len(), 1);
        let window = windows(&snapshot)[0];
        assert_eq!(window.window, "1h");
        assert_eq!(window.limit, Some(100.0));
        assert_eq!(window.remaining, Some(90.0));
        assert_eq!(window.reset.as_deref(), Some("2026-01-01T00:00:00Z"));
    }

    /// `extractWindowToken` falls back to the value when the name has no token,
    /// and `parseInteger` then reads the *first* integer of the whole value —
    /// which is the window amount itself.
    #[test]
    fn a_window_falls_back_to_the_value_token() {
        let snapshot = parse_codex_rate_limits_from_headers(&headers(&[
            ("x-codex-ratelimit-limit", "60m"),
            ("x-codex-ratelimit-reset", "in 5d"),
        ]))
        .expect("snapshot");
        let parsed = windows(&snapshot);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].window, "5d");
        assert_eq!(parsed[0].reset.as_deref(), Some("in 5d"));
        assert_eq!(parsed[1].window, "60m");
        assert_eq!(parsed[1].limit, Some(60.0));

        let queued = parse_codex_rate_limits_from_headers(&headers(&[(
            "x-codex-ratelimit-limit",
            "1m;w=100",
        )]))
        .expect("snapshot");
        assert_eq!(windows(&queued)[0].limit, Some(1.0));
    }

    /// A name without `ratelimit`, or without any window token, is ignored.
    #[test]
    fn unrelated_headers_are_ignored() {
        assert_eq!(
            parse_codex_rate_limits_from_headers(&headers(&[
                ("content-type", "application/json"),
                ("x-ratelimit-limit", "100"),
                ("x-codex-ratelimit-limit-1h", "   "),
            ])),
            None
        );
    }

    /// An unreadable number still records the window, without that field.
    #[test]
    fn an_unreadable_number_keeps_the_window() {
        let snapshot = parse_codex_rate_limits_from_headers(&headers(&[
            ("x-codex-ratelimit-remaining-1h", "abc"),
            ("x-codex-ratelimit-limit-1h", "not-a-number"),
        ]))
        .expect("snapshot");
        let window = windows(&snapshot)[0];
        assert_eq!(window.window, "1h");
        assert_eq!(window.remaining, None);
        assert_eq!(window.limit, None);
    }

    /// `parseInteger` reads the first signed run, so a vendor suffix is ignored.
    #[test]
    fn a_signed_run_inside_the_value_is_parsed() {
        let snapshot = parse_codex_rate_limits_from_headers(&headers(&[
            ("x-codex-ratelimit-remaining-1h", "resets soon: -12"),
            ("x-codex-ratelimit-limit-1h", "0 requests"),
        ]))
        .expect("snapshot");
        let window = windows(&snapshot)[0];
        assert_eq!(window.remaining, Some(-12.0));
        assert_eq!(window.limit, Some(0.0));
    }

    /// Windows sort by unit rank `h < d < w < m`, then by amount.
    #[test]
    fn windows_sort_by_unit_rank_then_amount() {
        let snapshot = parse_codex_rate_limits_from_headers(&headers(&[
            ("x-ratelimit-limit-1w", "1"),
            ("x-ratelimit-limit-5h", "2"),
            ("x-ratelimit-limit-1m", "3"),
            ("x-ratelimit-limit-1d", "4"),
            ("x-ratelimit-limit-2h", "5"),
        ]))
        .expect("snapshot");
        assert_eq!(window_names(&snapshot), vec!["2h", "5h", "1d", "1w", "1m"]);
    }

    /// Two values of one name are combined with `", "`, exactly like
    /// `Headers.append`, and the first integer of the combined value wins.
    #[test]
    fn repeated_values_are_combined_and_the_first_integer_wins() {
        let snapshot = parse_codex_rate_limits_from_headers(&headers(&[
            ("x-codex-ratelimit-limit-1h", "100"),
            ("x-codex-ratelimit-limit-1h", "200"),
        ]))
        .expect("snapshot");
        assert_eq!(windows(&snapshot).len(), 1);
        assert_eq!(windows(&snapshot)[0].limit, Some(100.0));
    }

    /// A name that mentions only `reset` never sets another field, and a name
    /// that mentions no field token is skipped entirely.
    #[test]
    fn only_one_field_token_applies_per_header() {
        let snapshot = parse_codex_rate_limits_from_headers(&headers(&[
            ("x-codex-ratelimit-reset-1h", "1730000000"),
            ("x-codex-ratelimit-1h", "999"),
        ]))
        .expect("snapshot");
        let window = windows(&snapshot)[0];
        assert_eq!(window.reset.as_deref(), Some("1730000000"));
        assert_eq!(window.remaining, None);
        assert_eq!(window.limit, None);
    }

    /// A window token must be delimited in both the name and the value, and
    /// `s` is not a window unit.
    #[test]
    fn window_tokens_must_be_delimited() {
        assert_eq!(
            parse_codex_rate_limits_from_headers(&headers(&[
                ("x-ratelimit-limit-1h2h", "7"),
                ("x-ratelimit-limit-3s", "8"),
            ])),
            None
        );
    }

    #[test]
    fn integer_parsing_matches_number_parse_int() {
        assert_eq!(parse_integer("90s"), Some(90.0));
        assert_eq!(parse_integer("abc"), None);
        assert_eq!(parse_integer("--5"), Some(-5.0));
        assert_eq!(parse_integer("-0"), Some(-0.0));
    }

    /// JavaScript's `\w` — and therefore `\b` — is ASCII-only, so a non-ASCII
    /// letter counts as a non-word character and the token still matches. The
    /// `regex` crate default is Unicode-aware and would *not* find it, which is
    /// why the pattern carries `(?-u:…)`.
    ///
    /// This is asserted on the pattern itself, because a header value with a
    /// byte above 0x7E cannot travel through the `HeaderMap` seam: `HeaderValue`
    /// stores it but `to_str()` refuses it, while the TypeScript `Headers`
    /// object keeps the raw obs-text. For an ASCII value both word-boundary
    /// definitions agree, so the seam keeps the behaviour for every reachable
    /// input.
    #[test]
    fn the_value_word_boundary_is_ascii() {
        assert!(WINDOW_FROM_VALUE.is_match("ü5h"));
        assert!(!WINDOW_FROM_VALUE.is_match("u5h"));
        assert!(!Regex::new(r"\b([0-9]+[hdwm])\b")
            .expect("unicode pattern")
            .is_match("ü5h"));

        // Through the seam: an ASCII word character in front of the token
        // blocks it, and a plain token matches.
        assert_eq!(
            parse_codex_rate_limits_from_headers(&headers(&[("x-ratelimit-remaining", "u5h")])),
            None
        );
        let snapshot =
            parse_codex_rate_limits_from_headers(&headers(&[("x-ratelimit-remaining", "5h")]))
                .expect("snapshot");
        assert_eq!(window_names(&snapshot), vec!["5h"]);
        assert_eq!(windows(&snapshot)[0].remaining, Some(5.0));
    }
}
