//! Port of `src/server/master/verification.ts:1-90`.
//!
//! Builds the four-check verification report for one finished execution. The
//! check order is the behaviour: `checks[1]` (`non_empty_outputs`) alone decides
//! between `failed` and the softer verdicts, and `score` counts *all* four.
//!
//! # JavaScript string and number semantics
//!
//! * `output.trim().length >= 24` (`verification.ts:19`) measures
//!   `String.length`, which counts UTF-16 code units, not Unicode scalar values.
//!   The port therefore counts [`str::encode_utf16`] units as well: a 12-emoji
//!   output is 24 units in V8 and has to pass here too.
//! * `Math.round((passed / checks.length) * 100)` uses
//!   [`crate::js::js_round`], the crate's port of the V8 rounding rule (ties go
//!   towards `+∞`), instead of Rust's `f64::round`, which rounds half away from
//!   zero.

use crate::js::js_round;
use crate::master::types::{MasterStep, MasterStepStatus};

/// `VerificationStatus` from `verification.ts:3`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationStatus {
    Passed,
    Failed,
    NeedsRefinement,
}

impl VerificationStatus {
    /// The TypeScript literal.
    pub fn as_str(self) -> &'static str {
        match self {
            VerificationStatus::Passed => "passed",
            VerificationStatus::Failed => "failed",
            VerificationStatus::NeedsRefinement => "needs_refinement",
        }
    }
}

/// `VerificationCheckResult` from `verification.ts:5-9`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerificationCheckResult {
    pub name: &'static str,
    pub passed: bool,
    pub detail: String,
}

/// `VerificationReport` from `verification.ts:11-16`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerificationReport {
    pub status: VerificationStatus,
    /// `Math.round(...)` result, so always an integer in `0..=100`.
    pub score: i64,
    pub summary: &'static str,
    pub checks: Vec<VerificationCheckResult>,
}

/// `input` of `verifyExecutionResult` — `verification.ts:22-26`.
#[derive(Debug, Clone, PartialEq)]
pub struct VerificationInput<'a> {
    pub outputs: &'a [String],
    pub steps: &'a [MasterStep],
    pub expected_capabilities: &'a [String],
}

/// `hasSufficientContent` — `verification.ts:18-20`.
///
/// `output.trim().length >= 24` with `String.length` semantics (UTF-16 units).
fn has_sufficient_content(output: &str) -> bool {
    output.trim().encode_utf16().count() >= 24
}

