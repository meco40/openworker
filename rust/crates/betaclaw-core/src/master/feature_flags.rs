//! Port of `src/server/master/featureFlags.ts:1-33`.
//!
//! Five boolean rollout switches read straight from the process environment.
//! The set of "off" spellings is load-bearing for operators: any of `0`,
//! `false`, `off`, `no` (after trim + lower-case) disables a flag, every other
//! non-empty value enables it, and an unset/blank value falls back to the
//! function's default. The port reproduces that ladder exactly.
//!
//! # Ambient environment becomes a parameter
//!
//! The TypeScript functions default to `process.env`
//! (`featureFlags.ts:15,19,23,27,31`). Rust has no ambient mutable environment,
//! so the port takes the environment as an explicit [`MasterEnv`] argument and
//! [`process_env`] builds that map from `std::env` for production callers. This
//! is the same deliberate deviation the S6 port applies to
//! `getWorldModelScope()`: pass in what the source read globally.

use std::collections::HashMap;

/// `NodeJS.ProcessEnv` — the flat key → value map of the environment.
pub type MasterEnv = HashMap<String, String>;

/// Snapshot of the current process environment.
///
/// Stands in for the `= process.env` default of the TypeScript functions.
pub fn process_env() -> MasterEnv {
    std::env::vars().collect()
}

/// `normalizeFlagValue` from `featureFlags.ts:1-5`.
///
/// `String(value ?? '').trim().toLowerCase()`.
fn normalize_flag_value(value: Option<&str>) -> String {
    value.unwrap_or("").trim().to_lowercase()
}

/// `isEnabledFlag` from `featureFlags.ts:7-13`.
///
/// A blank value returns `default_value`; otherwise the four "off" spellings
/// disable and anything else enables.
fn is_enabled_flag(value: Option<&str>, default_value: bool) -> bool {
    let normalized = normalize_flag_value(value);
    if normalized.is_empty() {
        return default_value;
    }
    !matches!(normalized.as_str(), "0" | "false" | "off" | "no")
}

/// `isMasterSystemPersonaEnabled` from `featureFlags.ts:15-17`.
pub fn is_master_system_persona_enabled(env: &MasterEnv) -> bool {
    is_enabled_flag(
        env.get("MASTER_SYSTEM_PERSONA_ENABLED").map(String::as_str),
        true,
    )
}

/// `isMasterGenericRuntimeEnabled` from `featureFlags.ts:19-21`.
pub fn is_master_generic_runtime_enabled(env: &MasterEnv) -> bool {
    is_enabled_flag(
        env.get("MASTER_GENERIC_RUNTIME_ENABLED")
            .map(String::as_str),
        true,
    )
}

/// `isMasterApprovalControlPlaneEnabled` from `featureFlags.ts:23-25`.
pub fn is_master_approval_control_plane_enabled(env: &MasterEnv) -> bool {
    is_enabled_flag(
        env.get("MASTER_APPROVAL_CONTROL_PLANE_ENABLED")
            .map(String::as_str),
        true,
    )
}

/// `isMasterSubagentSessionsEnabled` from `featureFlags.ts:27-29`.
pub fn is_master_subagent_sessions_enabled(env: &MasterEnv) -> bool {
    is_enabled_flag(
        env.get("MASTER_SUBAGENT_SESSIONS_ENABLED")
            .map(String::as_str),
        true,
    )
}

/// `isMasterOperatorEventsEnabled` from `featureFlags.ts:31-33`.
pub fn is_master_operator_events_enabled(env: &MasterEnv) -> bool {
    is_enabled_flag(
        env.get("MASTER_OPERATOR_EVENTS_ENABLED")
            .map(String::as_str),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> MasterEnv {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn defaults_are_true_when_unset() {
        let empty = env(&[]);
        assert!(is_master_system_persona_enabled(&empty));
        assert!(is_master_generic_runtime_enabled(&empty));
        assert!(is_master_approval_control_plane_enabled(&empty));
        assert!(is_master_subagent_sessions_enabled(&empty));
        assert!(is_master_operator_events_enabled(&empty));
    }

    #[test]
    fn blank_value_falls_back_to_default() {
        assert!(is_enabled_flag(Some("   "), true));
        assert!(!is_enabled_flag(Some(""), false));
        assert!(is_enabled_flag(None, true));
    }

    #[test]
    fn off_spellings_disable() {
        for value in ["0", "false", "off", "no"] {
            assert!(!is_enabled_flag(Some(value), true), "{value} must disable");
        }
    }

    #[test]
    fn case_and_whitespace_are_normalized() {
        assert!(!is_enabled_flag(Some("  FALSE  "), true));
        assert!(!is_enabled_flag(Some("Off"), true));
        assert!(is_enabled_flag(Some("TRUE"), false));
        assert!(is_enabled_flag(Some("1"), false));
    }

    #[test]
    fn every_flag_reads_its_own_variable() {
        let env = env(&[
            ("MASTER_SYSTEM_PERSONA_ENABLED", "false"),
            ("MASTER_GENERIC_RUNTIME_ENABLED", "no"),
            ("MASTER_APPROVAL_CONTROL_PLANE_ENABLED", "0"),
            ("MASTER_SUBAGENT_SESSIONS_ENABLED", "off"),
            ("MASTER_OPERATOR_EVENTS_ENABLED", ""),
        ]);
        assert!(!is_master_system_persona_enabled(&env));
        assert!(!is_master_generic_runtime_enabled(&env));
        assert!(!is_master_approval_control_plane_enabled(&env));
        assert!(!is_master_subagent_sessions_enabled(&env));
        assert!(is_master_operator_events_enabled(&env));
    }
}
