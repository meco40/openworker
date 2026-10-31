//! Port of `src/core/memory/` — the shared core-memory tool surface.
//!
//! | TypeScript            | Rust |
//! | --------------------- | ---- |
//! | `gemini.ts:1-61`      | [`gemini`] |
//! | `index.ts:1-78`       | [`index`] |
//!
//! `src/core/memory/types.ts` is ported by [`crate::memory::types`] together
//! with the server-side type modules, so it has no file of its own here.

pub mod gemini;
pub mod index;

pub use gemini::{CORE_MEMORY_TOOLS, MEMORY_RECALL_SPEC, MEMORY_STORE_SPEC, TASK_SCHEDULE_SPEC};
pub use index::{
    get_memory_preview, handle_core_memory_call, CoreMemoryCallResult, CORE_MEMORY_RECALL,
    CORE_MEMORY_STORE,
};
