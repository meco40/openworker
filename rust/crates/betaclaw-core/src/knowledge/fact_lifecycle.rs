//! Port of `src/server/knowledge/factLifecycle.ts` (1-10) — a pure
//! re-export module.
//!
//! | TypeScript                                     | Rust |
//! | ---------------------------------------------- | ---- |
//! | `factLifecycle.ts:2-10` (`export { … } from '@/server/memory/lifecycle'`) | the `pub use` below |
//!
//! The TypeScript file carries no logic: it re-exports the shared Memory
//! lifecycle implementation under a Knowledge-facing name. The port is therefore
//! also a re-export, and the implementation stays in one place
//! ([`crate::memory::lifecycle`]), so the two slices cannot drift.
//!
//! `factLifecycle.ts:2-10` names `withLifecycleSignal`, so it is re-exported
//! too. `publishMemoryLifecycleChange` is *not* re-exported because the
//! TypeScript list does not name it; callers reach it through
//! [`crate::memory::lifecycle`] directly, exactly like the TypeScript does.
//!
//! # Deviation
//!
//! `LifecycleStatus` and `LifecycleSignal` are Rust enums instead of a string
//! union. The spelling of every variant is unchanged
//! ([`crate::memory::lifecycle::LifecycleStatus`]), so a value that crosses the
//! JSON boundary still reads `'superseded'` etc.

pub use crate::memory::lifecycle::{
    is_active_memory_metadata, is_active_status, resolve_lifecycle_status, transition_lifecycle,
    with_lifecycle_signal, LifecycleSignal, LifecycleStatus,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// The re-export must resolve to the *same* items the Memory slice owns; a
    /// local copy would compile but drift.
    #[test]
    fn the_reexport_points_at_the_memory_lifecycle_implementation() {
        let status: LifecycleStatus = LifecycleStatus::Confirmed;
        assert_eq!(status.as_str(), "confirmed");
        assert!(is_active_status(status));
        assert!(!is_active_status(LifecycleStatus::Superseded));
    }

    #[test]
    fn the_transition_helper_is_the_memory_one() {
        let resolved = transition_lifecycle(LifecycleStatus::New, LifecycleSignal::UserConfirmed);
        assert_eq!(resolved, LifecycleStatus::Confirmed);
    }
}
