//! Port of `src/server/master/approvals/`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`service`] | `approvals/service.ts:1-192` |
//!
//! Rust cannot keep `approvals/mod.rs` next to a sibling `approvals/` directory
//! that also owns `service.rs`, so the module root is `approvals.rs` (2018
//! edition) with the same child paths — the same layout deviation
//! [`crate::master::repository`] documents.

pub mod service;
