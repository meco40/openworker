//! Trait port for `src/server/skills/handlers/memoryCompat.ts`. Not implemented in this slice.
//!
//! The TypeScript handlers search `MEMORY.md` and `memory/*.md` in the workspace and read a
//! line range from one of them. The memory runtime (S5, OP-10) owns that data, so the handler
//! side calls this trait and the runtime provides the implementation.
//!
//! Note for the S5 slice: the TypeScript file has no runtime dependency. It is file-system code
//! only, so it can also be ported directly without this trait.

use serde_json::Value;

use super::types::SkillError;
use crate::model_hub::http::BoxFuture;

/// The `memory_search` and `memory_get` operations.
pub trait MemoryCompatRuntime: Send + Sync {
    /// `memory_search`. Answers with the object `memorySearchHandler` returns: `query`,
    /// `scannedFiles` and `results`.
    fn search<'a>(
        &'a self,
        query: &'a str,
        max_results: usize,
        min_score: f64,
        snippet_lines: usize,
    ) -> BoxFuture<'a, Result<Value, SkillError>>;

    /// `memory_get`. Answers with the object `memoryGetHandler` returns: `path`, `from`,
    /// `lines`, `startLine`, `endLine` and `text`.
    fn get<'a>(
        &'a self,
        path: &'a str,
        from: usize,
        lines: usize,
    ) -> BoxFuture<'a, Result<Value, SkillError>>;
}
