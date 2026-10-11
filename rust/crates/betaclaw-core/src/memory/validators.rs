//! Port of `src/server/memory/validators/typeValidators.ts`.
//!
//! Every helper reads an unconstrained metadata value and coerces it, because
//! the memory bag is written by the memory service itself *and* by callers that
//! hand the API arbitrary JSON. The port therefore takes
//! `Option<&serde_json::Value>` and reproduces the JavaScript coercions
//! (`Number.isFinite`, `Math.round`, `Math.floor`) instead of rejecting a
//! wrong-shaped input.

use serde_json::Value;

use super::constants::{MAX_CONFIDENCE, MAX_IMPORTANCE, MIN_CONFIDENCE, MIN_IMPORTANCE};
use super::errors::pick_string;
use super::types::{js_number, MemoryType, LEGACY_LOCAL_USER_ID};

/// `resolveUserId` from `typeValidators.ts:5-8`.
pub fn resolve_user_id(user_id: Option<&str>) -> String {
    let normalized = user_id.unwrap_or("").trim();
    if normalized.is_empty() {
        LEGACY_LOCAL_USER_ID.to_string()
    } else {
        normalized.to_string()
    }
}

/// `Math.round` for finite values: `floor(x + 0.5)`.
///
/// Rust's `f64::round` rounds half *away from zero*, so `-2.5` becomes `-3`,
/// while JavaScript yields `-2`. The clamp `Math.max(1, …)` in
/// [`as_importance`] hides the difference for every value this slice reads, but
/// the helper is still the exact port so the arithmetic is not silently changed.
pub fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `Math.floor` for finite values.
pub fn js_floor(value: f64) -> f64 {
    value.floor()
}

/// `asMemoryType` from `typeValidators.ts:10-21`.
///
/// The allowed list is checked against the trimmed text; anything else is
/// `fact`.
pub fn as_memory_type(value: Option<&Value>) -> MemoryType {
    pick_string(value)
        .as_deref()
        .and_then(MemoryType::parse)
        .unwrap_or(MemoryType::Fact)
}

/// `asImportance` from `typeValidators.ts:23-27`.
pub fn as_importance(value: Option<&Value>, fallback: f64) -> f64 {
    let parsed = js_number(value);
    if !parsed.is_finite() {
        return fallback;
    }
    clamp(js_round(parsed), MIN_IMPORTANCE, MAX_IMPORTANCE)
}

/// `asConfidence` from `typeValidators.ts:29-33`.
pub fn as_confidence(value: Option<&Value>, fallback: f64) -> f64 {
    let parsed = js_number(value);
    if !parsed.is_finite() {
        return fallback;
    }
    clamp(parsed, MIN_CONFIDENCE, MAX_CONFIDENCE)
}

/// `asFeedbackCount` from `typeValidators.ts:35-39`.
pub fn as_feedback_count(value: Option<&Value>) -> f64 {
    let parsed = js_number(value);
    if !parsed.is_finite() || parsed < 0.0 {
        return 0.0;
    }
    js_floor(parsed)
}

/// `asVersion` from `typeValidators.ts:41-45`.
pub fn as_version(value: Option<&Value>, fallback: i64) -> i64 {
    let parsed = js_number(value);
    if !parsed.is_finite() || parsed < 1.0 {
        return fallback;
    }
    js_floor(parsed) as i64
}

/// `Math.min(max, Math.max(min, value))`.
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    max.min(min.max(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `resolveUserId` is the tenant boundary of the SQLite store: an empty or
    /// whitespace-only id must land on the legacy constant, never on `""`.
    #[test]
    fn an_absent_user_id_falls_back_to_the_legacy_constant() {
        assert_eq!(resolve_user_id(None), LEGACY_LOCAL_USER_ID);
        assert_eq!(resolve_user_id(Some("")), LEGACY_LOCAL_USER_ID);
        assert_eq!(resolve_user_id(Some("   ")), LEGACY_LOCAL_USER_ID);
        assert_eq!(resolve_user_id(Some(" u-1 ")), "u-1");
    }

    #[test]
    fn importance_is_rounded_and_clamped() {
        assert_eq!(as_importance(Some(&json!(3.4)), 3.0), 3.0);
        assert_eq!(
            as_importance(Some(&json!(3.5)), 3.0),
            4.0,
            "JS rounds half up"
        );
        assert_eq!(as_importance(Some(&json!(99)), 3.0), 5.0);
        assert_eq!(as_importance(Some(&json!(-4)), 3.0), 1.0);
        assert_eq!(as_importance(Some(&json!("abc")), 3.0), 3.0);
        assert_eq!(as_importance(None, 3.0), 3.0);
    }

    /// The lower clamp is what keeps a NaN, a `null` and a missing key apart
    /// from each other only through the caller-supplied fallback.
    #[test]
    fn confidence_keeps_its_bounds_without_rounding() {
        assert_eq!(as_confidence(Some(&json!(0.25)), 0.5), 0.25);
        assert_eq!(as_confidence(Some(&json!(2)), 0.5), 1.0);
        assert_eq!(as_confidence(Some(&json!(-1)), 0.5), 0.1);
        assert_eq!(as_confidence(Some(&json!("x")), 0.5), 0.5);
        assert_eq!(as_confidence(None, 0.5), 0.5);
    }

    #[test]
    fn feedback_count_and_version_have_separate_guards() {
        assert_eq!(as_feedback_count(Some(&json!(2.9))), 2.0);
        assert_eq!(as_feedback_count(Some(&json!(-1))), 0.0);
        assert_eq!(as_feedback_count(Some(&json!("3"))), 3.0);
        assert_eq!(as_feedback_count(None), 0.0);

        assert_eq!(as_version(Some(&json!(4.7)), 1), 4);
        assert_eq!(as_version(Some(&json!(0)), 1), 1);
        assert_eq!(as_version(Some(&json!("nope")), 1), 1);
        assert_eq!(as_version(None, 1), 1);
    }

    #[test]
    fn an_unknown_memory_type_becomes_fact() {
        assert_eq!(as_memory_type(Some(&json!("lesson"))), MemoryType::Lesson);
        assert_eq!(as_memory_type(Some(&json!(" lesson "))), MemoryType::Lesson);
        assert_eq!(as_memory_type(Some(&json!("bogus"))), MemoryType::Fact);
        assert_eq!(as_memory_type(Some(&json!(""))), MemoryType::Fact);
        assert_eq!(as_memory_type(None), MemoryType::Fact);
    }

    /// `Math.round(-2.5) === -2`, while `f64::round` gives `-3`; the clamp hides
    /// it, but the port keeps the JavaScript rounding rule.
    #[test]
    fn rounding_follows_javascript_not_rust_defaults() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(1.5), 2.0);
        assert_eq!(clamp(7.0, 1.0, 5.0), 5.0);
        assert_eq!(clamp(-7.0, 1.0, 5.0), 1.0);
    }
}
