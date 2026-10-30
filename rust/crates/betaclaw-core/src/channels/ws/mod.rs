//! Core-side handlers for the WS `chat.*`, `sessions.*`, `channels.*` and
//! `agent.v2.session.*` methods (S8). The gateway wiring lives in `betaclaw-gateway`.
//!
//! Each submodule names the TypeScript source it mirrors:
//! - `chat`: `src/server/gateway/methods/chat.ts`
//! - `sessions`: `src/server/gateway/methods/sessions.ts`
//! - `channels`: `src/server/gateway/methods/channels.ts`, without `inbox.list`
//! - `session_methods`: `src/server/gateway/methods/agent-v2/registerSessionMethods.ts`
//! - `helpers`: `src/server/gateway/methods/agent-v2/helpers.ts` (validators) and
//!   `src/server/channels/inbox/events.ts`
//! - `ports`: the service, repository, pairing and agent-v2 modules the handlers call

pub mod channels;
pub mod chat;
pub mod helpers;
pub mod ports;
pub mod session_methods;
pub mod sessions;

#[cfg(test)]
mod test_support;
