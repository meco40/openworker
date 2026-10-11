//! Port of `src/server/memory/errors.ts` plus the two error classifiers from
//! `src/server/memory/utils/errorDetection.ts`.
//!
//! The TypeScript code throws a single `MemoryVersionConflictError` and detects
//! "not found" *from the message text* (`/http\s*404/i`). The port keeps both
//! properties: a structured enum so callers can match on the conflict, and
//! message-based classifiers so the retry and restore paths behave identically
//! against a provider whose error text the port does not control.

use crate::memory::types::js_string;

/// `MemoryVersionConflictError` from `errors.ts:1-8`.
///
/// The default message of the TypeScript constructor is kept verbatim so a route
/// handler forwarding `error.message` produces the same body.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum MemoryError {
    /// `throw new MemoryVersionConflictError(currentVersion)`.
    #[error("Memory version conflict. Reload and retry.")]
    VersionConflict { current_version: i64 },

    /// Every other `throw new Error(message)` of the slice.
    #[error("{0}")]
    Message(String),

    /// A storage failure of the underlying repository or client.
    #[error("{0}")]
    Storage(String),
}

impl MemoryError {
    pub fn message(message: impl Into<String>) -> Self {
        MemoryError::Message(message.into())
    }

    pub fn storage(message: impl Into<String>) -> Self {
        MemoryError::Storage(message.into())
    }

    /// `error instanceof MemoryVersionConflictError ? error.currentVersion : null`.
    pub fn version_conflict(&self) -> Option<i64> {
        match self {
            MemoryError::VersionConflict { current_version } => Some(*current_version),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for MemoryError {
    fn from(error: rusqlite::Error) -> Self {
        MemoryError::Storage(format!("database error: {error}"))
    }
}

impl From<serde_json::Error> for MemoryError {
    fn from(error: serde_json::Error) -> Self {
        MemoryError::Storage(format!("JSON error: {error}"))
    }
}

/// `isNotFoundError` from `utils/errorDetection.ts:1-5`.
///
/// The test is on the rendered message, not on a variant, because the original
/// classifies whatever a provider (mem0, postgres) put into an `Error`.
pub fn is_not_found_error(error: &MemoryError) -> bool {
    regex::Regex::new(r"(?i)http\s*404")
        .expect("static regex")
        .is_match(&error.to_string())
}

/// `isLegacyDeleteNotFoundError` from `utils/errorDetection.ts:7-14`.
pub fn is_legacy_delete_not_found_error(error: &MemoryError) -> bool {
    let message = error.to_string().to_lowercase();
    if !regex::Regex::new(r"(?i)http\s*500")
        .expect("static regex")
        .is_match(&message)
    {
        return false;
    }
    (message.contains("nonetype") && message.contains("payload"))
        || message.contains("memory not found")
        || message.contains("not found")
}

/// `pickString` from `mem0/utils/index.ts:19-24`.
///
/// Returns `None` for a non-string, for an empty string and for whitespace-only
/// content; that is what the extraction helpers use to decide whether a key
/// carried a usable value.
pub fn pick_string(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

/// `pickNumber` from `mem0/utils/index.ts:28-32`.
pub fn pick_number(value: Option<&serde_json::Value>) -> Option<f64> {
    match value {
        Some(serde_json::Value::Number(number)) => {
            number.as_f64().filter(|value| value.is_finite())
        }
        _ => None,
    }
}

/// `pickRecord` from `mem0/utils/index.ts:10-16`.
pub fn pick_record(
    value: Option<&serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    match value {
        Some(serde_json::Value::Object(map)) => map.clone(),
        _ => serde_json::Map::new(),
    }
}

/// `text(value)` from `postgresMemoryClient.ts:56-58`.
pub fn trimmed_text(value: Option<&serde_json::Value>) -> String {
    js_string(value).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_version_conflict_keeps_the_typescript_message() {
        let error = MemoryError::VersionConflict { current_version: 4 };
        assert_eq!(
            error.to_string(),
            "Memory version conflict. Reload and retry."
        );
        assert_eq!(error.version_conflict(), Some(4));
        assert_eq!(MemoryError::message("boom").version_conflict(), None);
    }

    /// The classifier reads the message, so a plain `Error('Mem0 request failed
    /// with HTTP 404.')` from the generic path is also "not found".
    #[test]
    fn not_found_is_detected_from_the_message_text() {
        let not_found = MemoryError::message("Mem0 request failed with HTTP 404.");
        assert!(is_not_found_error(&not_found));
        assert!(!is_not_found_error(&MemoryError::message("HTTP 500")));
        assert!(!is_not_found_error(&MemoryError::message(
            "no status at all"
        )));
    }

    /// The legacy delete path needs *both* a 500 and a payload-shaped message.
    #[test]
    fn a_legacy_missing_row_needs_both_signals() {
        assert!(is_legacy_delete_not_found_error(&MemoryError::message(
            "Mem0 request failed with HTTP 500: NoneType payload"
        )));
        assert!(!is_legacy_delete_not_found_error(&MemoryError::message(
            "Mem0 request failed with HTTP 500: other"
        )));
        assert!(!is_legacy_delete_not_found_error(&MemoryError::message(
            "Mem0 request failed with HTTP 404: memory not found"
        )));
    }

    #[test]
    fn pick_helpers_follow_the_typescript_guards() {
        assert_eq!(pick_string(Some(&json!("  x  "))), Some("x".to_string()));
        assert_eq!(pick_string(Some(&json!("   "))), None);
        assert_eq!(pick_string(Some(&json!(3))), None);
        assert_eq!(pick_string(None), None);

        assert_eq!(pick_number(Some(&json!(0.5))), Some(0.5));
        assert_eq!(pick_number(Some(&json!(1))), Some(1.0));
        assert_eq!(pick_number(Some(&json!("3"))), None);
        assert_eq!(pick_number(None), None);

        assert_eq!(pick_record(Some(&json!({"a": 1}))).len(), 1);
        assert!(pick_record(Some(&json!([1]))).is_empty());
        assert!(pick_record(None).is_empty());
    }

    #[test]
    fn trimmed_text_drops_surrounding_whitespace_like_the_ts_helper() {
        assert_eq!(trimmed_text(Some(&json!("  p1 "))), "p1");
        assert_eq!(trimmed_text(None), "");
        assert_eq!(trimmed_text(Some(&serde_json::Value::Null)), "");
    }
}
