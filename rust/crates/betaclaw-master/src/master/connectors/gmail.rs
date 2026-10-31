//! Port of `src/server/master/connectors/gmail/`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`types`] | `gmail/types.ts` |
//! | [`oauth`] | `gmail/oauth.ts` |
//! | [`client`] | `gmail/client.ts` |
//! | [`actions`] | `gmail/actions.ts` (on the S6 bridge seam, OP-S9-4) |

pub mod actions;
pub mod client;
pub mod oauth;
pub mod types;
