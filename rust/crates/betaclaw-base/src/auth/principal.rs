//! Local principal resolution.
//!
//! Port of `src/server/auth/principal.ts`.

use std::env;
use std::sync::OnceLock;

/// Fallback principal used when nothing else is configured.
pub const LEGACY_LOCAL_USER_ID: &str = "local-user";

/// Id of the bootstrap admin, recorded once at startup.
static BOOTSTRAP_PRINCIPAL: OnceLock<String> = OnceLock::new();

/// Records the id of the bootstrap admin (`AUTH_DEFAULT_EMAIL`). It is used when
/// `PRINCIPAL_USER_ID` is unset, so a single-admin install needs no manual id.
pub fn set_bootstrap_principal_user_id(user_id: &str) {
    let _ = BOOTSTRAP_PRINCIPAL.set(user_id.to_string());
}

/// Resolves the principal: `PRINCIPAL_USER_ID`, then the bootstrap admin, then the
/// legacy fallback.
pub fn get_principal_user_id() -> String {
    env::var("PRINCIPAL_USER_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| BOOTSTRAP_PRINCIPAL.get().cloned())
        .unwrap_or_else(|| LEGACY_LOCAL_USER_ID.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_legacy_id_when_unset() {
        // The env var is not set in the test process, and no bootstrap admin is recorded.
        if env::var("PRINCIPAL_USER_ID").is_err() && BOOTSTRAP_PRINCIPAL.get().is_none() {
            assert_eq!(get_principal_user_id(), LEGACY_LOCAL_USER_ID);
        }
    }
}
