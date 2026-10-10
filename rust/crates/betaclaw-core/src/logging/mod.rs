//! System log repository and gateway log service.
//!
//! Ports `src/logging/logTypes.ts`, `logRepository.ts` and `logService.ts`. The
//! SQLite schema and query semantics are unchanged, so TypeScript and Rust read
//! the same `.local/logs.db`.

pub mod repository;
pub mod service;

pub use repository::{
    LogCategory, LogEntry, LogFilter, LogLevel, LogRepository, LogRepositoryError,
};
pub use service::{log, log_from_system_event, resolve_category, resolve_level};
