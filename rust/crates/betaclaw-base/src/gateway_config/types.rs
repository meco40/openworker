//! Port of `src/server/config/gateway/types.ts`.
//!
//! The TypeScript module declares interfaces plus two `Error` subclasses. The
//! subclasses become variants of [`GatewayConfigError`] because Rust has no
//! exception hierarchy; `GatewayConfigConflictError.currentRevision` becomes the
//! `current_revision` payload of [`GatewayConfigError::Conflict`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `GatewayConfigSource` from `types.ts:2`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GatewayConfigSource {
    Default,
    File,
    Db,
}

impl GatewayConfigSource {
    pub fn as_str(self) -> &'static str {
        match self {
            GatewayConfigSource::Default => "default",
            GatewayConfigSource::File => "file",
            GatewayConfigSource::Db => "db",
        }
    }
}

/// `GatewayConfigWarning` from `types.ts:4-7`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayConfigWarning {
    pub code: String,
    pub message: String,
}

impl GatewayConfigWarning {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// `GatewayConfigState` from `types.ts:9-15` — the result of `loadGatewayConfig`.
#[derive(Debug, Clone, Serialize)]
pub struct GatewayConfigState {
    pub config: Value,
    pub source: GatewayConfigSource,
    pub path: String,
    pub warnings: Vec<GatewayConfigWarning>,
    pub revision: String,
}

/// `resolveGatewayConfigBackend` return type from `paths.ts:54`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigBackend {
    Db,
    File,
}

impl ConfigBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            ConfigBackend::Db => "db",
            ConfigBackend::File => "file",
        }
    }
}

/// `NormalizeMode` from `types.ts:29`.
///
/// `Load` repairs invalid values and records a warning, `Save` rejects them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NormalizeMode {
    Load,
    Save,
}

/// Replacement of `GatewayConfigValidationError` and `GatewayConfigConflictError`
/// from `types.ts:17-26`.
#[derive(Debug, thiserror::Error)]
pub enum GatewayConfigError {
    /// `GatewayConfigValidationError` — mapped to HTTP 400 by `app/api/config/route.ts`.
    #[error("{0}")]
    Validation(String),
    /// `GatewayConfigConflictError` — mapped to HTTP 409 by `app/api/config/route.ts`.
    #[error("{message}")]
    Conflict {
        message: String,
        current_revision: String,
    },
    /// `better-sqlite3` threw while reading or writing `gateway-config.db`.
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    /// `node:fs/promises` rejected. The TypeScript route maps this to HTTP 500.
    #[error("file error at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    /// `JSON.stringify`/`JSON.parse` round-trip failure inside the store.
    #[error("{0}")]
    Json(String),
}

impl GatewayConfigError {
    pub fn validation(message: impl Into<String>) -> Self {
        GatewayConfigError::Validation(message.into())
    }

    /// The fixed conflict message used by both `loadGatewayConfig` call sites in
    /// `gatewayConfig.ts:146-149` and `gatewayConfig.ts:180-184`.
    pub const CONFLICT_MESSAGE: &'static str =
        "Config was changed by another session. Reload and review your changes.";

    pub fn conflict(current_revision: impl Into<String>) -> Self {
        GatewayConfigError::Conflict {
            message: Self::CONFLICT_MESSAGE.to_string(),
            current_revision: current_revision.into(),
        }
    }

    pub fn io(path: impl Into<String>, source: std::io::Error) -> Self {
        GatewayConfigError::Io {
            path: path.into(),
            source,
        }
    }

    /// `true` for the two error classes that `app/api/config/route.ts` answers
    /// with a non-500 status.
    pub fn is_client_error(&self) -> bool {
        matches!(
            self,
            GatewayConfigError::Validation(_) | GatewayConfigError::Conflict { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_serializes_to_the_typescript_literals() {
        for (source, expected) in [
            (GatewayConfigSource::Default, "default"),
            (GatewayConfigSource::File, "file"),
            (GatewayConfigSource::Db, "db"),
        ] {
            assert_eq!(source.as_str(), expected);
            assert_eq!(
                serde_json::to_value(source).expect("serialize"),
                serde_json::Value::String(expected.to_string())
            );
        }
    }

    #[test]
    fn conflict_error_carries_the_current_revision() {
        let error = GatewayConfigError::conflict("abc123");
        assert!(error.is_client_error());
        match error {
            GatewayConfigError::Conflict {
                message,
                current_revision,
            } => {
                assert_eq!(message, GatewayConfigError::CONFLICT_MESSAGE);
                assert_eq!(current_revision, "abc123");
            }
            other => panic!("expected a conflict error, got {other}"),
        }
    }

    #[test]
    fn validation_errors_are_client_errors() {
        let error = GatewayConfigError::validation("config must be an object.");
        assert!(error.is_client_error());
        assert_eq!(
            error.to_string(),
            "config must be an object.",
            "the route forwards error.message verbatim"
        );
    }
}
