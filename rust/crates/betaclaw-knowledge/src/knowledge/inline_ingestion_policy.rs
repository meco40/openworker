//! Port of `src/server/knowledge/inlineIngestionPolicy.ts` (1-19).
//!
//! | TypeScript                                                    | Rust |
//! | ------------------------------------------------------------- | ---- |
//! | `inlineIngestionPolicy.ts:1-9` (`EnvLike`, `parseBoolean`)     | [`crate::knowledge::config::parse_boolean`], [`EnvLike`] |
//! | `inlineIngestionPolicy.ts:11-13` (`isInlineKnowledgeIngestionEnabled`) | [`is_inline_knowledge_ingestion_enabled`] |
//! | `inlineIngestionPolicy.ts:15-19` (`isKnowledgePreIngestOnRecallEnabled`) | [`is_knowledge_pre_ingest_on_recall_enabled`] |
//!
//! `parseBoolean` is byte-identical to the helper `config.ts:57-64` already
//! carries, so the port reuses [`crate::knowledge::config::parse_boolean`]
//! instead of duplicating it. Both flags default to `false`.
//!
//! # Deviation
//!
//! `env` defaults to `process.env` in the source
//! (`inlineIngestionPolicy.ts:11`). `betaclaw-core` reads the process
//! environment through the caller's map only — there is no `process.env`
//! singleton at this layer — so both functions take the map explicitly. The
//! gateway passes `std::env::vars()` through [`EnvLike`].

/// `type EnvLike = Record<string, string | undefined>` (`inlineIngestionPolicy.ts:1`).
pub type EnvLike = std::collections::HashMap<String, String>;

/// `isInlineKnowledgeIngestionEnabled(env)` (`inlineIngestionPolicy.ts:11-13`).
pub fn is_inline_knowledge_ingestion_enabled(env: &EnvLike) -> bool {
    crate::knowledge::config::parse_boolean(
        env.get("KNOWLEDGE_INLINE_INGESTION_ENABLED")
            .map(String::as_str),
        false,
    )
}

/// `isKnowledgePreIngestOnRecallEnabled(env)` (`inlineIngestionPolicy.ts:15-19`).
pub fn is_knowledge_pre_ingest_on_recall_enabled(env: &EnvLike) -> bool {
    crate::knowledge::config::parse_boolean(
        env.get("KNOWLEDGE_PRE_INGEST_ON_RECALL")
            .map(String::as_str),
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> EnvLike {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn both_flags_default_to_false() {
        let empty = EnvLike::new();
        assert!(!is_inline_knowledge_ingestion_enabled(&empty));
        assert!(!is_knowledge_pre_ingest_on_recall_enabled(&empty));
    }

    #[test]
    fn the_four_truthy_spellings_enable_the_flag() {
        for value in ["1", "true", "yes", "on", " TRUE ", "YES"] {
            assert!(
                is_inline_knowledge_ingestion_enabled(&env(&[(
                    "KNOWLEDGE_INLINE_INGESTION_ENABLED",
                    value
                )])),
                "{value}"
            );
        }
        for value in ["0", "false", "no", "off", "2", ""] {
            assert!(!is_inline_knowledge_ingestion_enabled(&env(&[(
                "KNOWLEDGE_INLINE_INGESTION_ENABLED",
                value
            )])));
        }
    }

    #[test]
    fn the_two_flags_do_not_share_a_key() {
        let only_pre_ingest = env(&[("KNOWLEDGE_PRE_INGEST_ON_RECALL", "true")]);
        assert!(is_knowledge_pre_ingest_on_recall_enabled(&only_pre_ingest));
        assert!(!is_inline_knowledge_ingestion_enabled(&only_pre_ingest));
    }
}
