//! Port of `src/server/master/systemOps.ts:1-86`.
//!
//! Turns a system command plus an optional approval decision into one of three
//! outcomes: blocked, awaiting approval, or executed. The safety classifier
//! decides first ([`evaluate_system_action_safety`]), and the two entry points
//! differ only in how the command is carried out:
//!
//! * [`execute_system_operation`] never runs anything — it answers with the
//!   dry-run line `Dry-run simulated for command: …` (`systemOps.ts:44`).
//! * [`execute_system_operation_with_runtime`] calls the injected closure and
//!   prefers `stdout`, then `stderr`, then the exit-code sentence
//!   (`systemOps.ts:74-79`).
//!
//! # `await execute()` becomes an injected closure
//!
//! The TypeScript function awaits a promise and lets a rejection propagate. The
//! port takes a synchronous `impl FnOnce() -> SystemCommandOutput`, so a caller
//! whose command can fail has to decide what `stdout`/`stderr`/`exitCode` a
//! failure produces — which is exactly the shape the TypeScript return type
//! describes. Nothing about the classification or the output preference changes.

use std::future::Future;

use crate::master::safety::evaluate_system_action_safety;
use crate::master::types::{ApprovalDecision, MasterRiskLevel};

/// `SystemOpResult` from `systemOps.ts:4-9`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemOpResult {
    pub status: SystemOpStatus,
    pub output: String,
    /// `requiresApproval?` — always present in practice, optional in the source.
    pub requires_approval: Option<bool>,
    /// `risk?` — always present in practice, optional in the source.
    pub risk: Option<MasterRiskLevel>,
}

/// `status` of `SystemOpResult` — `systemOps.ts:5`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemOpStatus {
    Blocked,
    AwaitingApproval,
    Executed,
}

impl SystemOpStatus {
    /// The TypeScript literal.
    pub fn as_str(self) -> &'static str {
        match self {
            SystemOpStatus::Blocked => "blocked",
            SystemOpStatus::AwaitingApproval => "awaiting_approval",
            SystemOpStatus::Executed => "executed",
        }
    }
}

/// `execute()` of `executeSystemOperationWithRuntime` — `systemOps.ts:53`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SystemCommandOutput {
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub exit_code: Option<i64>,
}

/// `executeSystemOperation` — `systemOps.ts:11-48`.
///
/// `input.decision` is `ApprovalDecision | undefined`; `None` is the absent
/// property. `approve_once` and `approve_always` both fall through to the
/// dry-run line, because the source only branches on `'deny'`.
pub fn execute_system_operation(
    command: Option<&str>,
    decision: Option<ApprovalDecision>,
) -> SystemOpResult {
    let safety = evaluate_system_action_safety(command);
    if !safety.allowed {
        return SystemOpResult {
            status: SystemOpStatus::Blocked,
            output: format!("Blocked: {}", safety.reason.unwrap_or("")),
            requires_approval: Some(safety.requires_approval),
            risk: Some(safety.risk),
        };
    }
    if safety.requires_approval {
        match decision {
            None => {
                return SystemOpResult {
                    status: SystemOpStatus::AwaitingApproval,
                    output: "Approval required before execution.".to_string(),
                    requires_approval: Some(true),
                    risk: Some(safety.risk),
                };
            }
            Some(ApprovalDecision::Deny) => {
                return SystemOpResult {
                    status: SystemOpStatus::Blocked,
                    output: "Action denied by operator.".to_string(),
                    requires_approval: Some(true),
                    risk: Some(safety.risk),
                };
            }
            Some(_) => {}
        }
    }
    SystemOpResult {
        status: SystemOpStatus::Executed,
        output: format!("Dry-run simulated for command: {}", command.unwrap_or("")),
        requires_approval: Some(safety.requires_approval),
        risk: Some(safety.risk),
    }
}

