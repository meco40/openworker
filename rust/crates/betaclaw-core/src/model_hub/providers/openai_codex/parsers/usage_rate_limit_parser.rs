//! Port of
//! `src/server/model-hub/Models/openai-codex/parsers/usageRateLimitParser.ts`.
//!
//! The `/wham/usage` payload reports the same windows with percentages instead
//! of header counters, so [`parse_codex_usage_rate_limits`] fills
//! `usedPercent`/`remainingPercent` where
//! [`super::rate_limit_parser`] fills `limit`/`remaining`.
//!
//! # Representation notes
//!
//! - `RateLimitWindow.used_percent` is an `f64` in the shared contract, so an
//!   integral percentage serialises as `7.0` where `JSON.stringify` of the
//!   TypeScript number prints `7`.
//! - `Math.round` rounds halves toward `+Infinity` while `f64::round` rounds
//!   them away from zero. The only difference is `-0.5`, and both callers clamp
//!   the result into `[0, 100]` afterwards, so the emitted value is identical.
//! - `String(Math.round(reset_at))` prints exponent notation from 1e21 upwards;
//!   such a timestamp is far outside the `i64` range, where the port saturates.

use serde_json::Value;

use crate::model_hub::types::{RateLimitSnapshot, RateLimitWindow};

const SECONDS_PER_DAY: f64 = 86_400.0;
const SECONDS_PER_HOUR: f64 = 3_600.0;
const SECONDS_PER_MINUTE: f64 = 60.0;

/// `asFiniteNumber` from `usageRateLimitParser.ts:9-12`.
fn as_finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

/// `toWindowLabel` from `usageRateLimitParser.ts:14-25`.
///
/// The label is the largest unit that divides the window evenly, and seconds
/// otherwise — never below `1s`.
fn to_window_label(seconds: f64) -> String {
    if seconds >= SECONDS_PER_DAY && seconds % SECONDS_PER_DAY == 0.0 {
        return format!("{}d", (seconds / SECONDS_PER_DAY).round() as i64);
    }
    if seconds >= SECONDS_PER_HOUR && seconds % SECONDS_PER_HOUR == 0.0 {
        return format!("{}h", (seconds / SECONDS_PER_HOUR).round() as i64);
    }
    if seconds >= SECONDS_PER_MINUTE && seconds % SECONDS_PER_MINUTE == 0.0 {
        return format!("{}m", (seconds / SECONDS_PER_MINUTE).round() as i64);
    }
    format!("{}s", seconds.round().max(1.0) as i64)
}

/// `mapWindow` from `usageRateLimitParser.ts:27-44`.
///
/// A window without a usable `used_percent` or `limit_window_seconds`, or with
/// a non-positive window length, is dropped (`null`).
fn map_window(payload: Option<&Value>) -> Option<RateLimitWindow> {
    let object = payload.and_then(Value::as_object)?;
    let used_percent_raw = as_finite_number(object.get("used_percent"))?;
    let window_seconds = as_finite_number(object.get("limit_window_seconds"))?;
    if window_seconds <= 0.0 {
        return None;
    }

    let used_percent = used_percent_raw.round().clamp(0.0, 100.0);
    let remaining_percent = (100.0 - used_percent).clamp(0.0, 100.0);
    let reset = as_finite_number(object.get("reset_at"))
        .map(|reset_at| (reset_at.round() as i64).to_string());

    Some(RateLimitWindow {
        window: to_window_label(window_seconds),
        limit: None,
        remaining: None,
        used_percent: Some(used_percent),
        remaining_percent: Some(remaining_percent),
        reset,
    })
}

/// `parseCodexUsageRateLimits` from `usageRateLimitParser.ts:46-62`.
///
/// Only `rate_limit.primary_window` and `rate_limit.secondary_window` are read,
/// in that order; `None` means "no usable window" rather than "no rate limits".
pub fn parse_codex_usage_rate_limits(payload: &Value) -> Option<RateLimitSnapshot> {
    let rate_limit = payload.get("rate_limit").and_then(Value::as_object)?;

    let windows: Vec<RateLimitWindow> = [
        map_window(rate_limit.get("primary_window")),
        map_window(rate_limit.get("secondary_window")),
    ]
    .into_iter()
    .flatten()
    .collect();

    if windows.is_empty() {
        return None;
    }
    Some(RateLimitSnapshot { windows })
}

