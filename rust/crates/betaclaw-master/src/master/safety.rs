//! Port of `src/server/master/safety.ts:1-27`.
//!
//! A pure string classifier for system commands: no I/O, no state, and the
//! answer depends only on the trimmed command. The three pattern lists keep the
//! source order because it is the decision order — a command that matches a
//! forbidden pattern is blocked even when it also looks high risk.
//!
//! The `risk` field is `'low' | 'medium' | 'high'`, declared inline in
//! `safety.ts:5`; the port reuses [`MasterRiskLevel`] from
//! `shared/masterTypes.ts:101`, which is the same three literals, so the value
//! stays comparable with the approval-request rows that carry it.
//!
//! The four TypeScript `RegExp`s are compiled once with [`OnceLock`]. They are
//! unanchored (`.test`), so every pattern matches anywhere in the string —
//! `/copy/i` matching `copyright` is intended behaviour and pinned by a test.

use std::sync::OnceLock;

use regex::Regex;

use crate::master::types::MasterRiskLevel;

/// `SafetyEvaluation` from `safety.ts:1-6`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafetyEvaluation {
    pub allowed: bool,
    pub requires_approval: bool,
    /// `reason?` — absent on the allow path (`safety.ts:26`).
    pub reason: Option<&'static str>,
    pub risk: MasterRiskLevel,
}

/// `FORBIDDEN_PATTERNS` — `safety.ts:8`.
fn forbidden_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"(?i)rm\s+-rf\s+/").expect("static regex"),
            Regex::new(r"(?i)del\s+/s\s+/q").expect("static regex"),
            Regex::new(r"(?i)format\s+[a-z]:").expect("static regex"),
        ]
    })
}

/// `HIGH_RISK_PATTERNS` — `safety.ts:9`.
fn high_risk_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"(?i)shutdown").expect("static regex"),
            Regex::new(r"(?i)restart").expect("static regex"),
            Regex::new(r"(?i)kill\s+\d+").expect("static regex"),
            Regex::new(r"(?i)sc\s+stop").expect("static regex"),
        ]
    })
}

/// `MEDIUM_RISK_PATTERNS` — `safety.ts:10`.
fn medium_risk_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"(?i)npm\s+install").expect("static regex"),
            Regex::new(r"(?i)git\s+push").expect("static regex"),
            Regex::new(r"(?i)mkdir").expect("static regex"),
            Regex::new(r"(?i)copy").expect("static regex"),
        ]
    })
}

fn matches_any(patterns: &[Regex], command: &str) -> bool {
    patterns.iter().any(|pattern| pattern.is_match(command))
}

