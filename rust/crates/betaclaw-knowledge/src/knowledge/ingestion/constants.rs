//! Port of `src/server/knowledge/ingestion/constants.ts` (1-53).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW` (`:5`) | [`MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW`] |
//! | `MEM0_MAX_GLOBAL_FAILURES_PER_CYCLE` (`:10`) | [`MEM0_MAX_GLOBAL_FAILURES_PER_CYCLE`] |
//! | `MEM0_RATE_LIMIT_DELAY_MS` (`:16`) | [`MEM0_RATE_LIMIT_DELAY_MS`] |
//! | `MEM0_FAILURE_BACKOFF_BASE_MS` (`:22`) | [`MEM0_FAILURE_BACKOFF_BASE_MS`] |
//! | `MEM0_STORE_FACT_TIMEOUT_MS` (`:34-38`) | [`mem0_store_fact_timeout_ms`] |
//! | `DEFAULT_RELATION_CONFIDENCE` (`:40-43`) | [`DEFAULT_RELATION_CONFIDENCE`] |
//! | `DEFAULT_EVENT_CONFIDENCE` (`:45-48`) | [`DEFAULT_EVENT_CONFIDENCE`] |
//! | `DEFAULT_TOPIC_KEY` (`:50-53`) | [`DEFAULT_TOPIC_KEY`] |
//! | `GERMAN_SELF_REFERENCES` / `ENGLISH_SELF_REFERENCES` (`:55-63`) | the same names below |
//!
//! # Deviation
//!
//! The TypeScript evaluates `MEM0_STORE_FACT_TIMEOUT_MS` once, at module load.
//! The port reads `MEM0_STORE_FACT_TIMEOUT_MS` once, on first use, through a
//! `LazyLock`, which is the same moment for a process.

use std::sync::LazyLock;

use serde_json::Value;

use crate::knowledge::js_compat::js_number;

/// Consecutive Mem0 failures before the circuit opens for a window
/// (`constants.ts:5`).
pub const MEM0_MAX_CONSECUTIVE_FAILURES_PER_WINDOW: usize = 2;

/// Cumulative Mem0 failures across one `runOnce()` cycle (`constants.ts:10`).
pub const MEM0_MAX_GLOBAL_FAILURES_PER_CYCLE: usize = 5;

/// Delay between Mem0 store calls, in milliseconds (`constants.ts:16`).
pub const MEM0_RATE_LIMIT_DELAY_MS: u64 = 250;

/// Base backoff after a Mem0 store failure, in milliseconds. It doubles per
/// consecutive failure (`constants.ts:22`).
pub const MEM0_FAILURE_BACKOFF_BASE_MS: u64 = 2000;

/// The per-fact timeout as the TypeScript computes it (`constants.ts:34-38`):
/// `MEM0_STORE_FACT_TIMEOUT_MS` from the environment, default 60 000, clamped to
/// `1 000..=300 000`. A non-finite value gives the default.
pub fn mem0_store_fact_timeout_ms_from(env_value: Option<&str>) -> u64 {
    const DEFAULT: u64 = 60_000;
    // `process.env.X ?? 60_000`: an unset variable gives the default, while an
    // empty string gives `Number("") = 0`, which clamps up to 1 000.
    let parsed = match env_value {
        None => DEFAULT as f64,
        Some(text) => js_number(Some(&Value::String(text.to_string()))),
    };
    if parsed.is_finite() {
        parsed.clamp(1_000.0, 300_000.0) as u64
    } else {
        DEFAULT
    }
}

/// `MEM0_STORE_FACT_TIMEOUT_MS`, read from the environment once.
pub static MEM0_STORE_FACT_TIMEOUT_MS: LazyLock<u64> = LazyLock::new(|| {
    mem0_store_fact_timeout_ms_from(std::env::var("MEM0_STORE_FACT_TIMEOUT_MS").ok().as_deref())
});

/// Default confidence of an entity relation (`constants.ts:40-43`).
pub const DEFAULT_RELATION_CONFIDENCE: f64 = 0.8;

/// Default confidence of an event (`constants.ts:45-48`).
pub const DEFAULT_EVENT_CONFIDENCE: f64 = 0.85;

/// Topic key when none is given (`constants.ts:50-53`).
pub const DEFAULT_TOPIC_KEY: &str = "general-meeting";

/// German self-reference terms for persona identity (`constants.ts:55-58`).
pub const GERMAN_SELF_REFERENCES: &[&str] = &["ich", "mein", "meine"];

/// English self-reference terms for persona identity (`constants.ts:60-63`).
pub const ENGLISH_SELF_REFERENCES: &[&str] = &["me", "myself"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_timeout_defaults_and_clamps() {
        assert_eq!(mem0_store_fact_timeout_ms_from(None), 60_000);
        assert_eq!(mem0_store_fact_timeout_ms_from(Some("15000")), 15_000);
        assert_eq!(mem0_store_fact_timeout_ms_from(Some("5")), 1_000);
        assert_eq!(mem0_store_fact_timeout_ms_from(Some("999999")), 300_000);
        assert_eq!(mem0_store_fact_timeout_ms_from(Some("abc")), 60_000);
        // `Number("")` is 0, which clamps up to the minimum, as in JavaScript.
        assert_eq!(mem0_store_fact_timeout_ms_from(Some("")), 1_000);
    }
}
