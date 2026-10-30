//! The Rust control-plane gateway.
//!
//! Owns the public listener (HTTP + WebSocket), the authentication gate, the
//! tenant scope and, as each slice lands, the migrated API routes. Anything not
//! migrated yet is reverse-proxied to the Next.js UI process on port 3001, so
//! there is exactly one front door and exactly one auth path.

pub mod auth_gate;
pub mod background;
pub mod families;
pub mod gateway_methods;
pub mod knowledge_runtime;
pub mod model_hub_transport;
pub mod persona_poller;
pub mod proxy;
pub mod routes;
pub mod scheduler_runtime;
pub mod state;
pub mod static_ui;
pub mod swarm_runtime;
pub mod workspace_cleanup;
pub mod ws;

pub use state::{AppState, GatewayRuntime};

/// Helpers shared by the integration tests. Not part of the runtime surface.
#[cfg(any(test, feature = "test-support"))]
pub mod test_support {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    /// Generates a `Sec-WebSocket-Key` for a handshake test.
    pub fn ws_accept_key() -> String {
        STANDARD.encode([0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])
    }

    /// Returns the payload of the first unmasked text frame in `bytes`, or an
    /// empty slice when no complete frame is present yet.
    pub fn extract_first_text_frame(bytes: &[u8]) -> &[u8] {
        if bytes.len() < 2 {
            return &[];
        }
        let opcode = bytes[0] & 0x0f;
        let masked = bytes[1] & 0x80 != 0;
        let mut length = (bytes[1] & 0x7f) as usize;
        let mut offset = 2usize;

        if length == 126 {
            if bytes.len() < 4 {
                return &[];
            }
            length = u16::from_be_bytes([bytes[2], bytes[3]]) as usize;
            offset = 4;
        } else if length == 127 {
            if bytes.len() < 10 {
                return &[];
            }
            let mut wide = [0u8; 8];
            wide.copy_from_slice(&bytes[2..10]);
            length = u64::from_be_bytes(wide) as usize;
            offset = 10;
        }

        if masked {
            // A server-to-client frame is never masked; anything else is out of
            // scope for these tests.
            return &[];
        }
        if bytes.len() < offset + length {
            return &[];
        }
        if opcode != 0x1 {
            return &[];
        }
        &bytes[offset..offset + length]
    }
}
