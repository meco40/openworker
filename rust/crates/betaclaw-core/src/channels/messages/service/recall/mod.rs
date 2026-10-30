//! Port of `src/server/channels/messages/service/recall/` (S8).
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`index`] | `recall/index.ts` (`RecallService`) |
//! | [`constants`] | `recall/constants.ts` |
//! | [`types`] | `recall/types.ts` |
//! | [`utils`] | `recall/utils.ts` |
//! | [`service_types`] | the part of `service/types.ts` that recall reads (see its header) |
//! | [`fusion`] | `channels/messages/recallFusion.ts` (outside this directory) |
//! | [`ports`] | Trait ports for S5, S6, S7 and `messages_store` |
//! | [`evidence`] | `recall/evidence/` |
//! | [`learning`] | `recall/learning/` |
//! | [`search`] | `recall/search/` |
//! | [`state`] | `recall/state/` |
//!
//! `testing` is compiled for tests only and holds the fakes of the ports.

pub mod constants;
pub mod evidence;
pub mod fusion;
pub mod index;
pub mod learning;
pub mod ports;
pub mod search;
pub mod service_types;
pub mod state;
pub mod types;
pub mod utils;

#[cfg(test)]
pub(crate) mod testing;

pub use index::RecallService;
