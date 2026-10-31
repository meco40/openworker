//! Port of `src/server/world-model/config.ts`.
//!
//! # What the resolver must reproduce exactly
//!
//! * The legacy switches are read through `parseBoolean` (`config.ts:59-65`),
//!   which accepts only `1`, `true`, `yes` and `on` (case-insensitive, trimmed).
//!   Anything else — including `false` and `0` — is `false`, and only an absent or
//!   empty value falls back.
//! * `parseNumber` (`config.ts:67-76`) is `Number(value)`, a finiteness check and
//!   `Math.min(max, Math.max(min, Math.round(parsed)))`. `Number('')` is `0`, so an
//!   empty variable clamps to the minimum instead of falling back;
//!   `Number('abc')` is `NaN` and does fall back.
//! * `quietHours` is **not** rounded (`config.ts:182-189`): `22.5-6` yields
//!   `{start: 22.5, end: 6}`. The port keeps `f64` for both bounds.
//! * The mode wins over the legacy flags when `WORLD_MODEL_MODE` is set, and the
//!   legacy flags still feed three fields (`config.ts:95-101`, `:109`, `:135`,
//!   `:157`), which is why this resolver cannot be replaced by
//!   [`WorldModelMode`](crate::world_model::mode::WorldModelMode) alone.

use std::collections::HashMap;

use crate::js::{js_number_str, js_round};
use crate::world_model::mode::{mode_from_legacy_flags, parse_world_model_mode, WorldModelMode};

/// `DEFAULT_DATABASE_URL` from `config.ts:34`.
pub const WORLD_MODEL_DEFAULT_DATABASE_URL: &str =
    "postgresql://clawtest:clawtest@127.0.0.1:5434/clawtest";

/// `runtimeRole: 'app' | 'worker'` from `config.ts:11`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeRole {
    App,
    Worker,
}

impl RuntimeRole {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeRole::App => "app",
            RuntimeRole::Worker => "worker",
        }
    }

    pub fn is_worker(self) -> bool {
        matches!(self, RuntimeRole::Worker)
    }
}

/// `quietHours: { start: number; end: number } | null` from `config.ts:28`.
///
/// Both bounds are `f64` because the TypeScript does not round them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuietHours {
    pub start: f64,
    pub end: f64,
}

/// `WorldModelConfig` from `config.ts:9-30`.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldModelConfig {
    pub enabled: bool,
    pub runtime_role: RuntimeRole,
    pub database_url: String,
    pub pool_max: i64,
    pub pool_idle_timeout_ms: i64,
    pub outbox_poll_interval_ms: i64,
    pub outbox_batch_size: i64,
    pub ingestion_bridge_enabled: bool,
    pub heartbeat_interval_ms: i64,
    pub e2e_enabled: bool,
    pub graphiti_shadow_enabled: bool,
    pub graphiti_backend_enabled: bool,
    pub graphiti_recall_enabled: bool,
    pub mem0_preferences_only: bool,
    pub mode: WorldModelMode,
    pub prospective_interval_ms: i64,
    pub user_active_window_ms: i64,
    pub daily_proactive_budget: i64,
    pub quiet_hours: Option<QuietHours>,
    pub canary_scopes: Vec<String>,
}

/// `WORLD_MODEL_DEFAULT_CONFIG` from `config.ts:36-57`.
impl Default for WorldModelConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            runtime_role: RuntimeRole::App,
            database_url: WORLD_MODEL_DEFAULT_DATABASE_URL.to_string(),
            pool_max: 10,
            pool_idle_timeout_ms: 30_000,
            outbox_poll_interval_ms: 10_000,
            outbox_batch_size: 100,
            ingestion_bridge_enabled: false,
            heartbeat_interval_ms: 60_000,
            e2e_enabled: false,
            graphiti_shadow_enabled: false,
            graphiti_backend_enabled: false,
            graphiti_recall_enabled: false,
            mem0_preferences_only: false,
            mode: WorldModelMode::Off,
            prospective_interval_ms: 60_000,
            user_active_window_ms: 300_000,
            daily_proactive_budget: 10,
            quiet_hours: None,
            canary_scopes: Vec::new(),
        }
    }
}