/// `executeSystemOperationWithRuntime` — `systemOps.ts:50-86`.
///
/// The preferred output is the trimmed `stdout`, then the trimmed `stderr`, then
/// `System command executed with exit code ${exitCode ?? 0}.` — the `??` turns an
/// absent *or* `null` exit code into `0`.
pub fn execute_system_operation_with_runtime(
    command: &str,
    approved: bool,
    execute: impl FnOnce() -> SystemCommandOutput,
) -> SystemOpResult {
    match gate(command, approved) {
        Ok(gate) => executed(&gate, &execute()),
        Err(early) => early,
    }
}

/// The awaited form of [`execute_system_operation_with_runtime`], which is the
/// source's `await execute()`. A failing `execute` returns `Err`, the same way a
/// rejected promise propagates in `systemOps.ts`.
pub async fn execute_system_operation_with_runtime_async<E, Fut>(
    command: &str,
    approved: bool,
    execute: impl FnOnce() -> Fut,
) -> Result<SystemOpResult, E>
where
    Fut: Future<Output = Result<SystemCommandOutput, E>>,
{
    match gate(command, approved) {
        Ok(gate) => Ok(executed(&gate, &execute().await?)),
        Err(early) => Ok(early),
    }
}

/// The safety fields that an executed result reports.
struct SystemOpGate {
    requires_approval: bool,
    risk: MasterRiskLevel,
}

/// The early returns of `executeSystemOperationWithRuntime`: blocked, or
/// awaiting approval. `Ok` lets the command run.
fn gate(command: &str, approved: bool) -> Result<SystemOpGate, SystemOpResult> {
    let safety = evaluate_system_action_safety(Some(command));
    if !safety.allowed {
        return Err(SystemOpResult {
            status: SystemOpStatus::Blocked,
            output: format!("Blocked: {}", safety.reason.unwrap_or("")),
            requires_approval: Some(safety.requires_approval),
            risk: Some(safety.risk),
        });
    }
    if safety.requires_approval && !approved {
        return Err(SystemOpResult {
            status: SystemOpStatus::AwaitingApproval,
            output: "Approval required before execution.".to_string(),
            requires_approval: Some(true),
            risk: Some(safety.risk),
        });
    }
    Ok(SystemOpGate {
        requires_approval: safety.requires_approval,
        risk: safety.risk,
    })
}

