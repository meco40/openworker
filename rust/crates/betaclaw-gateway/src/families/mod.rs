//! Gateway wiring families (integration phase). Each family exposes router() returning Router<SharedState>.
//! It reads its services from Extension<Arc<Services>>, which the integrator attaches.

pub mod channels_wire;
pub mod chat_runtime;
pub mod cutover;
pub mod hardening;
pub mod master;
pub mod migrations_wire;
pub mod ops_wire;
pub mod skills_wire;
pub mod stats_wire;
pub mod tasks;
pub mod wiring;
pub mod ws_wire;
