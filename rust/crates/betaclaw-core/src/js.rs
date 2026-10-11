//! JavaScript number semantics that more than one slice has to reproduce.
//!
//! The ported resolvers read environment strings and JSON numbers through the
//! JavaScript `Number()` and `Math.round()` functions. Rust's `f64::from_str`
//! and `f64::round` are *not* the same functions, so the differences are
//! reproduced here once instead of per slice.
//!
//! `js_number_str` lived in `memory/mem0.rs` until the World Model slice needed
//! it too; the function and its test moved here unchanged.

/// `Number(text)` for the environment strings of `client.ts:299-322`.
///
/// Reproduced: surrounding whitespace is trimmed, `''` is `0`,
/// `'Infinity'`/`'-Infinity'` are the infinities (JavaScript matches those
/// spellings case-sensitively), the `0x`/`0b`/`0o` literals parse in their base,
/// and everything else that `f64::from_str` would accept but JavaScript rejects
/// (`inf`, `infinity`, `nan`, any case) is `NaN`.
pub fn js_number_str(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let lowered = trimmed.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
        if let Some(digits) = lowered.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix)
                .map(|value| value as f64)
                .unwrap_or(f64::NAN);
        }
    }
    match lowered.as_str() {
        // `Number('inf')` is `NaN`; Rust's `f64::from_str` returns infinity.
        "inf" | "+inf" | "infinity" | "+infinity" | "-inf" | "-infinity" | "nan" | "+nan"
        | "-nan" => f64::NAN,
        _ => trimmed.parse::<f64>().unwrap_or(f64::NAN),
    }
}

/// `Math.round(value)`.
///
/// The specification is `floor(value + 0.5)` with a negative zero for
/// `-0.5 <= value < 0`; Rust's `f64::round` rounds halves *away from zero*, so
/// `Math.round(-12.5)` is `-12` while `(-12.5f64).round()` is `-13`. The port
/// follows the specification. The negative zero is not reproduced: `-0.0 == 0.0`
/// is true in both languages and every caller clamps the result into a positive
/// range, so it has no observable effect.
pub fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    (value + 0.5).floor()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Number(text)` for the environment strings (`client.ts:299-322`).
    #[test]
    fn js_number_str_follows_javascript_number() {
        assert_eq!(js_number_str("  15000  "), 15_000.0);
        assert_eq!(js_number_str(""), 0.0, "`Number('')` is 0");
        assert_eq!(js_number_str("1e3"), 1_000.0);
        assert_eq!(js_number_str("0x10"), 16.0);
        assert_eq!(js_number_str("0b101"), 5.0);
        assert_eq!(js_number_str("0o17"), 15.0);
        assert_eq!(js_number_str("Infinity"), f64::INFINITY);
        assert_eq!(js_number_str("-Infinity"), f64::NEG_INFINITY);
        assert!(js_number_str("-1.5").eq(&-1.5));
        assert!(js_number_str("abc").is_nan());
        assert!(js_number_str("15abc").is_nan());
        assert!(
            js_number_str("inf").is_nan(),
            "JavaScript does not accept lower-case infinity"
        );
        assert!(js_number_str("NaN").is_nan());
        assert!(js_number_str("0x").is_nan());
    }

    /// `Math.round` rounds halves towards `+Infinity` (`policy.ts`-style
    /// clamping in `config.ts:75`).
    #[test]
    fn js_round_rounds_halves_up() {
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(1.5), 2.0);
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(-1.5), -1.0);
        assert_eq!(js_round(-12.5), -12.0);
        assert_eq!(js_round(12.5), 13.0);
        assert_eq!(js_round(12.4), 12.0);
        assert_eq!(js_round(-12.6), -13.0);
        // Beyond 2^52 a half step is not representable, so the value is returned.
        assert_eq!(js_round(4_503_599_627_370_496.0), 4_503_599_627_370_496.0);
        assert!(js_round(f64::NAN).is_nan());
        assert_eq!(js_round(f64::INFINITY), f64::INFINITY);
    }
}
