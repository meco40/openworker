//! Port of `src/server/master/delegation/`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`aggregator`] | `delegation/aggregator.ts:1-21` |
//! | [`dispatcher`] | `delegation/dispatcher.ts:1-84` |
//! | [`inbox`] | `delegation/inbox.ts:1-22` |
//! | [`recovery`] | `delegation/recovery.ts:1-27` |
//! | [`resource_governor`] | `delegation/resourceGovernor.ts:1-28` |
//! | [`session_service`] | `delegation/sessionService.ts:1-304` |
//! | [`session_types`] | `delegation/sessionTypes.ts:1-18` |
//! | [`subagent_pool`] | `delegation/subagentPool.ts:1-106` |
//! | [`trigger_policy`] | `delegation/triggerPolicy.ts:1-44` |
//!
//! # The S8 subagent runtime is *not* a dependency
//!
//! The plan note §4.3 expected `dispatcher.ts`/`subagentPool.ts` to call the S8
//! subagent runtime. A measured import check says otherwise: the whole
//! `delegation/` tree imports only `@/server/master/**`
//! (`repository`, `types`, `featureFlags`, `liveEvents`, its own siblings). The
//! unit of work is a caller-supplied `task: () => Promise<…>` closure, so there
//! is no S8 seam and **no** `channels/`, `commands/subagentCommand` or
//! `execution/subagentExecution` import to model. The port therefore keeps every
//! module inside this package; nothing is imported from or stubbed against S8.
//!
//! # `master/../mod.rs` layout
//!
//! As with [`crate::master::approvals`], the module root is `delegation.rs`
//! (2018 edition) so the child files keep the TypeScript directory shape.

pub mod aggregator;
pub mod dispatcher;
pub mod inbox;
pub mod recovery;
pub mod resource_governor;
pub mod session_service;
pub mod session_types;
pub mod subagent_pool;
pub mod trigger_policy;
