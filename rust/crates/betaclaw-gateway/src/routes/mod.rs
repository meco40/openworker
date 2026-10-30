//! Migrated API routes.
//!
//! Every route here replaces the identically shaped `app/api/**/route.ts`.
//! Unmigrated paths fall through to the reverse proxy, so this list is the exact
//! migration surface. Removal criterion per route: the contract test in
//! `tests/route_parity.rs` passes against the TypeScript implementation and the
//! route has run in production without incident for one release.

pub mod auth;
pub mod channel_state;
pub mod channel_support;
pub mod config;
pub mod conversations;
pub mod inbox;
pub mod logs;
pub mod memory;
pub mod messages;
pub mod model_hub;
pub mod personas;
pub mod security;

#[cfg(test)]
mod test_support;

use std::sync::Arc;

use axum::extract::{Extension, Request};
use axum::middleware::{from_fn, Next};
use axum::Router;

use crate::families::cutover::{gate, CutoverPolicy};
use crate::families::{channels_wire, master, ops_wire, skills_wire, stats_wire, tasks};

/// Puts one family's routes behind the cutover switch. `route_layer` runs only for
/// matched routes, so an unmatched path keeps its fallback to the proxy.
fn gated(
    family: &'static str,
    routes: Router<crate::state::SharedState>,
) -> Router<crate::state::SharedState> {
    routes.route_layer(from_fn(
        move |policy: Extension<Arc<CutoverPolicy>>, request: Request, next: Next| {
            gate(family, policy, request, next)
        },
    ))
}

pub fn router() -> Router<crate::state::SharedState> {
    Router::new()
        .merge(channel_state::router())
        .merge(config::router())
        .merge(conversations::router())
        .merge(inbox::router())
        .merge(logs::router())
        .merge(memory::router())
        .merge(messages::router())
        .merge(model_hub::router())
        .merge(personas::router())
        .merge(security::router())
        .merge(gated("auth", auth::router()))
        .merge(gated("master", master::router()))
        .merge(gated("channels_wire", channels_wire::router()))
        .merge(gated("skills_wire", skills_wire::router()))
        .merge(gated("stats_wire", stats_wire::router()))
        .merge(gated("ops_wire", ops_wire::router()))
        .merge(gated("tasks", tasks::router()))
}
