//! Port of `src/server/world-model/mem0Policy.ts` — the Mem0 reduction policy.
//!
//! The five predicates read `getWorldModelConfig()` (`mem0Policy.ts:15`, `:19`,
//! `:23`), which resolves the environment on every call. The port makes the
//! resolved [`WorldModelConfig`] a parameter, so the policy is a pure function of
//! the configuration. Every list and every branch is copied verbatim.

use crate::world_model::config::WorldModelConfig;
use crate::world_model::mode::WorldModelMode;

/// `isMem0PrimaryMemory` (`mem0Policy.ts:14-16`).
pub fn is_mem0_primary_memory(config: &WorldModelConfig) -> bool {
    !config.mem0_preferences_only
}

/// `isMem0PreferencesOnly` (`mem0Policy.ts:18-20`).
pub fn is_mem0_preferences_only(config: &WorldModelConfig) -> bool {
    config.mem0_preferences_only
}

/// `isMem0FactualWriteBlocked` (`mem0Policy.ts:22-25`).
pub fn is_mem0_factual_write_blocked(config: &WorldModelConfig) -> bool {
    config.mem0_preferences_only || config.mode == WorldModelMode::Canonical
}

/// `allowedMem0Types` (`mem0Policy.ts:27-32`).
///
/// The blocked list is the four preference-shaped types; the unblocked list adds
/// `fact` and `lesson`. Keep both in source order — callers assert membership,
/// but a diff of the lists is how a reviewer sees that the policy changed.
pub fn allowed_mem0_types(config: &WorldModelConfig) -> Vec<&'static str> {
    if is_mem0_factual_write_blocked(config) {
        return vec![
            "preference",
            "avoidance",
            "personality_trait",
            "workflow_pattern",
        ];
    }
    vec![
        "fact",
        "preference",
        "avoidance",
        "personality_trait",
        "workflow_pattern",
        "lesson",
    ]
}

/// `isMem0TypeAllowed` (`mem0Policy.ts:34-36`).
pub fn is_mem0_type_allowed(config: &WorldModelConfig, memory_type: &str) -> bool {
    allowed_mem0_types(config).contains(&memory_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_keeps_mem0_primary() {
        let config = WorldModelConfig::default();
        // `mem0PreferencesOnly` defaults to false, so Mem0 is primary.
        assert!(is_mem0_primary_memory(&config));
        assert!(!is_mem0_preferences_only(&config));
        assert!(!is_mem0_factual_write_blocked(&config));
        assert!(is_mem0_type_allowed(&config, "fact"));
        assert!(is_mem0_type_allowed(&config, "lesson"));
        assert_eq!(allowed_mem0_types(&config).len(), 6);
    }

    #[test]
    fn preferences_only_blocks_factual_writes() {
        let config = WorldModelConfig {
            mem0_preferences_only: true,
            ..WorldModelConfig::default()
        };
        assert!(!is_mem0_primary_memory(&config));
        assert!(is_mem0_preferences_only(&config));
        assert!(is_mem0_factual_write_blocked(&config));
        assert!(!is_mem0_type_allowed(&config, "fact"));
        assert!(!is_mem0_type_allowed(&config, "lesson"));
        assert!(is_mem0_type_allowed(&config, "preference"));
        assert_eq!(
            allowed_mem0_types(&config),
            vec![
                "preference",
                "avoidance",
                "personality_trait",
                "workflow_pattern"
            ]
        );
    }

    #[test]
    fn canonical_mode_blocks_factual_writes_without_the_flag() {
        let config = WorldModelConfig {
            mode: WorldModelMode::Canonical,
            ..WorldModelConfig::default()
        };
        assert!(!config.mem0_preferences_only);
        assert!(is_mem0_factual_write_blocked(&config));
        assert_eq!(allowed_mem0_types(&config).len(), 4);
    }

    #[test]
    fn an_unknown_type_is_never_allowed() {
        let config = WorldModelConfig::default();
        assert!(!is_mem0_type_allowed(&config, "event"));
        assert!(!is_mem0_type_allowed(&config, ""));
    }
}
