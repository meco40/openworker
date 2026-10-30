//! Health and doctor diagnostics.
//!
//! Port of `src/commands/healthCommand.ts`, `healthChecks.ts`, `healthTypes.ts`,
//! `health/checkHelpers.ts`, `health/checks/*.ts`, `doctorCommand.ts` and
//! `doctorRules.ts`.
//!
//! Every check reads its data through the traits in [`ports`], so the logic runs
//! in tests without a database. The gateway implements the traits against the Rust
//! stores in `families::ops_wire::diagnostics`.
//!
//! Module map: [`model`] (report types), [`ports`] (collaborators), [`helpers`]
//! (`checkHelpers.ts`), [`checks`] (core, security and integration checks),
//! [`diagnostics_checks`] (error budget, memory pressure, alert routing),
//! [`health`] (`healthCommand.ts` and `healthChecks.ts`), [`doctor`]
//! (`doctorCommand.ts` and `doctorRules.ts`).

pub mod checks;
pub mod diagnostics_checks;
pub mod doctor;
pub mod health;
pub mod helpers;
pub mod model;
pub mod ports;

#[cfg(test)]
pub(crate) mod test_support;
