//! Port of `src/server/master/capabilities/` (4 files, ~190 lines).
//!
//! | Rust | TypeScript |
//! | --- | --- |
//! | [`proposal_template`] | `capabilities/proposalTemplate.ts` |
//! | [`inventory`] | `capabilities/inventory.ts` |
//! | [`apprenticeship`] | `capabilities/apprenticeship.ts` |
//! | [`understanding_loop`] | `capabilities/understandingLoop.ts` |
//!
//! [`understanding_loop`] is the concrete [`CapabilityUnderstandingCycle`]
//! implementation the S9 [`crate::master::learning`] seam was waiting for, so it
//! also closes OP-S9-6.
//!
//! [`CapabilityUnderstandingCycle`]: crate::master::learning::CapabilityUnderstandingCycle

pub mod apprenticeship;
pub mod inventory;
pub mod proposal_template;
pub mod understanding_loop;