/// `parseBoolean` (`config.ts:59-65`).
///
/// `String(value || '').trim().toLowerCase()` — an absent *or* empty value falls
/// back, every other value answers `true` only for the four spellings below.
pub fn parse_boolean(value: Option<&str>, fallback: bool) -> bool {
    let normalized = value.unwrap_or("").trim().to_lowercase();
    if normalized.is_empty() {
        return fallback;
    }
    matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
}

/// `parseNumber` (`config.ts:67-76`).
pub fn parse_number(value: Option<&str>, fallback: i64, min: i64, max: i64) -> i64 {
    let parsed = match value {
        Some(text) => js_number_str(text),
        None => f64::NAN,
    };
    if !parsed.is_finite() {
        return fallback;
    }
    let clamped = js_round(parsed).max(min as f64).min(max as f64);
    clamped as i64
}

/// `parseCanaryScopes` (`config.ts:78-83`).
pub fn parse_canary_scopes(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or("")
        .split(',')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect()
}

/// `parseQuietHours` (`config.ts:182-189`).
///
/// The two bounds are *not* rounded and the range check accepts a fractional
/// hour, exactly like the TypeScript.
pub fn parse_quiet_hours(value: Option<&str>) -> Option<QuietHours> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    let parts: Vec<f64> = value.split('-').map(js_number_str).collect();
    if parts.len() != 2 || parts.iter().any(|part| !part.is_finite()) {
        return None;
    }
    let (start, end) = (parts[0], parts[1]);
    if !(0.0..=23.0).contains(&start) || !(0.0..=23.0).contains(&end) {
        return None;
    }
    Some(QuietHours { start, end })
}

/// `value || fallback` over environment strings (`config.ts:111-115`).
fn first_non_empty<'a>(values: &[Option<&'a str>]) -> Option<&'a str> {
    values
        .iter()
        .flatten()
        .find(|value| !value.is_empty())
        .copied()
}

