//! Migrated API routes.
//!
//! Every route here replaces the identically shaped `app/api/**/route.ts`.
//! Unmigrated paths fall through to the reverse proxy, so this list is the exact
//! migration surface. Removal criterion per route: the contract test in
//! `tests/route_parity.rs` passes against the TypeScript implementation and the
//! route has run in production without incident for one release.

pub mod channel_state;
pub mod channel_support;
pub mod config;
pub mod conversations;
pub mod inbox;
pub mod logs;
pub mod messages;
pub mod personas;
pub mod security;

#[cfg(test)]
mod test_support;

use axum::Router;

pub fn router() -> Router<crate::state::SharedState> {
    Router::new()
        .merge(channel_state::router())
        .merge(config::router())
        .merge(conversations::router())
        .merge(inbox::router())
        .merge(logs::router())
        .merge(messages::router())
        .merge(personas::router())
        .merge(security::router())
}
