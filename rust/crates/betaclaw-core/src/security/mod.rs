//! Security status reporting.
//!
//! Ports `src/server/security/status.ts` and `policyExplain.ts`. Both endpoints
//! expose the effective security posture to the UI, so their field names and
//! thresholds are part of the API contract.

pub mod policy;
pub mod status;

pub use policy::{build_effective_policy_explain_snapshot, EffectivePolicyExplainSnapshot};
pub use status::{build_security_status_snapshot, SecurityStatusSnapshot};
