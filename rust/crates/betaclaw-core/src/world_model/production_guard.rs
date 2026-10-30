//! Port of `src/server/world-model/productionGuard.ts:1-27` — fail-closed hardening of
//! the canonical World Model.
//!
//! The TypeScript reads `process.env` directly in the middle of the check
//! (`productionGuard.ts:10`, `:18-22`), which makes it untestable without a
//! process-wide environment mutation. The port takes the two facts it reads as a
//! [`ProductionGuardEnv`], so the production decision is an input instead of
//! ambient state. The order of the three checks and both error messages are
//! unchanged.

use crate::world_model::config::WorldModelConfig;

/// The `process.env` facts `assertProductionWorldModelConfig` reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProductionGuardEnv {
    /// `process.env.NODE_ENV === 'production'` (`productionGuard.ts:10`).
    pub is_production: bool,
    /// `Boolean(WORLD_MODEL_APP_DATABASE_URL || WORLD_MODEL_WORKER_DATABASE_URL ||
    /// CANONICAL_DATABASE_URL)` (`productionGuard.ts:18-22`).
    pub has_explicit_world_model_database: bool,
}

impl ProductionGuardEnv {
    pub fn from_env() -> Self {
        fn non_empty(key: &str) -> bool {
            std::env::var(key)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        }
        Self {
            is_production: std::env::var("NODE_ENV")
                .map(|value| value == "production")
                .unwrap_or(false),
            has_explicit_world_model_database: non_empty("WORLD_MODEL_APP_DATABASE_URL")
                || non_empty("WORLD_MODEL_WORKER_DATABASE_URL")
                || non_empty("CANONICAL_DATABASE_URL"),
        }
    }
}

/// The two `throw new Error(...)` texts of `productionGuard.ts:16`, `:24-26`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProductionGuardError {
    /// `productionGuard.ts:16`.
    #[error("[world-model] WORLD_MODEL_E2E is not allowed in production")]
    E2eInProduction,
    /// `productionGuard.ts:24-26`.
    #[error(
        "[world-model] WORLD_MODEL_ENABLED=true requires WORLD_MODEL_APP_DATABASE_URL, \
WORLD_MODEL_WORKER_DATABASE_URL, or CANONICAL_DATABASE_URL in production"
    )]
    MissingExplicitDatabase,
}

/// `assertProductionWorldModelConfig` (`productionGuard.ts:9-27`).
pub fn assert_production_world_model_config(
    config: &WorldModelConfig,
    env: &ProductionGuardEnv,
) -> Result<(), ProductionGuardError> {
    if !env.is_production {
        return Ok(());
    }
    if config.e2e_enabled {
        return Err(ProductionGuardError::E2eInProduction);
    }
    if config.enabled && !env.has_explicit_world_model_database {
        return Err(ProductionGuardError::MissingExplicitDatabase);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> WorldModelConfig {
        WorldModelConfig::default()
    }

    #[test]
    fn a_non_production_process_is_never_guarded() {
        let mut enabled = config();
        enabled.enabled = true;
        enabled.e2e_enabled = true;
        assert_eq!(
            assert_production_world_model_config(
                &enabled,
                &ProductionGuardEnv {
                    is_production: false,
                    has_explicit_world_model_database: false,
                }
            ),
            Ok(())
        );
    }

    #[test]
    fn e2e_is_rejected_before_the_database_check() {
        let mut e2e = config();
        e2e.e2e_enabled = true;
        e2e.enabled = true;
        assert_eq!(
            assert_production_world_model_config(
                &e2e,
                &ProductionGuardEnv {
                    is_production: true,
                    has_explicit_world_model_database: false,
                }
            ),
            Err(ProductionGuardError::E2eInProduction)
        );
    }

    #[test]
    fn an_enabled_world_model_needs_an_explicit_database() {
        let mut enabled = config();
        enabled.enabled = true;
        assert_eq!(
            assert_production_world_model_config(
                &enabled,
                &ProductionGuardEnv {
                    is_production: true,
                    has_explicit_world_model_database: false,
                }
            ),
            Err(ProductionGuardError::MissingExplicitDatabase)
        );
        assert_eq!(
            assert_production_world_model_config(
                &enabled,
                &ProductionGuardEnv {
                    is_production: true,
                    has_explicit_world_model_database: true,
                }
            ),
            Ok(())
        );
    }

    #[test]
    fn a_disabled_world_model_passes_in_production() {
        assert_eq!(
            assert_production_world_model_config(
                &config(),
                &ProductionGuardEnv {
                    is_production: true,
                    has_explicit_world_model_database: false,
                }
            ),
            Ok(())
        );
    }
}
