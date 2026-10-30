//! Port of `src/server/automation/` (S10). Submodules name their TypeScript source.
//!
//! The scheduler worker depends on the S6 and S7 workers, so the runtime wiring waits
//! for them. This module holds the store, lease and scheduling logic.

pub mod commands;
pub mod cron_engine;
pub mod error;
pub mod executor;
pub mod flow_compiler;
pub mod flow_types;
pub mod flow_validator;
pub mod row_mappers;
pub mod service;
pub mod sqlite_repository;
pub mod types;
