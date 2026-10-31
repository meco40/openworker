//! Port of `src/server/master/toolforge/sandboxRunner.ts:1-19`.
//!
//! # The sandbox is a seam owned by S11 (OP-S9-2, OP-S9-17)
//!
//! The TypeScript `runToolForgeSandboxChecks` is the placeholder the toolforge
//! pipeline consults before it writes an artifact, and the *real* sandboxed
//! execution belongs to Slice S11. Following the lane's rule — never reimplement
//! a sandbox — this module ports only the seam: [`ToolForgeSandboxRunner`], with
//! the input and result shapes of the source. There is deliberately no default
//! implementation; the pipeline takes the runner as a parameter, exactly like
//! [`crate::master::execution::approval_policy::ToolPolicyResolver`]. OP-S9-2
//! reserves the sandbox *body* for S11; OP-S9-17 is the seam P5 opens here.

/// `input` of `runToolForgeSandboxChecks` — `sandboxRunner.ts:1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolForgeSandboxInput {
    pub name: String,
    pub spec: String,
}

/// `{ passed, summary, riskReport }` — the return of `runToolForgeSandboxChecks`
/// (`sandboxRunner.ts:1-5`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolForgeSandboxResult {
    pub passed: bool,
    pub summary: String,
    pub risk_report: String,
}

/// The S11 seam for `runToolForgeSandboxChecks` (OP-S9-2).
///
/// The concrete sandboxed runner is supplied by Slice S11; S9 only routes the
/// verdict into the artifact's `testSummary`, `riskReport` and `status`.
pub trait ToolForgeSandboxRunner: Send + Sync {
    fn run_sandbox_checks(&self, input: &ToolForgeSandboxInput) -> ToolForgeSandboxResult;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted runner, used by the pipeline tests too.
    struct FixedRunner(ToolForgeSandboxResult);

    impl ToolForgeSandboxRunner for FixedRunner {
        fn run_sandbox_checks(&self, _input: &ToolForgeSandboxInput) -> ToolForgeSandboxResult {
            self.0.clone()
        }
    }

    #[test]
    fn the_seam_carries_the_verdict_through() {
        let runner = FixedRunner(ToolForgeSandboxResult {
            passed: false,
            summary: "Sandbox checks failed".to_string(),
            risk_report: "high: dangerous command patterns detected".to_string(),
        });
        let result = runner.run_sandbox_checks(&ToolForgeSandboxInput {
            name: "x".to_string(),
            spec: "{}".to_string(),
        });
        assert!(!result.passed);
        assert_eq!(result.summary, "Sandbox checks failed");
        assert_eq!(
            result.risk_report,
            "high: dangerous command patterns detected"
        );
    }
}
