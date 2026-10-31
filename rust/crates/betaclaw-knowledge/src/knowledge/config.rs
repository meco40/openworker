//! Port of `src/server/knowledge/config.ts`.
//!
//! | TypeScript                                  | Rust |
//! | ------------------------------------------- | ---- |
//! | `config.ts:1-27` (`KnowledgeConfig`)         | [`KnowledgeConfig`] |
//! | `config.ts:29` (`EnvLike`)                   | the `&HashMap<String, String>` of [`resolve_knowledge_config`] |
//! | `config.ts:31-36` (bounds)                   | the `MIN_*`/`MAX_*` constants |
//! | `config.ts:38-55` (`KNOWLEDGE_DEFAULT_CONFIG`)| [`KnowledgeConfig::default`] |
//! | `config.ts:57-63` (`parseBoolean`)           | [`parse_boolean`] |
//! | `config.ts:65-74` (`clampNumber`)            | [`clamp_number`] |
//! | `config.ts:76-146` (`resolveKnowledgeConfig`) | [`resolve_knowledge_config`] |
//! | `config.ts:148-150` (`getKnowledgeConfig`)   | [`get_knowledge_config`] |
//!
//! # What the resolver must reproduce exactly
//!
//! * `parseBoolean` (`config.ts:57-63`) accepts only `1`, `true`, `yes` and `on`
//!   (case-insensitive, trimmed). Anything else — including `false` and `0` — is
//!   `false`, and only an absent or empty value falls back.
//! * `clampNumber` (`config.ts:65-74`) is `Number(value)`, a finiteness check and
//!   `Math.min(max, Math.max(min, Math.round(parsed)))`. `Number('')` is `0`, so an
//!   empty variable clamps to the minimum instead of falling back;
//!   `Number('abc')` is `NaN` and does fall back. `Number(undefined)` is `NaN`,
//!   which is why an absent key is [`Option::None`] here, not `Some("")`.
//! * The clamping order matters: `Math.max(min, …)` runs *before* the outer
//!   `Math.min(max, …)`, so a `min` above `max` would still win; the port keeps
//!   that order.
//!
//! # Deviation
//!
//! `Math.round(parsed)` is [`crate::js::js_round`] and `Number(value)` is
//! [`crate::js::js_number_str`], because Rust's `f64::round` rounds halves away
//! from zero while JavaScript rounds them towards `+Infinity`.

use std::collections::HashMap;

use crate::js::{js_number_str, js_round};

/// `MIN_CONTEXT_TOKENS` from `config.ts:31`.
pub const MIN_CONTEXT_TOKENS: i64 = 200;
/// `MAX_CONTEXT_TOKENS` from `config.ts:32`.
pub const MAX_CONTEXT_TOKENS: i64 = 8000;
/// `MIN_INGEST_INTERVAL_MS` from `config.ts:33`.
pub const MIN_INGEST_INTERVAL_MS: i64 = 60_000;
/// `MAX_INGEST_INTERVAL_MS` from `config.ts:34`.
pub const MAX_INGEST_INTERVAL_MS: i64 = 3_600_000;
/// `MIN_MESSAGES_PER_BATCH` from `config.ts:35`.
pub const MIN_MESSAGES_PER_BATCH: i64 = 1;
/// `MAX_MESSAGES_PER_BATCH` from `config.ts:36`.
pub const MAX_MESSAGES_PER_BATCH: i64 = 50;

