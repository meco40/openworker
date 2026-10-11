//! Shared backend primitives for the Rust control plane.
//!
//! Everything in this crate is a port of an existing TypeScript module and must
//! stay behaviour-compatible. Each module names the TypeScript source it mirrors
//! so contract drift is traceable in review.

pub mod auth;
pub mod config;
pub mod db;
pub mod gateway;
pub mod gateway_config;
pub mod js;
pub mod logging;
pub mod memory;
pub mod messages_store;
pub mod model_hub;
pub mod personas;
pub mod security;
pub mod world_model;

/// Formats an error without ever including secret values from the environment.
///
/// The TypeScript backend logs error objects directly; several of them can carry
/// request headers. This helper is used wherever an error crosses a log boundary.
pub fn safe_error_message(error: &dyn std::fmt::Display) -> String {
    let text = error.to_string();
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(line.trim_end());
    }
    out
}
