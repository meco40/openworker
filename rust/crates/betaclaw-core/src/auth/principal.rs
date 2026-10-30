//! Local principal resolution.
//!
//! Port of `src/server/auth/principal.ts`.

use std::env;

/// Fallback principal used when nothing else is configured.
pub const LEGACY_LOCAL_USER_ID: &str = "local-user";

/// Resolves `PRINCIPAL_USER_ID` with the legacy fallback.
pub fn get_principal_user_id() -> String {
    env::var("PRINCIPAL_USER_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| LEGACY_LOCAL_USER_ID.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_legacy_id_when_unset() {
        // The env var is not set in the test process.
        if env::var("PRINCIPAL_USER_ID").is_err() {
            assert_eq!(get_principal_user_id(), LEGACY_LOCAL_USER_ID);
        }
    }
}
