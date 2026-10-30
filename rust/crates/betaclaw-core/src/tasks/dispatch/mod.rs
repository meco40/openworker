//! Port of `src/server/tasks/dispatch/`. Submodules name their TypeScript source.
//!
//! Ported: the dispatch message and the completion marker (`message.rs`), the
//! failure classification and the retry decision (`failure.rs`), the checks of
//! `prepareDispatch` and the session get-or-create (`prepare.rs`), and the SQL
//! effects of `finalizeDispatch` (`finalize.rs`).
//!
//! Not ported: the `chat.send` call and its retry loop, the connect step of the
//! Mission Control client (S8), and the skill check (S11). The caller performs
//! those steps and passes their results in.

pub mod failure;
pub mod finalize;
pub mod message;
pub mod prepare;

/// A handler response: an HTTP status and a JSON body, as the source returns them.
#[derive(Debug, Clone, PartialEq)]
pub struct DispatchHttpResponse {
    pub status: u16,
    pub body: serde_json::Value,
}
