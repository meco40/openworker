//! Error type of the automation port.
//!
//! The display texts are the TypeScript messages that reach the UI and the run history
//! (`service.ts`, `executor.ts`, `cronEngine.ts`), kept verbatim.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AutomationError {
    #[error("Invalid timezone: {0}")]
    InvalidTimezone(String),
    #[error("Invalid cron expression")]
    InvalidCronExpression,
    /// Parse or next-run failure. TypeScript forwards the cron-parser message.
    #[error("{0}")]
    Cron(String),
    #[error("Automation rule not found")]
    RuleNotFound,
    #[error("Failed to create automation rule.")]
    CreateFailed,
    #[error("Automation run exceeded timeout ({0}ms)")]
    Timeout(u64),
    /// Failure text returned by the prompt runner (S8).
    #[error("{0}")]
    Run(String),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
}
