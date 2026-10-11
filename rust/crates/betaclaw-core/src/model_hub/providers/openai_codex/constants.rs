//! Port of `src/server/model-hub/Models/openai-codex/constants.ts`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`CODEX_BASE_URL`] | `'https://chatgpt.com/backend-api'` (`constants.ts:1`) |
//! | [`CODEX_RESPONSES_PATH`] | `'/codex/responses'` (`constants.ts:2`) |
//! | [`CODEX_REQUEST_TIMEOUT_MS`] | `60_000` (`constants.ts:3`) |
//! | [`OPENAI_CODEX_AUTH_CLAIM_HINT`] | `'chatgpt_account_id'` (`constants.ts:4`) |
//! | [`DEFAULT_CODEX_INSTRUCTIONS`] | `'You are a helpful coding assistant.'` (`constants.ts:5`) |
//! | [`CODEX_MODEL_SEED`] | the 21 ids of `constants.ts:12-34` |
//!
//! [`CODEX_MODEL_SEED`] is duplicated here *and* in
//! [`crate::model_hub::provider_catalog::CODEX_MODEL_SEED`], because the catalog
//! spreads the same list into `defaultModels` (`providerCatalog.ts:33`). The
//! catalog module documents that duplication as an S4c obligation; the
//! consistency test lives with the catalog copy.

/// `CODEX_BASE_URL` from `constants.ts:1`.
pub const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api";
/// `CODEX_RESPONSES_PATH` from `constants.ts:2`.
pub const CODEX_RESPONSES_PATH: &str = "/codex/responses";
/// `CODEX_REQUEST_TIMEOUT_MS` from `constants.ts:3`.
pub const CODEX_REQUEST_TIMEOUT_MS: u64 = 60_000;
/// `OPENAI_CODEX_AUTH_CLAIM_HINT` from `constants.ts:4` — the JWT claim the
/// header builders require and name in their error message.
pub const OPENAI_CODEX_AUTH_CLAIM_HINT: &str = "chatgpt_account_id";
/// `DEFAULT_CODEX_INSTRUCTIONS` from `constants.ts:5`.
pub const DEFAULT_CODEX_INSTRUCTIONS: &str = "You are a helpful coding assistant.";

/// `CODEX_MODEL_SEED` from `constants.ts:12-34`.
///
/// The Codex backend exposes no model-list endpoint, so this static list is the
/// only model source `fetchModels` has.
pub const CODEX_MODEL_SEED: &[&str] = &[
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.2-pro",
    "gpt-5.1",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-pro",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o-mini",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::provider_catalog::CODEX_MODEL_SEED as CATALOG_SEED;

    /// `openai-codex-models.test.ts:40-64` pins the seed order and explicitly
    /// asserts that `gpt-5.2-codex` and `gpt-5.1-codex` are *not* present.
    #[test]
    fn seed_matches_the_typescript_list() {
        assert_eq!(CODEX_MODEL_SEED.len(), 21);
        assert_eq!(CODEX_MODEL_SEED[0], "gpt-5.6");
        assert_eq!(CODEX_MODEL_SEED[20], "gpt-4o-mini");
        assert!(!CODEX_MODEL_SEED.contains(&"gpt-5.2-codex"));
        assert!(!CODEX_MODEL_SEED.contains(&"gpt-5.1-codex"));
    }

    /// The catalog spreads the same list (`providerCatalog.ts:33`); the two Rust
    /// copies must stay identical.
    #[test]
    fn seed_equals_the_catalog_copy() {
        assert_eq!(CODEX_MODEL_SEED, CATALOG_SEED);
    }
}
