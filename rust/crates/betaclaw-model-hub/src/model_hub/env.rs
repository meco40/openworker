//! Process-environment seam for slice S4 (Model Hub).
//!
//! The provider adapters read a handful of variables at call time, exactly like
//! `process.env` does in TypeScript:
//!
//! | Variable | Read by |
//! | --- | --- |
//! | `LMSTUDIO_BASE_URL` | `Models/lmstudio/index.ts:7` |
//! | `OLLAMA_BASE_URL` | `service/dispatch/embedding.ts:96` |
//! | `MODEL_HUB_GATEWAY_TIMEOUT_MS` | `Models/shared/http.ts:15` |
//! | `MODEL_HUB_GATEWAY_EXEC_TIMEOUT_MS` | `Models/shared/http.ts:22` |
//! | `MODEL_HUB_DB_PATH` | `repositories/sqliteModelHubRepository.ts:81` |
//!
//! [`EnvOverrides`] reads through to the process environment and lets a test pin a
//! value without touching global state, which `std::env::set_var` would do.

use std::collections::BTreeMap;

/// `process.env` with optional overrides.
#[derive(Debug, Clone, Default)]
pub struct EnvOverrides {
    overrides: BTreeMap<String, String>,
}

impl EnvOverrides {
    /// An empty override set: every lookup hits the real process environment.
    pub fn new() -> Self {
        Self::default()
    }

    /// Pins `key` for this instance only.
    pub fn with(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.overrides.insert(key.into(), value.into());
        self
    }

    /// `process.env[key]` with the override applied first.
    ///
    /// Returns an owned `String` because the fallback comes from the process
    /// environment, which has no lifetime relationship with `self`.
    pub fn get(&self, key: &str) -> Option<String> {
        self.overrides
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
    }

    /// `process.env[key] || fallback` — note that JavaScript's `||` also treats an
    /// empty string as absent, which is why the callers of the base-URL variables
    /// behave the same way for `LMSTUDIO_BASE_URL=''`.
    pub fn get_or(&self, key: &str, fallback: &str) -> String {
        self.get(key)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_win_over_the_process_environment() {
        let env = EnvOverrides::new().with("MODEL_HUB_GATEWAY_TIMEOUT_MS", "90000");
        assert_eq!(
            env.get("MODEL_HUB_GATEWAY_TIMEOUT_MS").as_deref(),
            Some("90000")
        );
    }

    #[test]
    fn an_empty_override_falls_back_like_javascript_or() {
        let env = EnvOverrides::new().with("LMSTUDIO_BASE_URL", "");
        assert_eq!(
            env.get_or("LMSTUDIO_BASE_URL", "http://localhost:1234/v1"),
            "http://localhost:1234/v1"
        );
    }

    #[test]
    fn unset_keys_return_none() {
        let env = EnvOverrides::new();
        assert_eq!(env.get("MODEL_HUB_TEST_VARIABLE_THAT_DOES_NOT_EXIST"), None);
        assert_eq!(
            env.get_or("MODEL_HUB_TEST_VARIABLE_THAT_DOES_NOT_EXIST", "d"),
            "d"
        );
    }
}