/// `evaluateSystemActionSafety` — `safety.ts:12-27`.
///
/// `String(command || '').trim()` is reproduced: a `None` and an empty string
/// both normalise to `""` and take the `empty_command` branch, and the trim is
/// applied before matching so `"  mkdir x  "` still matches.
pub fn evaluate_system_action_safety(command: Option<&str>) -> SafetyEvaluation {
    let normalized = command.unwrap_or("").trim();
    if normalized.is_empty() {
        return SafetyEvaluation {
            allowed: false,
            requires_approval: false,
            reason: Some("empty_command"),
            risk: MasterRiskLevel::High,
        };
    }
    if matches_any(forbidden_patterns(), normalized) {
        return SafetyEvaluation {
            allowed: false,
            requires_approval: false,
            reason: Some("forbidden_action"),
            risk: MasterRiskLevel::High,
        };
    }
    if matches_any(high_risk_patterns(), normalized) {
        return SafetyEvaluation {
            allowed: true,
            requires_approval: true,
            reason: Some("high_risk"),
            risk: MasterRiskLevel::High,
        };
    }
    if matches_any(medium_risk_patterns(), normalized) {
        return SafetyEvaluation {
            allowed: true,
            requires_approval: true,
            reason: Some("medium_risk"),
            risk: MasterRiskLevel::Medium,
        };
    }
    SafetyEvaluation {
        allowed: true,
        requires_approval: false,
        reason: None,
        risk: MasterRiskLevel::Low,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evaluate(command: &str) -> SafetyEvaluation {
        evaluate_system_action_safety(Some(command))
    }

    #[test]
    fn an_empty_or_blank_command_is_blocked_with_high_risk() {
        for command in ["", "   ", "\t\n"] {
            let result = evaluate(command);
            assert_eq!(result.reason, Some("empty_command"), "{command:?}");
            assert!(!result.allowed);
            assert!(!result.requires_approval);
            assert_eq!(result.risk, MasterRiskLevel::High);
        }
        // `String(undefined || '')` behaves like the empty string.
        assert_eq!(
            evaluate_system_action_safety(None),
            evaluate(""),
            "None must normalise like the empty string"
        );
    }

    #[test]
    fn forbidden_patterns_are_blocked_case_insensitively() {
        for command in [
            "rm -rf /",
            "RM -RF /home",
            "del /s /q C:\\tmp",
            "DEL /S /Q C:\\tmp",
            "format c:",
            "FORMAT C:",
        ] {
            let result = evaluate(command);
            assert_eq!(result.reason, Some("forbidden_action"), "{command:?}");
            assert!(!result.allowed);
            assert!(!result.requires_approval, "blocked is not an approval ask");
            assert_eq!(result.risk, MasterRiskLevel::High);
        }
    }

    #[test]
    fn high_risk_patterns_are_allowed_but_need_approval() {
        for command in [
            "shutdown -h now",
            "sudo RESTART service",
            "kill 4711",
            "sc stop spooler",
        ] {
            let result = evaluate(command);
            assert_eq!(result.reason, Some("high_risk"), "{command:?}");
            assert!(result.allowed);
            assert!(result.requires_approval);
            assert_eq!(result.risk, MasterRiskLevel::High);
        }
    }

    #[test]
    fn medium_risk_patterns_are_allowed_but_need_approval() {
        for command in [
            "npm install left-pad",
            "git PUSH origin main",
            "mkdir -p a/b",
            "copy a b",
        ] {
            let result = evaluate(command);
            assert_eq!(result.reason, Some("medium_risk"), "{command:?}");
            assert!(result.allowed);
            assert!(result.requires_approval);
            assert_eq!(result.risk, MasterRiskLevel::Medium);
        }
    }

    #[test]
    fn the_patterns_are_unanchored_like_regexp_test() {
        // `kill 4711` needs the digits, `kill` alone is harmless.
        assert_eq!(evaluate("kill them").reason, None);
        assert_eq!(evaluate("kill 4711").reason, Some("high_risk"));
        assert_eq!(evaluate("sc stop spooler").reason, Some("high_risk"));
        // `/sc\s+stop/i` also matches inside `sc stopped` — unanchored, like the
        // source. Same for `/copy/i` in another word and for `mkdir` alone.
        assert_eq!(evaluate("sc stopped").reason, Some("high_risk"));
        assert_eq!(evaluate("copyright notice").reason, Some("medium_risk"));
        assert_eq!(evaluate("mkdir").reason, Some("medium_risk"));
        // The trim happens before matching.
        assert_eq!(evaluate("   npm install   ").reason, Some("medium_risk"));
    }

    #[test]
    fn forbidden_wins_over_high_and_high_wins_over_medium() {
        assert_eq!(
            evaluate("rm -rf / && npm install").reason,
            Some("forbidden_action")
        );
        assert_eq!(evaluate("shutdown && mkdir x").reason, Some("high_risk"));
    }

    #[test]
    fn a_plain_command_is_allowed_low_risk_and_has_no_reason() {
        let result = evaluate("ls -la");
        assert!(result.allowed);
        assert!(!result.requires_approval);
        assert_eq!(result.reason, None);
        assert_eq!(result.risk, MasterRiskLevel::Low);
        assert_eq!(result.risk.as_str(), "low");
    }
}