/// Inserts or replaces one window, keyed by the lowercased window label.
///
/// `prefer_existing` mirrors `{ ...window, ...existing }` from
/// `usageRateLimitParser.ts:83-92`: the fields already in the map win, and only
/// the ones they leave `null`/`undefined` are taken from the new window.
fn upsert_window(
    windows: &mut Vec<(String, RateLimitWindow)>,
    key: String,
    window: RateLimitWindow,
    prefer_existing: bool,
) {
    let Some(index) = windows.iter().position(|(existing, _)| existing == &key) else {
        windows.push((key, window));
        return;
    };
    if !prefer_existing {
        windows[index].1 = window;
        return;
    }

    let existing = windows[index].1.clone();
    windows[index].1 = RateLimitWindow {
        window: if existing.window.is_empty() {
            window.window
        } else {
            existing.window
        },
        limit: existing.limit.or(window.limit),
        remaining: existing.remaining.or(window.remaining),
        used_percent: existing.used_percent.or(window.used_percent),
        remaining_percent: existing.remaining_percent.or(window.remaining_percent),
        reset: existing.reset.or(window.reset),
    };
}

/// `mergeRateLimitSnapshots` from `usageRateLimitParser.ts:64-96`.
///
/// The response headers win over the usage payload: for a window present in
/// both, every field the header window carries is kept and only its gaps are
/// filled from the usage window. Windows that exist in the secondary snapshot
/// only are appended after the primary ones, in their own order.
pub fn merge_rate_limit_snapshots(
    primary: Option<&RateLimitSnapshot>,
    secondary: Option<&RateLimitSnapshot>,
) -> Option<RateLimitSnapshot> {
    match (primary, secondary) {
        (None, None) => None,
        (Some(primary), None) => Some(primary.clone()),
        (None, Some(secondary)) => Some(secondary.clone()),
        (Some(primary), Some(secondary)) => {
            let mut windows: Vec<(String, RateLimitWindow)> = Vec::new();
            for window in &primary.windows {
                upsert_window(
                    &mut windows,
                    window.window.to_lowercase(),
                    window.clone(),
                    false,
                );
            }
            for window in &secondary.windows {
                upsert_window(
                    &mut windows,
                    window.window.to_lowercase(),
                    window.clone(),
                    true,
                );
            }
            Some(RateLimitSnapshot {
                windows: windows.into_iter().map(|(_, window)| window).collect(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn window_with(label: &str, used: f64) -> RateLimitWindow {
        RateLimitWindow {
            window: label.to_string(),
            limit: None,
            remaining: None,
            used_percent: Some(used),
            remaining_percent: Some(100.0 - used),
            reset: None,
        }
    }

    fn labels(snapshot: &RateLimitSnapshot) -> Vec<&str> {
        snapshot
            .windows
            .iter()
            .map(|window| window.window.as_str())
            .collect()
    }

    #[test]
    fn window_labels_follow_the_largest_even_unit() {
        assert_eq!(to_window_label(86_400.0), "1d");
        assert_eq!(to_window_label(604_800.0), "7d");
        assert_eq!(to_window_label(3_600.0), "1h");
        assert_eq!(to_window_label(18_000.0), "5h");
        assert_eq!(to_window_label(60.0), "1m");
        assert_eq!(to_window_label(1_800.0), "30m");
        // 90 seconds divides by 60, but not evenly, so seconds are reported.
        assert_eq!(to_window_label(90.0), "90s");
        // `Math.max(1, …)` keeps the label at one second.
        assert_eq!(to_window_label(0.4), "1s");
    }

    #[test]
    fn a_window_maps_percentages_and_reset() {
        let window = map_window(Some(&json!({
            "used_percent": 7.5,
            "limit_window_seconds": 604_800,
            "reset_at": 1_730_000_000.4
        })))
        .expect("window");
        assert_eq!(window.window, "7d");
        assert_eq!(window.used_percent, Some(8.0));
        assert_eq!(window.remaining_percent, Some(92.0));
        assert_eq!(window.reset.as_deref(), Some("1730000000"));
        assert_eq!(window.limit, None);
        assert_eq!(window.remaining, None);
    }

    /// Percentages are clamped into `[0, 100]`.
    #[test]
    fn percentages_are_clamped() {
        let over = map_window(Some(&json!({
            "used_percent": 140.2,
            "limit_window_seconds": 3600
        })))
        .expect("window");
        assert_eq!(over.used_percent, Some(100.0));
        assert_eq!(over.remaining_percent, Some(0.0));

        let under = map_window(Some(&json!({
            "used_percent": -12.0,
            "limit_window_seconds": 3600
        })))
        .expect("window");
        assert_eq!(under.used_percent, Some(0.0));
        assert_eq!(under.remaining_percent, Some(100.0));
    }

    #[test]
    fn a_window_needs_both_fields_and_a_positive_length() {
        assert_eq!(map_window(None), None);
        assert_eq!(map_window(Some(&json!([]))), None);
        assert_eq!(map_window(Some(&json!({ "used_percent": 10 }))), None);
        assert_eq!(
            map_window(Some(&json!({ "limit_window_seconds": 3600 }))),
            None
        );
        assert_eq!(
            map_window(Some(&json!({
                "used_percent": 10,
                "limit_window_seconds": 0
            }))),
            None
        );
        assert_eq!(
            map_window(Some(&json!({
                "used_percent": "10",
                "limit_window_seconds": 3600
            }))),
            None
        );
    }

    #[test]
    fn usage_limits_are_read_from_both_windows_in_order() {
        let snapshot = parse_codex_usage_rate_limits(&json!({
            "rate_limit": {
                "primary_window": { "used_percent": 10, "limit_window_seconds": 18000 },
                "secondary_window": { "used_percent": 90, "limit_window_seconds": 604800 }
            }
        }))
        .expect("snapshot");
        assert_eq!(labels(&snapshot), vec!["5h", "7d"]);
    }

    /// A missing or unusable window is simply absent; without any window the
    /// whole snapshot is `None`.
    #[test]
    fn usage_limits_ignore_missing_windows() {
        assert_eq!(parse_codex_usage_rate_limits(&json!(null)), None);
        assert_eq!(parse_codex_usage_rate_limits(&json!({})), None);
        assert_eq!(
            parse_codex_usage_rate_limits(&json!({ "rate_limit": null })),
            None
        );
        assert_eq!(
            parse_codex_usage_rate_limits(&json!({ "rate_limit": {} })),
            None
        );

        let only_secondary = parse_codex_usage_rate_limits(&json!({
            "rate_limit": {
                "primary_window": null,
                "secondary_window": { "used_percent": 1, "limit_window_seconds": 60 }
            }
        }))
        .expect("snapshot");
        assert_eq!(labels(&only_secondary), vec!["1m"]);
    }

    /// Headers win per field, and usage-only windows are appended.
    #[test]
    fn the_header_window_wins_per_field() {
        let primary = RateLimitSnapshot {
            windows: vec![RateLimitWindow {
                window: "1H".to_string(),
                limit: Some(100.0),
                remaining: Some(90.0),
                used_percent: None,
                remaining_percent: None,
                reset: Some("later".to_string()),
            }],
        };
        let secondary = RateLimitSnapshot {
            windows: vec![window_with("1h", 10.0), window_with("7d", 40.0)],
        };

        let merged = merge_rate_limit_snapshots(Some(&primary), Some(&secondary)).expect("merged");
        assert_eq!(labels(&merged), vec!["1H", "7d"]);
        let first = &merged.windows[0];
        assert_eq!(first.limit, Some(100.0));
        assert_eq!(first.remaining, Some(90.0));
        assert_eq!(first.reset.as_deref(), Some("later"));
        // Only the fields the header window lacks come from the usage window.
        assert_eq!(first.used_percent, Some(10.0));
        assert_eq!(first.remaining_percent, Some(90.0));
        assert_eq!(merged.windows[1].used_percent, Some(40.0));
    }

    #[test]
    fn merging_one_sided_snapshots_clones_them() {
        let only_primary = RateLimitSnapshot {
            windows: vec![window_with("1h", 1.0)],
        };
        assert_eq!(
            merge_rate_limit_snapshots(Some(&only_primary), None),
            Some(only_primary.clone())
        );
        assert_eq!(
            merge_rate_limit_snapshots(None, Some(&only_primary)),
            Some(only_primary.clone())
        );
        assert_eq!(merge_rate_limit_snapshots(None, None), None);
    }
}