/// The executed result, with the output preference of `systemOps.ts:70-79`.
fn executed(gate: &SystemOpGate, result: &SystemCommandOutput) -> SystemOpResult {
    let trimmed = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let output = trimmed(&result.stdout)
        .or_else(|| trimmed(&result.stderr))
        .unwrap_or_else(|| {
            format!(
                "System command executed with exit code {}.",
                result.exit_code.unwrap_or(0)
            )
        });

    SystemOpResult {
        status: SystemOpStatus::Executed,
        output,
        requires_approval: Some(gate.requires_approval),
        risk: Some(gate.risk),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ApprovalDecision::{ApproveAlways, ApproveOnce, Deny};

    fn output(
        stdout: Option<&str>,
        stderr: Option<&str>,
        exit_code: Option<i64>,
    ) -> SystemCommandOutput {
        SystemCommandOutput {
            stdout: stdout.map(str::to_string),
            stderr: stderr.map(str::to_string),
            exit_code,
        }
    }

    #[test]
    fn a_blocked_command_is_never_executed() {
        let result = execute_system_operation(Some("rm -rf /"), None);
        assert_eq!(result.status, SystemOpStatus::Blocked);
        assert_eq!(result.status.as_str(), "blocked");
        assert_eq!(result.output, "Blocked: forbidden_action");
        assert_eq!(result.requires_approval, Some(false));
        assert_eq!(result.risk, Some(MasterRiskLevel::High));
    }

    #[test]
    fn an_empty_command_reports_the_empty_command_reason() {
        let result = execute_system_operation(None, None);
        assert_eq!(result.status, SystemOpStatus::Blocked);
        assert_eq!(result.output, "Blocked: empty_command");
        assert_eq!(result.requires_approval, Some(false));
    }

    #[test]
    fn a_high_risk_command_waits_for_a_decision() {
        let result = execute_system_operation(Some("shutdown -h now"), None);
        assert_eq!(result.status, SystemOpStatus::AwaitingApproval);
        assert_eq!(result.output, "Approval required before execution.");
        assert_eq!(result.requires_approval, Some(true));
        assert_eq!(result.risk, Some(MasterRiskLevel::High));
    }

    #[test]
    fn a_denied_command_is_blocked_with_the_operator_message() {
        let result = execute_system_operation(Some("mkdir x"), Some(Deny));
        assert_eq!(result.status, SystemOpStatus::Blocked);
        assert_eq!(result.output, "Action denied by operator.");
        assert_eq!(result.requires_approval, Some(true));
        assert_eq!(result.risk, Some(MasterRiskLevel::Medium));
    }

    #[test]
    fn an_approved_command_answers_with_the_dry_run_line() {
        for decision in [Some(ApproveOnce), Some(ApproveAlways)] {
            let result = execute_system_operation(Some("mkdir x"), decision);
            assert_eq!(result.status, SystemOpStatus::Executed);
            assert_eq!(result.output, "Dry-run simulated for command: mkdir x");
            assert_eq!(result.requires_approval, Some(true));
            assert_eq!(result.risk, Some(MasterRiskLevel::Medium));
        }
    }

    #[test]
    fn a_low_risk_command_executes_without_a_decision() {
        let result = execute_system_operation(Some("ls -la"), None);
        assert_eq!(result.status, SystemOpStatus::Executed);
        assert_eq!(result.output, "Dry-run simulated for command: ls -la");
        assert_eq!(result.requires_approval, Some(false));
        assert_eq!(result.risk, Some(MasterRiskLevel::Low));
    }

    #[test]
    fn the_runtime_path_does_not_call_execute_when_it_must_not() {
        let result = execute_system_operation_with_runtime("rm -rf /", true, || {
            panic!("a blocked command must not reach execute()")
        });
        assert_eq!(result.status, SystemOpStatus::Blocked);

        let result = execute_system_operation_with_runtime("shutdown -h now", false, || {
            panic!("an unapproved command must not reach execute()")
        });
        assert_eq!(result.status, SystemOpStatus::AwaitingApproval);
    }

    #[test]
    fn the_runtime_path_prefers_stdout_then_stderr_then_the_exit_code() {
        let result = execute_system_operation_with_runtime("ls", true, || {
            output(Some("  hi  "), Some("warn"), Some(3))
        });
        assert_eq!(result.status, SystemOpStatus::Executed);
        assert_eq!(result.output, "hi");

        let result = execute_system_operation_with_runtime("ls", true, || {
            output(Some("   "), Some("  warn  "), Some(3))
        });
        assert_eq!(result.output, "warn");

        let result =
            execute_system_operation_with_runtime("ls", true, || output(None, None, Some(7)));
        assert_eq!(result.output, "System command executed with exit code 7.");

        // `exitCode ?? 0`.
        let result = execute_system_operation_with_runtime("ls", true, || output(None, None, None));
        assert_eq!(result.output, "System command executed with exit code 0.");
    }

    #[test]
    fn the_runtime_path_keeps_the_safety_verdict_in_the_result() {
        let result =
            execute_system_operation_with_runtime("mkdir x", true, || output(None, None, None));
        assert_eq!(result.requires_approval, Some(true));
        assert_eq!(result.risk, Some(MasterRiskLevel::Medium));

        let result = execute_system_operation_with_runtime("ls", true, || output(None, None, None));
        assert_eq!(result.requires_approval, Some(false));
        assert_eq!(result.risk, Some(MasterRiskLevel::Low));
    }
}
