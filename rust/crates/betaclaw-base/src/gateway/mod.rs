//! WebSocket gateway: wire protocol, client registry, broadcast and keepalive.
//!
//! Ports `src/shared/gatewayTypes.ts`, `src/server/gateway/protocol.ts`,
//! `client-registry.ts`, `broadcast.ts` and `keepalive.ts`.

pub mod broadcast;
pub mod client;
pub mod events;
pub mod protocol;
pub mod registry;

pub use broadcast::{broadcast, broadcast_to_conn_ids, broadcast_to_subscribed, broadcast_to_user};
pub use client::{ClientHandle, GatewayClient};
pub use events::GATEWAY_EVENTS;
pub use protocol::{
    make_error, make_event, make_response, make_stream, parse_frame, ErrorCode, GatewayFrame,
    MethodNamespace, ERROR_CODES,
};
pub use registry::ClientRegistry;

/// Gateway version reported in the `hello-ok` payload.
pub const GATEWAY_VERSION: &str = "1.0.0";

/// Maximum buffered bytes before closing a slow consumer.
pub const MAX_BUFFERED_BYTES: usize = 1_572_864;

/// Keepalive tick interval.
pub const TICK_INTERVAL_MS: u64 = 30_000;

/// Base request budget per minute per connection.
pub const MAX_REQUESTS_PER_MINUTE: usize = 60;
