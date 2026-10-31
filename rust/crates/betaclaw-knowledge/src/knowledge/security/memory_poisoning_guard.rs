//! Port of `src/server/knowledge/security/memoryPoisoningGuard.ts` (1-5).
//!
//! | TypeScript | Rust |
//! | --- | --- |
//! | `checkMemoryPoisoning`, `normalizeMemoryContent`, `PoisoningCheckResult` (re-exported from `@/server/memory/security/memoryPoisoningGuard`) | the `pub use` below, from [`crate::memory::poisoning`] |
//!
//! The TypeScript file has no logic: it re-exports the Memory slice's guard. The
//! port does the same, so the rules live in one place.

pub use crate::memory::poisoning::{
    check_memory_poisoning, normalize_memory_content, PoisoningCheckResult,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reexport_marks_an_ordinary_statement_as_safe() {
        assert!(check_memory_poisoning("Ich trinke gern Tee am Morgen").is_safe);
    }
}
