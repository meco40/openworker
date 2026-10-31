//! Port of `src/server/master/toolPolicy/` (1 file, ~197 lines).
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`service`] | `toolPolicy/service.ts` |
//!
//! [`service::ToolPolicyServiceResolver`] implements the OP-S9-13
//! [`ToolPolicyResolver`](crate::master::execution::approval_policy::ToolPolicyResolver)
//! seam, closing it.

pub mod service;
