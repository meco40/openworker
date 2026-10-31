//! Foundation of the Rust control plane: auth, config, SQLite access, gateway
//! protocol types, logging and JavaScript-compatible helpers.
//!
//! Split out of `betaclaw-core` so a change here rebuilds only this crate and
//! its dependents. Each module names the TypeScript source it mirrors.

pub mod auth;
pub mod config;
pub mod db;
pub mod gateway;
pub mod gateway_config;
pub mod js;
pub mod logging;

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
