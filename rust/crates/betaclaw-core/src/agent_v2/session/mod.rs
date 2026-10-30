//! Port of the pure parts of `src/server/agent-v2/session/index.ts` (S12b). Submodules
//! name their TypeScript source.
//!
//! Not ported: the `AgentV2SessionManager` class. Its `processQueue`, the event
//! broadcast, the lifecycle hooks and the extension host belong to the runtime. The
//! delegating methods are the functions of the submodules, called with the repository
//! and the active handles instead of a manager.
//!
//! Also not ported: `commands/execute.ts` and `state/create.ts` (S8 channel runtime and
//! personas), `state/lifecycle.ts` (extension host) and `runtime.ts`.

pub mod commands;
pub mod constants;
pub mod events;
pub mod state;
pub mod types;
pub mod utils;

/// The manager's `listSessions(userId, limit)` applies `limit || 50`: zero falls back
/// to the default, a negative value is passed through.
pub fn list_limit(limit: Option<i64>) -> i64 {
    match limit {
        Some(value) if value != 0 => value,
        _ => 50,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_limit_defaults_to_fifty_for_missing_or_zero() {
        assert_eq!(list_limit(None), 50);
        assert_eq!(list_limit(Some(0)), 50);
        assert_eq!(list_limit(Some(7)), 7);
        assert_eq!(list_limit(Some(-1)), -1);
    }
}
