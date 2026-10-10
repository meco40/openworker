//! Authentication and request-origin policy.
//!
//! Ports `src/auth.ts`, `src/server/auth/*` and the `/api/*` gate in `proxy.ts`.
//! Nothing here may be relaxed: these functions are the security boundary.

pub mod jwe;
pub mod limiter;
pub mod policy;
pub mod principal;
pub mod production_guard;
pub mod user_context;
pub mod user_store;

pub use jwe::{decode_session_token, DecodedSession};
pub use limiter::LoginRateLimiter;
pub use policy::{
    is_cross_site_browser_request, is_loopback_address, is_loopback_host_header,
    is_same_origin_browser_request, BrowserRequestHeaders,
};
pub use principal::{get_principal_user_id, LEGACY_LOCAL_USER_ID};
pub use production_guard::assert_production_auth_config;
pub use user_context::{resolve_request_user_context, UserContext};
pub use user_store::AuthUserStore;