/// `KnowledgeConfig` from `config.ts:1-27`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnowledgeConfig {
    // Phase 1 (existing)
    pub layer_enabled: bool,
    pub ledger_enabled: bool,
    pub episode_enabled: bool,
    pub retrieval_enabled: bool,
    pub max_context_tokens: i64,
    pub ingest_interval_ms: i64,
    pub min_messages_per_batch: i64,

    // Phase 3: Memory Reliability
    pub contradiction_detection_enabled: bool,
    pub correction_detection_enabled: bool,

    // Phase 5: Dynamic Recall + Summaries
    pub dynamic_recall_budget_enabled: bool,
    pub conversation_summary_enabled: bool,
    pub memory_consolidation_enabled: bool,

    // Phase 6: Persona Type Awareness
    pub persona_type_awareness_enabled: bool,

    // Phase 7: Domain Features
    pub emotion_tracking_enabled: bool,
    pub project_tracking_enabled: bool,
    pub task_tracking_enabled: bool,
}

/// `KNOWLEDGE_DEFAULT_CONFIG` from `config.ts:38-55`.
impl Default for KnowledgeConfig {
    fn default() -> Self {
        Self {
            layer_enabled: false,
            ledger_enabled: false,
            episode_enabled: false,
            retrieval_enabled: false,
            max_context_tokens: 4000,
            ingest_interval_ms: 600_000,
            min_messages_per_batch: 1,
            contradiction_detection_enabled: false,
            correction_detection_enabled: false,
            dynamic_recall_budget_enabled: false,
            conversation_summary_enabled: false,
            memory_consolidation_enabled: false,
            persona_type_awareness_enabled: false,
            emotion_tracking_enabled: false,
            project_tracking_enabled: false,
            task_tracking_enabled: false,
        }
    }
}

/// `parseBoolean` (`config.ts:57-63`).
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

