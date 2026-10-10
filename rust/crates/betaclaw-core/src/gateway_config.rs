//! Gateway configuration port.
//!
//! Mirrors `src/server/config/gateway/` in the TypeScript backend:
//!
//! | TypeScript                              | Rust                                |
//! | --------------------------------------- | ----------------------------------- |
//! | `types.ts`                              | [`types`]                           |
//! | `constants.ts`                          | [`constants`]                       |
//! | `normalize.ts`                          | [`normalize`]                       |
//! | `secrets.ts`                            | [`secrets`]                         |
//! | `paths.ts`                              | [`paths`]                           |
//! | `gatewayConfig.ts`                      | [`repository`]                      |
//! | `computeGatewayConfigRevision` (inline) | [`revision`]                        |
//!
//! The SQLite table name, column names and the `gateway_config_state` upsert
//! statement are part of the storage contract: the Rust gateway and the
//! TypeScript backend must be able to read the same `.local/gateway-config.db`.

pub mod constants;
pub mod normalize;
pub mod paths;
pub mod repository;
pub mod revision;
pub mod secrets;
pub mod types;

pub use constants::{default_gateway_config, GATEWAY_CONFIG_DB_ROW_ID};
pub use normalize::{clone_object, normalize_gateway_config, NormalizationResult};
pub use paths::{to_gateway_config_display_path, ConfigBackend, PathResolver};
pub use repository::{GatewayConfigSaveResult, GatewayConfigStore};
pub use revision::compute_revision;
pub use secrets::{redact_gateway_config_secrets, restore_redacted_secrets};
pub use types::{
    GatewayConfigError, GatewayConfigSource, GatewayConfigState, GatewayConfigWarning,
    NormalizeMode,
};
