//! Port of `src/server/channels/messages/service/subagent/constants.ts`, which
//! re-exports `service/types.ts`, plus the timeout of `subagent/executor.ts:65`.
//!
//! `SUBAGENT_MAX_ACTIVE_PER_CONVERSATION` belongs to `core/configuration.ts` (Agent C)
//! and is not repeated here.

use std::time::Duration;

/// `SUBAGENT_RECENT_MINUTES` (`service/types.ts:15`).
pub const SUBAGENT_RECENT_MINUTES: u64 = 60;
/// `SUBAGENT_DEFAULT_AGENT_ID` (`service/types.ts:16`).
pub const SUBAGENT_DEFAULT_AGENT_ID: &str = "worker";
/// `SUBAGENT_RESULT_PREVIEW_MAX_CHARS` (`service/types.ts:18`). Counted in UTF-16 units.
pub const SUBAGENT_RESULT_PREVIEW_MAX_CHARS: usize = 1200;
/// `SUBAGENT_ANNOUNCE_MAX_CHARS` (`service/types.ts:19`). Counted in UTF-16 units.
pub const SUBAGENT_ANNOUNCE_MAX_CHARS: usize = 3000;
/// Auto-abort of a runaway subagent (`executor.ts:65`).
pub const SUBAGENT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
