//! Production start-up guards.
//!
//! Port of `src/server/auth/productionGuard.ts`. These checks are the reason a
//! production deployment can never start without authentication. The equivalent
//! checks exist for the World-Model configuration and the memory runtime; those
//! move with their slices.

use std::env;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthConfigError {
    #[error(
        "REQUIRE_AUTH must be set to \"true\" in production. \
         Refusing to start without authentication to protect the control plane."
    )]
    AuthNotRequired,
    #[error("NEXTAUTH_SECRET (or AUTH_SECRET) must be set in production.")]
    MissingSecret,
}

/// Fails closed in production.
///
/// Non-production returns immediately, exactly like the TypeScript guard. The
/// `E2E_ALLOW_ANONYMOUS_AUTH` escape hatch exists for the isolated production
/// smoke and only applies on a loopback bind.
pub fn assert_production_auth_config(
    node_env: &str,
    require_auth: bool,
    e2e_allow_anonymous_auth: bool,
    hostname: &str,
    has_secret: bool,
) -> Result<(), AuthConfigError> {
    if node_env != "production" {
        return Ok(());
    }

    let hostname = hostname.trim().to_ascii_lowercase();
    let loopback_host = hostname == "127.0.0.1" || hostname == "localhost" || hostname == "::1";

    if e2e_allow_anonymous_auth && loopback_host && !require_auth {
        return Ok(());
    }

    if !require_auth {
        return Err(AuthConfigError::AuthNotRequired);
    }
    if !has_secret {
        return Err(AuthConfigError::MissingSecret);
    }
    Ok(())
}

/// Environment-driven wrapper used by the gateway start-up path.
pub fn assert_production_auth_config_from_env() -> Result<(), AuthConfigError> {
    let node_env = env::var("NODE_ENV").unwrap_or_default();
    let require_auth = env::var("REQUIRE_AUTH")
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let e2e = env::var("E2E_ALLOW_ANONYMOUS_AUTH")
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let hostname = env::var("HOSTNAME").unwrap_or_default();
    let has_secret = env::var("NEXTAUTH_SECRET")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || env::var("AUTH_SECRET")
            .ok()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);

    assert_production_auth_config(&node_env, require_auth, e2e, &hostname, has_secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_never_blocks() {
        assert!(
            assert_production_auth_config("development", false, false, "0.0.0.0", false).is_ok()
        );
        assert!(assert_production_auth_config("test", false, false, "0.0.0.0", false).is_ok());
    }

    #[test]
    fn production_requires_auth_and_secret() {
        assert_eq!(
            assert_production_auth_config("production", false, false, "0.0.0.0", true),
            Err(AuthConfigError::AuthNotRequired)
        );
        assert_eq!(
            assert_production_auth_config("production", true, false, "0.0.0.0", false),
            Err(AuthConfigError::MissingSecret)
        );
        assert!(assert_production_auth_config("production", true, false, "0.0.0.0", true).is_ok());
    }

    #[test]
    fn e2e_escape_hatch_only_on_loopback() {
        assert!(
            assert_production_auth_config("production", false, true, "127.0.0.1", false).is_ok()
        );
        assert_eq!(
            assert_production_auth_config("production", false, true, "0.0.0.0", false),
            Err(AuthConfigError::AuthNotRequired)
        );
    }
}
