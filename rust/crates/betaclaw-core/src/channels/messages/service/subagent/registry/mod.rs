//! Port of `src/server/channels/messages/service/subagent/registry/index.ts` and
//! `registry/sync.ts`. Both only re-export `src/server/agents/subagentRegistry.ts`,
//! so the module holds the port of that file's contract in [`sync`].

pub mod sync;

pub use sync::{
    CreateSubagentRunInput, SubagentRegistry, SubagentRunRecord, SubagentRunStatus,
    SubagentRunsView,
};
