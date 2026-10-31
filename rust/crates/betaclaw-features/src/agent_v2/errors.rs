//! Port of `src/server/agent-v2/errors.ts`.
//!
//! `AgentV2Error` carries one of the six codes of the TypeScript class. The
//! storage and JSON failures that the TypeScript code lets escape as plain
//! `Error`s are the other two variants.

/// The `code` union of the TypeScript `AgentV2Error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    NotFound,
    Unauthorized,
    InvalidRequest,
    Backpressure,
    ReplayWindowExpired,
    Unavailable,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::Unauthorized => "UNAUTHORIZED",
            ErrorCode::InvalidRequest => "INVALID_REQUEST",
            ErrorCode::Backpressure => "BACKPRESSURE",
            ErrorCode::ReplayWindowExpired => "REPLAY_WINDOW_EXPIRED",
            ErrorCode::Unavailable => "UNAVAILABLE",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AgentV2Error {
    /// `new AgentV2Error(message, code)`. The message is shown as it is.
    #[error("{message}")]
    Coded { code: ErrorCode, message: String },
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl AgentV2Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self::Coded {
            code,
            message: message.into(),
        }
    }

    /// The `code` of a typed error. Storage and JSON failures have none.
    pub fn code(&self) -> Option<ErrorCode> {
        match self {
            AgentV2Error::Coded { code, .. } => Some(*code),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_typed_errors_carry_a_code() {
        let typed = AgentV2Error::new(ErrorCode::NotFound, "Session not found.");
        assert_eq!(typed.code(), Some(ErrorCode::NotFound));
        assert_eq!(typed.to_string(), "Session not found.");
        assert_eq!(
            ErrorCode::ReplayWindowExpired.as_str(),
            "REPLAY_WINDOW_EXPIRED"
        );

        let storage = AgentV2Error::from(rusqlite::Error::QueryReturnedNoRows);
        assert_eq!(storage.code(), None);
    }
}