/// `resolveWorldModelConfig` (`config.ts:85-180`).
pub fn resolve_world_model_config(env: &HashMap<String, String>) -> WorldModelConfig {
    let get = |key: &str| env.get(key).map(String::as_str);
    let defaults = WorldModelConfig::default();

    let legacy_enabled = parse_boolean(get("WORLD_MODEL_ENABLED"), defaults.enabled);
    let legacy_bridge_enabled = parse_boolean(
        get("WORLD_MODEL_INGESTION_BRIDGE"),
        defaults.ingestion_bridge_enabled,
    );
    let legacy_mem0_preferences_only = parse_boolean(
        get("WORLD_MODEL_MEM0_PREFERENCES_ONLY"),
        defaults.mem0_preferences_only,
    );
    // `env.WORLD_MODEL_MODE?.trim() ? parse(...) : modeFromLegacyFlags(...)`
    // (`config.ts:95-101`): a blank value takes the legacy path, and the mode is
    // parsed from the trimmed text.
    let mode = match get("WORLD_MODEL_MODE").map(str::trim) {
        Some(trimmed) if !trimmed.is_empty() => parse_world_model_mode(Some(trimmed)),
        _ => mode_from_legacy_flags(
            legacy_enabled,
            legacy_bridge_enabled,
            legacy_mem0_preferences_only,
        ),
    };
    let runtime_role = if get("WORLD_MODEL_RUNTIME_ROLE") == Some("worker") {
        RuntimeRole::Worker
    } else {
        RuntimeRole::App
    };
    // `roleDatabaseUrl` (`config.ts:103-106`), then the three-step `||` chain of
    // `config.ts:111-115`.
    let role_database_url = if runtime_role.is_worker() {
        get("WORLD_MODEL_WORKER_DATABASE_URL")
    } else {
        get("WORLD_MODEL_APP_DATABASE_URL")
    };

    WorldModelConfig {
        enabled: legacy_enabled || mode.is_active(),
        runtime_role,
        database_url: first_non_empty(&[
            role_database_url,
            get("CANONICAL_DATABASE_URL"),
            get("DATABASE_URL"),
        ])
        .unwrap_or(WORLD_MODEL_DEFAULT_DATABASE_URL)
        .to_string(),
        pool_max: parse_number(get("WORLD_MODEL_POOL_MAX"), defaults.pool_max, 1, 100),
        pool_idle_timeout_ms: parse_number(
            get("WORLD_MODEL_POOL_IDLE_TIMEOUT_MS"),
            defaults.pool_idle_timeout_ms,
            1_000,
            300_000,
        ),
        outbox_poll_interval_ms: parse_number(
            get("WORLD_MODEL_OUTBOX_POLL_INTERVAL_MS"),
            defaults.outbox_poll_interval_ms,
            1_000,
            300_000,
        ),
        outbox_batch_size: parse_number(
            get("WORLD_MODEL_OUTBOX_BATCH_SIZE"),
            defaults.outbox_batch_size,
            1,
            5_000,
        ),
        ingestion_bridge_enabled: legacy_bridge_enabled || mode.is_active(),
        heartbeat_interval_ms: parse_number(
            get("WORLD_MODEL_HEARTBEAT_INTERVAL_MS"),
            defaults.heartbeat_interval_ms,
            5_000,
            3_600_000,
        ),
        e2e_enabled: parse_boolean(get("WORLD_MODEL_E2E"), defaults.e2e_enabled),
        graphiti_shadow_enabled: parse_boolean(
            get("GRAPHITI_SHADOW_ENABLED"),
            defaults.graphiti_shadow_enabled,
        ),
        // `GRAPHITI_PROJECTOR_ENABLED ?? GRAPHITI_ENABLED` (`config.ts:148`).
        graphiti_backend_enabled: parse_boolean(
            get("GRAPHITI_PROJECTOR_ENABLED").or_else(|| get("GRAPHITI_ENABLED")),
            defaults.graphiti_backend_enabled,
        ),
        graphiti_recall_enabled: parse_boolean(
            get("GRAPHITI_RECALL_ENABLED"),
            defaults.graphiti_recall_enabled,
        ),
        mem0_preferences_only: legacy_mem0_preferences_only || mode.is_canonical(),
        mode,
        prospective_interval_ms: parse_number(
            get("WORLD_MODEL_PROSPECTIVE_INTERVAL_MS"),
            defaults.prospective_interval_ms,
            1_000,
            3_600_000,
        ),
        user_active_window_ms: parse_number(
            get("WORLD_MODEL_USER_ACTIVE_WINDOW_MS"),
            defaults.user_active_window_ms,
            1_000,
            3_600_000,
        ),
        daily_proactive_budget: parse_number(
            get("WORLD_MODEL_DAILY_PROACTIVE_BUDGET"),
            defaults.daily_proactive_budget,
            0,
            10_000,
        ),
        quiet_hours: parse_quiet_hours(get("WORLD_MODEL_QUIET_HOURS")),
        canary_scopes: parse_canary_scopes(get("WORLD_MODEL_CANARY_SCOPES")),
    }
}

/// `getWorldModelConfig` (`config.ts:191-193`).
pub fn get_world_model_config() -> WorldModelConfig {
    world_model_config_from_process_env()
}

