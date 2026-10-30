//! Port of `src/server/clawhub/errors.ts`.
//!
//! `ClawHubError` carries the HTTP status and the `CLAW_*` code that the
//! TypeScript route layer maps. Every other failure is a 500, which the route
//! layer produces from the fallback.

use super::cli::ExecError;

#[derive(Debug, thiserror::Error)]
pub enum ClawHubError {
    /// Invalid input from the caller, `CLAW_INPUT_INVALID`, HTTP 400.
    #[error("{0}")]
    Input(String),
    /// Unknown skill, `CLAW_NOT_FOUND`, HTTP 404.
    #[error("{0}")]
    NotFound(String),
    #[error(transparent)]
    Exec(#[from] ExecError),
    #[error("database error: {0}")]
    Repository(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl ClawHubError {
    /// `toClawHubHttpStatus`: 400 and 404 for the two typed errors, 500 otherwise.
    pub fn http_status(&self) -> u16 {
        match self {
            ClawHubError::Input(_) => 400,
            ClawHubError::NotFound(_) => 404,
            _ => 500,
        }
    }

    /// The `CLAW_*` code of the typed errors.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            ClawHubError::Input(_) => Some("CLAW_INPUT_INVALID"),
            ClawHubError::NotFound(_) => Some("CLAW_NOT_FOUND"),
            _ => None,
        }
    }
}

/// `isValidClawHubSlug`: trimmed, starts with a letter or digit, then letters,
/// digits, `.`, `_` or `-`.
pub fn is_valid_slug(value: &str) -> bool {
    let trimmed = value.trim();
    let mut chars = trimmed.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_rules_match_the_typescript_pattern() {
        assert!(is_valid_slug("weather-tool.v2"));
        assert!(is_valid_slug("  padded  "));
        assert!(!is_valid_slug("-leading"));
        assert!(!is_valid_slug("has/slash"));
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug("ümlaut"));
    }

    #[test]
    fn only_the_typed_errors_have_their_own_status() {
        assert_eq!(ClawHubError::Input("x".into()).http_status(), 400);
        assert_eq!(ClawHubError::NotFound("x".into()).http_status(), 404);
        assert_eq!(
            ClawHubError::NotFound("x".into()).code(),
            Some("CLAW_NOT_FOUND")
        );
        assert_eq!(ClawHubError::Exec(ExecError::Timeout).http_status(), 500);
        assert_eq!(ClawHubError::Exec(ExecError::Timeout).code(), None);
    }
}
