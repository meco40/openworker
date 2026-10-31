//! Port of `src/server/stats/promptDispatchDiagnostics.ts`.
//!
//! Process-wide counters of the prompt logger since boot. The TypeScript keeps
//! them on `globalThis`; here they are a `static` behind a `Mutex`, so the
//! functions keep the same shape without a singleton accessor.

use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDispatchDiagnostics {
    pub logger_active: bool,
    pub attempts_since_boot: u64,
    pub writes_since_boot: u64,
    pub last_attempt_at: Option<String>,
    pub last_insert_at: Option<String>,
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
}

const INITIAL: PromptDispatchDiagnostics = PromptDispatchDiagnostics {
    logger_active: true,
    attempts_since_boot: 0,
    writes_since_boot: 0,
    last_attempt_at: None,
    last_insert_at: None,
    last_error: None,
    last_error_at: None,
};

static DIAGNOSTICS: Mutex<PromptDispatchDiagnostics> = Mutex::new(INITIAL);

fn lock() -> MutexGuard<'static, PromptDispatchDiagnostics> {
    DIAGNOSTICS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `markPromptDispatchAttempt(at)`.
pub fn mark_attempt(at: &str) {
    let mut diagnostics = lock();
    diagnostics.attempts_since_boot += 1;
    diagnostics.last_attempt_at = Some(at.to_string());
}

/// `markPromptDispatchInsert(at)`.
pub fn mark_insert(at: &str) {
    let mut diagnostics = lock();
    diagnostics.writes_since_boot += 1;
    diagnostics.last_insert_at = Some(at.to_string());
}

/// `markPromptDispatchError(error, at)`. The caller passes the message; it must
/// not carry secret values.
pub fn mark_error(message: &str, at: &str) {
    let mut diagnostics = lock();
    diagnostics.last_error_at = Some(at.to_string());
    diagnostics.last_error = Some(message.to_string());
}

/// `getPromptDispatchDiagnostics`: a copy of the counters.
pub fn get_diagnostics() -> PromptDispatchDiagnostics {
    lock().clone()
}

/// `resetPromptDispatchDiagnostics`.
pub fn reset_diagnostics() {
    *lock() = INITIAL;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test owns the static, so the parallel test runner cannot interleave.
    #[test]
    fn counters_record_and_reset() {
        reset_diagnostics();
        assert!(get_diagnostics().logger_active);

        mark_attempt("2026-06-10T10:00:00.000Z");
        mark_attempt("2026-06-10T10:00:01.000Z");
        mark_insert("2026-06-10T10:00:01.500Z");
        mark_error("disk full", "2026-06-10T10:00:02.000Z");

        let snapshot = get_diagnostics();
        assert_eq!(snapshot.attempts_since_boot, 2);
        assert_eq!(snapshot.writes_since_boot, 1);
        assert_eq!(
            snapshot.last_attempt_at.as_deref(),
            Some("2026-06-10T10:00:01.000Z")
        );
        assert_eq!(snapshot.last_error.as_deref(), Some("disk full"));

        reset_diagnostics();
        assert_eq!(get_diagnostics().attempts_since_boot, 0);
        assert_eq!(get_diagnostics().last_error, None);
    }
}