/// `getWorldModelConfig()` against `process.env`.
pub fn world_model_config_from_process_env() -> WorldModelConfig {
    let env: HashMap<String, String> = std::env::vars().collect();
    resolve_world_model_config(&env)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn defaults_match_the_typescript_table() {
        let defaults = WorldModelConfig::default();
        assert!(!defaults.enabled);
        assert_eq!(defaults.runtime_role, RuntimeRole::App);
        assert_eq!(defaults.database_url, WORLD_MODEL_DEFAULT_DATABASE_URL);
        assert_eq!(defaults.pool_max, 10);
        assert_eq!(defaults.pool_idle_timeout_ms, 30_000);
        assert_eq!(defaults.outbox_poll_interval_ms, 10_000);
        assert_eq!(defaults.outbox_batch_size, 100);
        assert!(!defaults.ingestion_bridge_enabled);
        assert_eq!(defaults.heartbeat_interval_ms, 60_000);
        assert!(!defaults.e2e_enabled);
        assert!(!defaults.graphiti_shadow_enabled);
        assert!(!defaults.graphiti_backend_enabled);
        assert!(!defaults.graphiti_recall_enabled);
        assert!(!defaults.mem0_preferences_only);
        assert_eq!(defaults.mode, WorldModelMode::Off);
        assert_eq!(defaults.prospective_interval_ms, 60_000);
        assert_eq!(defaults.user_active_window_ms, 300_000);
        assert_eq!(defaults.daily_proactive_budget, 10);
        assert_eq!(defaults.quiet_hours, None);
        assert!(defaults.canary_scopes.is_empty());
        // An empty environment resolves to the default table.
        assert_eq!(resolve_world_model_config(&env(&[])), defaults);
    }

    #[test]
    fn parse_boolean_only_accepts_the_four_spellings() {
        assert!(parse_boolean(Some("1"), false));
        assert!(parse_boolean(Some("TRUE"), false));
        assert!(parse_boolean(Some(" yes "), false));
        assert!(parse_boolean(Some("On"), false));
        // Everything else is false, including the fallback spelling.
        assert!(!parse_boolean(Some("false"), true));
        assert!(!parse_boolean(Some("0"), true));
        assert!(!parse_boolean(Some("no"), true));
        assert!(!parse_boolean(Some("enabled"), true));
        // Absent or empty falls back.
        assert!(parse_boolean(None, true));
        assert!(parse_boolean(Some(""), true));
        assert!(parse_boolean(Some("   "), true));
    }

    #[test]
    fn parse_number_follows_number_and_math_round() {
        assert_eq!(parse_number(Some("25"), 10, 1, 100), 25);
        assert_eq!(parse_number(Some("12.5"), 10, 1, 100), 13);
        assert_eq!(parse_number(Some("12.4"), 10, 1, 100), 12);
        assert_eq!(parse_number(Some("500"), 10, 1, 100), 100, "clamped to max");
        assert_eq!(parse_number(Some("0"), 10, 1, 100), 1, "clamped to min");
        // `Number('')` is 0, which clamps instead of falling back.
        assert_eq!(parse_number(Some(""), 10, 1, 100), 1);
        // `Number('abc')` is NaN, which falls back.
        assert_eq!(parse_number(Some("abc"), 10, 1, 100), 10);
        assert_eq!(parse_number(None, 10, 1, 100), 10);
        assert_eq!(parse_number(Some("0x10"), 10, 1, 100), 16);
    }

    #[test]
    fn canary_scopes_split_trim_and_drop_empties() {
        assert_eq!(
            parse_canary_scopes(Some(" u1:p1 , ,, u2:p2 ")),
            vec!["u1:p1".to_string(), "u2:p2".to_string()]
        );
        assert!(parse_canary_scopes(Some("")).is_empty());
        assert!(parse_canary_scopes(None).is_empty());
    }

    #[test]
    fn quiet_hours_keep_fractional_bounds_and_reject_bad_input() {
        assert_eq!(
            parse_quiet_hours(Some("22-6")),
            Some(QuietHours {
                start: 22.0,
                end: 6.0
            })
        );
        // Not rounded, like `config.ts:182-189`.
        assert_eq!(
            parse_quiet_hours(Some("22.5-6")),
            Some(QuietHours {
                start: 22.5,
                end: 6.0
            })
        );
        assert_eq!(parse_quiet_hours(Some("22-6-1")), None);
        assert_eq!(parse_quiet_hours(Some("-1-5")), None, "three parts");
        assert_eq!(parse_quiet_hours(Some("abc-6")), None);
        assert_eq!(parse_quiet_hours(Some("24-6")), None);
        assert_eq!(parse_quiet_hours(Some("22-24")), None);
        assert_eq!(parse_quiet_hours(Some("")), None);
        assert_eq!(parse_quiet_hours(None), None);
    }

    #[test]
    fn the_explicit_mode_supersedes_the_legacy_flags() {
        // `WORLD_MODEL_ENABLED=true` alone is still `off` in the legacy mapping.
        let enabled_only = resolve_world_model_config(&env(&[("WORLD_MODEL_ENABLED", "true")]));
        assert_eq!(enabled_only.mode, WorldModelMode::Off);
        assert!(!enabled_only.ingestion_bridge_enabled);

        let canonical = resolve_world_model_config(&env(&[("WORLD_MODEL_MODE", "canonical")]));
        assert_eq!(canonical.mode, WorldModelMode::Canonical);
        assert!(canonical.enabled);
        assert!(canonical.ingestion_bridge_enabled);
        assert!(canonical.mem0_preferences_only);

        let shadow = resolve_world_model_config(&env(&[
            ("WORLD_MODEL_ENABLED", "true"),
            ("WORLD_MODEL_INGESTION_BRIDGE", "true"),
        ]));
        assert_eq!(shadow.mode, WorldModelMode::Shadow);
        assert!(shadow.enabled);
        assert!(shadow.ingestion_bridge_enabled);
        assert!(!shadow.mem0_preferences_only);

        // A blank mode value takes the legacy path (`config.ts:95`).
        let blank = resolve_world_model_config(&env(&[
            ("WORLD_MODEL_MODE", "   "),
            ("WORLD_MODEL_INGESTION_BRIDGE", "1"),
        ]));
        assert_eq!(blank.mode, WorldModelMode::Shadow);
    }

    #[test]
    fn the_database_url_follows_the_role_and_the_fallback_chain() {
        let worker = resolve_world_model_config(&env(&[
            ("WORLD_MODEL_RUNTIME_ROLE", "worker"),
            ("WORLD_MODEL_WORKER_DATABASE_URL", "postgres://worker"),
            ("WORLD_MODEL_APP_DATABASE_URL", "postgres://app"),
        ]));
        assert_eq!(worker.runtime_role, RuntimeRole::Worker);
        assert_eq!(worker.database_url, "postgres://worker");

        let app = resolve_world_model_config(&env(&[
            ("WORLD_MODEL_APP_DATABASE_URL", "postgres://app"),
            ("CANONICAL_DATABASE_URL", "postgres://canonical"),
        ]));
        assert_eq!(app.runtime_role, RuntimeRole::App);
        assert_eq!(app.database_url, "postgres://app");

        // The role is compared with `===`, so it is not trimmed.
        let untrimmed = resolve_world_model_config(&env(&[
            ("WORLD_MODEL_RUNTIME_ROLE", " worker "),
            ("WORLD_MODEL_APP_DATABASE_URL", "postgres://app"),
        ]));
        assert_eq!(untrimmed.runtime_role, RuntimeRole::App);

        let canonical =
            resolve_world_model_config(&env(&[("CANONICAL_DATABASE_URL", "postgres://canonical")]));
        assert_eq!(canonical.database_url, "postgres://canonical");

        // An empty role URL is falsy and falls through.
        let empty_role = resolve_world_model_config(&env(&[
            ("WORLD_MODEL_APP_DATABASE_URL", ""),
            ("DATABASE_URL", "postgres://legacy"),
        ]));
        assert_eq!(empty_role.database_url, "postgres://legacy");
    }

    #[test]
    fn graphiti_projector_wins_over_the_general_enabled_switch() {
        let projector = resolve_world_model_config(&env(&[
            ("GRAPHITI_PROJECTOR_ENABLED", "0"),
            ("GRAPHITI_ENABLED", "true"),
        ]));
        // `?? ` only skips `null`/`undefined`, so an explicit `0` wins.
        assert!(!projector.graphiti_backend_enabled);

        let enabled = resolve_world_model_config(&env(&[("GRAPHITI_ENABLED", "true")]));
        assert!(enabled.graphiti_backend_enabled);
    }

    #[test]
    fn scoped_values_are_read_from_the_matching_keys() {
        let config = resolve_world_model_config(&env(&[
            ("WORLD_MODEL_POOL_MAX", "25"),
            ("WORLD_MODEL_DAILY_PROACTIVE_BUDGET", "3"),
            ("WORLD_MODEL_CANARY_SCOPES", "u:p,w:q"),
            ("WORLD_MODEL_QUIET_HOURS", "23-7"),
            ("WORLD_MODEL_E2E", "true"),
        ]));
        assert_eq!(config.pool_max, 25);
        assert_eq!(config.daily_proactive_budget, 3);
        assert_eq!(
            config.canary_scopes,
            vec!["u:p".to_string(), "w:q".to_string()]
        );
        assert_eq!(
            config.quiet_hours,
            Some(QuietHours {
                start: 23.0,
                end: 7.0
            })
        );
        assert!(config.e2e_enabled);
    }
}
