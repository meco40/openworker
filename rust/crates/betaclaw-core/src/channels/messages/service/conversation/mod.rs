//! Port of `src/server/channels/messages/service/conversation/` (S8).
//!
//! `operations` holds the wrappers, `ports` the repository and session traits they call.

pub mod operations;
pub mod ports;

#[cfg(test)]
pub(crate) mod fakes;