/// `verifyExecutionResult` — `verification.ts:22-90`.
pub fn verify_execution_result(input: &VerificationInput<'_>) -> VerificationReport {
    let mut checks: Vec<VerificationCheckResult> = Vec::with_capacity(4);

    let error_steps = input
        .steps
        .iter()
        .filter(|step| step.status == MasterStepStatus::Error.as_str())
        .count();
    checks.push(VerificationCheckResult {
        name: "no_error_steps",
        passed: error_steps == 0,
        detail: if error_steps == 0 {
            "No error steps found.".to_string()
        } else {
            format!("{error_steps} step(s) ended with error.")
        },
    });

    let output_count = input
        .outputs
        .iter()
        .filter(|entry| !entry.trim().is_empty())
        .count();
    checks.push(VerificationCheckResult {
        name: "non_empty_outputs",
        passed: output_count > 0,
        detail: if output_count > 0 {
            format!("{output_count} non-empty output(s).")
        } else {
            "No non-empty output.".to_string()
        },
    });

    let structured_count = input
        .outputs
        .iter()
        .filter(|entry| has_sufficient_content(entry))
        .count();
    // `Math.max(1, Math.min(2, expectedCapabilities.length))`.
    let required_structured = input.expected_capabilities.len().clamp(1, 2);
    checks.push(VerificationCheckResult {
        name: "structured_outputs",
        passed: structured_count >= required_structured,
        detail: format!("{structured_count} sufficiently detailed output(s)."),
    });

    let phase_coverage = input.expected_capabilities.iter().all(|capability| {
        input
            .steps
            .iter()
            .any(|step| step.phase.contains(capability.as_str()))
    });
    checks.push(VerificationCheckResult {
        name: "capability_phase_coverage",
        passed: phase_coverage,
        detail: if phase_coverage {
            "All planned capabilities produced phases.".to_string()
        } else {
            "At least one planned capability is missing execution phases.".to_string()
        },
    });

    let passed_checks = checks.iter().filter(|check| check.passed).count();
    let score = js_round((passed_checks as f64 / checks.len() as f64) * 100.0) as i64;

    // `checks.find(entry => entry.name === 'non_empty_outputs')?.passed`
    let non_empty_passed = checks
        .iter()
        .find(|check| check.name == "non_empty_outputs")
        .map(|check| check.passed)
        .unwrap_or(false);

    let all_passed = checks.iter().all(|check| check.passed);
    let (status, summary) = if !non_empty_passed {
        (
            VerificationStatus::Failed,
            "Verification failed: no meaningful execution output produced.",
        )
    } else if !all_passed {
        (
            VerificationStatus::NeedsRefinement,
            "Verification requires refinement before completion.",
        )
    } else {
        (VerificationStatus::Passed, "Verification passed.")
    };

    VerificationReport {
        status,
        score,
        summary,
        checks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(seq: i64, phase: &str, status: &str) -> MasterStep {
        MasterStep {
            id: format!("s{seq}"),
            run_id: "r1".to_string(),
            user_id: "u1".to_string(),
            workspace_id: "w1".to_string(),
            seq,
            phase: phase.to_string(),
            status: status.to_string(),
            input: None,
            output: None,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    fn outputs(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| entry.to_string()).collect()
    }

    fn capabilities(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| entry.to_string()).collect()
    }

    const LONG: &str = "012345678901234567890123"; // exactly 24 units
    const SHORT: &str = "01234567890123456789012"; // 23 units

    fn check<'a>(report: &'a VerificationReport, name: &str) -> &'a VerificationCheckResult {
        report
            .checks
            .iter()
            .find(|entry| entry.name == name)
            .expect("check exists")
    }

    #[test]
    fn the_detailed_output_threshold_is_twenty_four_code_units() {
        assert!(has_sufficient_content(LONG));
        assert!(!has_sufficient_content(SHORT));
        // The boundary counts *trimmed* units.
        assert!(has_sufficient_content(&format!("  {LONG}  ")));
    }

    #[test]
    fn astral_characters_count_as_two_units_like_string_length() {
        // 12 emoji are 24 UTF-16 units in V8 but only 12 scalar values; the port
        // must treat them as sufficient.
        let emoji = "🌍".repeat(12);
        assert_eq!(emoji.chars().count(), 12);
        assert_eq!(emoji.encode_utf16().count(), 24);
        assert!(has_sufficient_content(&emoji));
        assert!(!has_sufficient_content(&"🌍".repeat(6)));
    }

    #[test]
    fn a_fully_passing_run_reports_passed_with_score_one_hundred() {
        let outputs = outputs(&[LONG, LONG]);
        let steps = vec![step(1, "cap-a", "done")];
        let expected = capabilities(&["cap-a"]);
        let report = verify_execution_result(&VerificationInput {
            outputs: &outputs,
            steps: &steps,
            expected_capabilities: &expected,
        });
        assert_eq!(report.status, VerificationStatus::Passed);
        assert_eq!(report.status.as_str(), "passed");
        assert_eq!(report.score, 100);
        assert_eq!(report.summary, "Verification passed.");
        assert_eq!(report.checks.len(), 4);
    }

    #[test]
    fn no_output_fails_with_the_failed_summary_even_when_steps_are_clean() {
        let outputs: Vec<String> = Vec::new();
        let steps = vec![step(1, "cap-a", "done")];
        let expected = capabilities(&["cap-a"]);
        let report = verify_execution_result(&VerificationInput {
            outputs: &outputs,
            steps: &steps,
            expected_capabilities: &expected,
        });
        assert_eq!(report.status, VerificationStatus::Failed);
        assert_eq!(
            report.summary,
            "Verification failed: no meaningful execution output produced."
        );
        assert_eq!(
            check(&report, "non_empty_outputs").detail,
            "No non-empty output."
        );
        // no_error_steps and capability_phase_coverage passed: 2 of 4.
        assert_eq!(report.score, 50);
    }

    #[test]
    fn whitespace_only_outputs_do_not_count_as_non_empty() {
        let outputs = outputs(&["   ", "\t\n"]);
        let steps = vec![step(1, "cap-a", "done")];
        let expected = capabilities(&["cap-a"]);
        let report = verify_execution_result(&VerificationInput {
            outputs: &outputs,
            steps: &steps,
            expected_capabilities: &expected,
        });
        assert_eq!(report.status, VerificationStatus::Failed);
        assert!(!check(&report, "non_empty_outputs").passed);
    }

    #[test]
    fn error_steps_and_missing_phases_need_refinement() {
        let outputs = outputs(&[LONG, LONG]);
        let steps = vec![step(1, "cap-a", "error")];
        let expected = capabilities(&["cap-a"]);
        let report = verify_execution_result(&VerificationInput {
            outputs: &outputs,
            steps: &steps,
            expected_capabilities: &expected,
        });
        assert_eq!(report.status, VerificationStatus::NeedsRefinement);
        assert_eq!(
            report.summary,
            "Verification requires refinement before completion."
        );
        assert_eq!(
            check(&report, "no_error_steps").detail,
            "1 step(s) ended with error."
        );
        // structured_outputs passed as well, so 3 of 4.
        assert_eq!(report.score, 75);
    }

    #[test]
    fn the_structured_output_requirement_is_clamped_to_one_or_two() {
        // No planned capability still demands one detailed output.
        let short_only = outputs(&[SHORT]);
        let steps: Vec<MasterStep> = Vec::new();
        let expected: Vec<String> = Vec::new();
        let report = verify_execution_result(&VerificationInput {
            outputs: &short_only,
            steps: &steps,
            expected_capabilities: &expected,
        });
        let structured = check(&report, "structured_outputs");
        assert!(!structured.passed);
        assert_eq!(structured.detail, "0 sufficiently detailed output(s).");

        // Three capabilities do not raise the bar above two.
        let mixed = outputs(&[LONG, LONG, SHORT]);
        let expected = capabilities(&["a", "b", "c"]);
        let report = verify_execution_result(&VerificationInput {
            outputs: &mixed,
            steps: &steps,
            expected_capabilities: &expected,
        });
        assert!(check(&report, "structured_outputs").passed);
    }

    #[test]
    fn phase_coverage_looks_for_the_capability_as_a_substring() {
        let outputs = outputs(&[LONG, LONG]);
        let expected = capabilities(&["cap-a", "cap-b"]);
        let steps = vec![step(1, "phase:cap-a", "done"), step(2, "cap-b", "done")];
        let report = verify_execution_result(&VerificationInput {
            outputs: &outputs,
            steps: &steps,
            expected_capabilities: &expected,
        });
        assert!(check(&report, "capability_phase_coverage").passed);
        assert_eq!(
            check(&report, "capability_phase_coverage").detail,
            "All planned capabilities produced phases."
        );

        let steps = vec![step(1, "cap-a", "done")];
        let report = verify_execution_result(&VerificationInput {
            outputs: &outputs,
            steps: &steps,
            expected_capabilities: &expected,
        });
        let coverage = check(&report, "capability_phase_coverage");
        assert!(!coverage.passed);
        assert_eq!(
            coverage.detail,
            "At least one planned capability is missing execution phases."
        );
    }

    #[test]
    fn the_score_counts_all_four_checks_and_rounds_like_v8() {
        // Only non_empty_outputs passes: 1 of 4 = 25.
        let outputs = outputs(&[SHORT]);
        let steps = vec![step(1, "cap-a", "error")];
        let expected = capabilities(&["cap-b"]);
        let report = verify_execution_result(&VerificationInput {
            outputs: &outputs,
            steps: &steps,
            expected_capabilities: &expected,
        });
        assert!(check(&report, "non_empty_outputs").passed);
        assert_eq!(report.score, 25);
        assert_eq!(report.status, VerificationStatus::NeedsRefinement);
    }
}
