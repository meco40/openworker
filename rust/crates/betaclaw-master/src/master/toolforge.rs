//! Port of `src/server/master/toolforge/` (3 files, ~60 lines).
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`validator`] | `toolforge/validator.ts` |
//! | [`sandbox_runner`] | `toolforge/sandboxRunner.ts` (seam only) |
//! | [`pipeline`] | `toolforge/pipeline.ts` |
//!
//! The sandbox execution path belongs to Slice S11 (OP-S9-2): [`sandbox_runner`]
//! is a trait seam, not a reimplementation.

pub mod pipeline;
pub mod sandbox_runner;
pub mod validator;
