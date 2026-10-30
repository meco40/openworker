//! Port of `src/server/master/execution/`.
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`action_ledger`] | `execution/actionLedger.ts:1-57` |
//! | [`approval_policy`] | `execution/approvalPolicy.ts:1-103` |
//! | [`idempotency`] | `execution/idempotency.ts:1-15` |
//! | [`runtime`] | `execution/runtime/*.ts` |
//!
//! # `toolRunner.ts` on the seams
//!
//! `execution/runtime/toolRunner.ts` is ported as `runtime::tool_runner` on the S6
//! bridge seam and the S11 skill seam (OP-S9-4). The synchronous
//! [`runtime::capability_executor::MasterToolRunner`] seam stays where the
//! capability executor calls it; the gateway adapter between the two is
//! OP-S9-14.

pub mod action_ledger;
pub mod approval_policy;
pub mod idempotency;
pub mod runtime;
