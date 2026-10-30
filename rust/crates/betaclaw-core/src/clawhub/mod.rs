//! Port of `src/server/clawhub/` (S12a). Submodules name their TypeScript source.
//!
//! Ported: the CLI launcher logic, the search parser, the SQLite repository,
//! the prompt block and the service rules. Not ported: the DI container
//! registration (`getClawHubService`), which is wiring for `state.rs`, and the
//! process-wide repository singleton. The registry is reached through the
//! `clawhub` CLI, so no HTTP transport is needed (OP-16 does not apply).

pub mod cli;
pub mod errors;
pub mod prompt_builder;
pub mod repository;
pub mod search_parser;
pub mod service;
pub mod types;