/// `clampNumber` (`config.ts:65-74`).
///
/// `Number(value)` then `Math.min(max, Math.max(min, Math.round(parsed)))`. The
/// inner `max(min, …)` runs first, exactly like the source.
pub fn clamp_number(value: Option<&str>, fallback: i64, min: i64, max: i64) -> i64 {
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

/// `resolveKnowledgeConfig` (`config.ts:76-146`).
///
/// Every switch is `parseBoolean(env.KEY, default)` and every number is
/// `clampNumber(env.KEY, default, min, max)`; the port applies both to the same
/// keys in the same order as the source.
pub fn resolve_knowledge_config(env: &HashMap<String, String>) -> KnowledgeConfig {
    let get = |key: &str| env.get(key).map(String::as_str);
    let defaults = KnowledgeConfig::default();

    KnowledgeConfig {
        layer_enabled: parse_boolean(get("KNOWLEDGE_LAYER_ENABLED"), defaults.layer_enabled),
        ledger_enabled: parse_boolean(get("KNOWLEDGE_LEDGER_ENABLED"), defaults.ledger_enabled),
        episode_enabled: parse_boolean(get("KNOWLEDGE_EPISODE_ENABLED"), defaults.episode_enabled),
        retrieval_enabled: parse_boolean(
            get("KNOWLEDGE_RETRIEVAL_ENABLED"),
            defaults.retrieval_enabled,
        ),
        max_context_tokens: clamp_number(
            get("KNOWLEDGE_MAX_CONTEXT_TOKENS"),
            defaults.max_context_tokens,
            MIN_CONTEXT_TOKENS,
            MAX_CONTEXT_TOKENS,
        ),
        ingest_interval_ms: clamp_number(
            get("KNOWLEDGE_INGEST_INTERVAL_MS"),
            defaults.ingest_interval_ms,
            MIN_INGEST_INTERVAL_MS,
            MAX_INGEST_INTERVAL_MS,
        ),
        min_messages_per_batch: clamp_number(
            get("KNOWLEDGE_MIN_MESSAGES_PER_BATCH"),
            defaults.min_messages_per_batch,
            MIN_MESSAGES_PER_BATCH,
            MAX_MESSAGES_PER_BATCH,
        ),
        contradiction_detection_enabled: parse_boolean(
            get("KNOWLEDGE_CONTRADICTION_DETECTION"),
            defaults.contradiction_detection_enabled,
        ),
        correction_detection_enabled: parse_boolean(
            get("KNOWLEDGE_CORRECTION_DETECTION"),
            defaults.correction_detection_enabled,
        ),
        dynamic_recall_budget_enabled: parse_boolean(
            get("KNOWLEDGE_DYNAMIC_RECALL_BUDGET"),
            defaults.dynamic_recall_budget_enabled,
        ),
        conversation_summary_enabled: parse_boolean(
            get("KNOWLEDGE_CONVERSATION_SUMMARY"),
            defaults.conversation_summary_enabled,
        ),
        memory_consolidation_enabled: parse_boolean(
            get("KNOWLEDGE_MEMORY_CONSOLIDATION"),
            defaults.memory_consolidation_enabled,
        ),
        persona_type_awareness_enabled: parse_boolean(
            get("KNOWLEDGE_PERSONA_TYPE_AWARENESS"),
            defaults.persona_type_awareness_enabled,
        ),
        emotion_tracking_enabled: parse_boolean(
            get("KNOWLEDGE_EMOTION_TRACKING"),
            defaults.emotion_tracking_enabled,
        ),
        project_tracking_enabled: parse_boolean(
            get("KNOWLEDGE_PROJECT_TRACKING"),
            defaults.project_tracking_enabled,
        ),
        task_tracking_enabled: parse_boolean(
            get("KNOWLEDGE_TASK_TRACKING"),
            defaults.task_tracking_enabled,
        ),
    }
}

/// `getKnowledgeConfig` (`config.ts:148-150`).
///
/// The TypeScript default argument is `process.env`; the Rust reader takes the
/// whole environment explicitly, because the slice never reads the ambient
/// process anywhere else either.
pub fn get_knowledge_config(env: &HashMap<String, String>) -> KnowledgeConfig {
    resolve_knowledge_config(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty environment resolves to `KNOWLEDGE_DEFAULT_CONFIG`.
    #[test]
    fn an_empty_environment_returns_the_defaults() {
        let config = resolve_knowledge_config(&HashMap::new());
        assert_eq!(config, KnowledgeConfig::default());
        assert!(!config.layer_enabled);
        assert_eq!(config.max_context_tokens, 4000);
        assert_eq!(config.ingest_interval_ms, 600_000);
    }

    /// `parseBoolean` answers `true` only for the four documented spellings and
    /// falls back for an absent or empty value.
    #[test]
    fn parse_boolean_follows_the_typescript_table() {
        for truthy in ["1", "true", "TRUE", " yes ", "On"] {
            assert!(parse_boolean(Some(truthy), false), "{truthy:?}");
        }
        for falsy in ["0", "false", "off", "no", "enabled", "2"] {
            assert!(!parse_boolean(Some(falsy), true), "{falsy:?}");
        }
        assert!(parse_boolean(None, true), "absent falls back");
        // The TypeScript is `if (!normalized) return fallback;`, so an empty or
        // blank value answers the *fallback* — `true` here, not `false`.
        assert!(parse_boolean(Some(""), true), "empty answers the fallback");
        assert!(
            parse_boolean(Some("   "), true),
            "blank answers the fallback"
        );
        assert!(
            !parse_boolean(Some(""), false),
            "empty answers the fallback"
        );
    }

    /// `clampNumber`: `Number('')` is `0` and therefore clamps to the minimum,
    /// while an absent key and `Number('abc')` fall back.
    #[test]
    fn clamp_number_follows_javascript_number_semantics() {
        // `Number('')` is 0 → `Math.max(min, 0)` → min.
        assert_eq!(clamp_number(Some(""), 4000, 200, 8000), 200);
        assert_eq!(clamp_number(None, 4000, 200, 8000), 4000);
        assert_eq!(clamp_number(Some("abc"), 4000, 200, 8000), 4000);
        assert_eq!(clamp_number(Some("100"), 4000, 200, 8000), 200);
        assert_eq!(clamp_number(Some("99999"), 4000, 200, 8000), 8000);
        // `Math.round(2500.5)` is 2501 in JavaScript, not 2500.
        assert_eq!(clamp_number(Some("2500.5"), 0, 0, 8000), 2501);
        assert_eq!(clamp_number(Some("2500.4"), 0, 0, 8000), 2500);
    }

    /// The full resolver reads every key and honours the clamps.
    #[test]
    fn the_resolver_reads_every_key() {
        let mut env = HashMap::new();
        env.insert("KNOWLEDGE_LAYER_ENABLED".to_string(), "true".to_string());
        env.insert("KNOWLEDGE_LEDGER_ENABLED".to_string(), "on".to_string());
        env.insert("KNOWLEDGE_EPISODE_ENABLED".to_string(), "yes".to_string());
        env.insert("KNOWLEDGE_RETRIEVAL_ENABLED".to_string(), "1".to_string());
        env.insert(
            "KNOWLEDGE_MAX_CONTEXT_TOKENS".to_string(),
            "1234".to_string(),
        );
        env.insert(
            "KNOWLEDGE_INGEST_INTERVAL_MS".to_string(),
            "120000".to_string(),
        );
        env.insert(
            "KNOWLEDGE_MIN_MESSAGES_PER_BATCH".to_string(),
            "5".to_string(),
        );
        env.insert(
            "KNOWLEDGE_CONTRADICTION_DETECTION".to_string(),
            "true".to_string(),
        );
        env.insert(
            "KNOWLEDGE_CORRECTION_DETECTION".to_string(),
            "true".to_string(),
        );
        env.insert(
            "KNOWLEDGE_DYNAMIC_RECALL_BUDGET".to_string(),
            "true".to_string(),
        );
        env.insert(
            "KNOWLEDGE_CONVERSATION_SUMMARY".to_string(),
            "true".to_string(),
        );
        env.insert(
            "KNOWLEDGE_MEMORY_CONSOLIDATION".to_string(),
            "true".to_string(),
        );
        env.insert(
            "KNOWLEDGE_PERSONA_TYPE_AWARENESS".to_string(),
            "true".to_string(),
        );
        env.insert("KNOWLEDGE_EMOTION_TRACKING".to_string(), "true".to_string());
        env.insert("KNOWLEDGE_PROJECT_TRACKING".to_string(), "true".to_string());
        env.insert("KNOWLEDGE_TASK_TRACKING".to_string(), "true".to_string());

        let config = resolve_knowledge_config(&env);
        assert!(config.layer_enabled);
        assert!(config.ledger_enabled);
        assert!(config.episode_enabled);
        assert!(config.retrieval_enabled);
        assert_eq!(config.max_context_tokens, 1234);
        assert_eq!(config.ingest_interval_ms, 120_000);
        assert_eq!(config.min_messages_per_batch, 5);
        assert!(config.contradiction_detection_enabled);
        assert!(config.correction_detection_enabled);
        assert!(config.dynamic_recall_budget_enabled);
        assert!(config.conversation_summary_enabled);
        assert!(config.memory_consolidation_enabled);
        assert!(config.persona_type_awareness_enabled);
        assert!(config.emotion_tracking_enabled);
        assert!(config.project_tracking_enabled);
        assert!(config.task_tracking_enabled);
    }

    /// The numeric bounds are the TypeScript literals; drifting one changes
    /// which value a deployment actually reads.
    #[test]
    fn the_bounds_match_the_typescript_values() {
        assert_eq!(MIN_CONTEXT_TOKENS, 200);
        assert_eq!(MAX_CONTEXT_TOKENS, 8000);
        assert_eq!(MIN_INGEST_INTERVAL_MS, 60_000);
        assert_eq!(MAX_INGEST_INTERVAL_MS, 3_600_000);
        assert_eq!(MIN_MESSAGES_PER_BATCH, 1);
        assert_eq!(MAX_MESSAGES_PER_BATCH, 50);
    }
}
