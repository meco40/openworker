//! Port of `src/server/gateway/node-command-policy.ts`.
//!
//! A deny-list over the normalised command text. The checks run on the same normalised
//! string the approval fingerprint is computed from, so a grant is bound to exactly the
//! text that was checked.
//!
//! Word boundaries are written `(?-u:\b)`. JavaScript's `\b` is ASCII-only, and the
//! Unicode-aware `\b` would let `éformat` slip past `\bformat\b`.

use std::sync::OnceLock;

use regex::Regex;
use sha2::{Digest, Sha256};

use super::types::is_js_space;

const BLOCKED_SUBSTRINGS: [&str; 14] = [
    "rm -rf",
    "mkfs",
    "dd if=",
    "shutdown",
    "reboot",
    "format ",
    "reg delete",
    "sc stop",
    "bcdedit",
    "diskpart",
    "powershell -enc",
    "invoke-expression",
    ":(){",
    "cipher /w",
];

const REASON_EMPTY: &str = "Command is empty.";
const REASON_BLOCKED: &str = "Command blocked by security policy.";

/// Result of [`evaluate_node_command_policy`]; mirrors `NodeCommandPolicyResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeCommandPolicyResult {
    pub allowed: bool,
    pub reason: Option<&'static str>,
    pub normalized_command: String,
    pub fingerprint: String,
}

/// `normalizeCommand`: trims and collapses every run of whitespace into one space.
pub fn normalize_command(command: &str) -> String {
    command
        .split(is_js_space)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `commandFingerprint`: SHA-256 hex of the normalised command.
pub fn command_fingerprint(command: &str) -> String {
    Sha256::digest(normalize_command(command).as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `evaluateNodeCommandPolicy`. Blocks by substring (case-insensitive) and by pattern.
pub fn evaluate_node_command_policy(command: &str) -> NodeCommandPolicyResult {
    let normalized_command = normalize_command(command);
    let reason = if normalized_command.is_empty() {
        Some(REASON_EMPTY)
    } else if is_blocked(&normalized_command) {
        Some(REASON_BLOCKED)
    } else {
        None
    };
    NodeCommandPolicyResult {
        allowed: reason.is_none(),
        reason,
        normalized_command,
        fingerprint: command_fingerprint(command),
    }
}

fn is_blocked(normalized: &str) -> bool {
    let lowered = normalized.to_lowercase();
    BLOCKED_SUBSTRINGS
        .iter()
        .any(|token| lowered.contains(*token))
        || blocked_patterns()
            .iter()
            .any(|pattern| pattern.is_match(normalized))
}

/// The three regex deny rules. `\s` is widened to include U+FEFF, which JavaScript's
/// `\s` matches and Rust's does not.
fn blocked_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?i)(?-u:\b)del[\s\x{FEFF}]+/f[\s\x{FEFF}]+/s[\s\x{FEFF}]+/q(?-u:\b)",
            r"(?i)(?-u:\b)format(?-u:\b)",
            r"(?i)(?-u:\b)iex(?-u:\b)",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("static regex"))
        .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_the_substring_deny_list_case_insensitively() {
        for command in [
            "rm -rf /tmp/x",
            "SHUTDOWN /r",
            "powershell -enc AAAA",
            ":(){ :|:& };:",
        ] {
            let result = evaluate_node_command_policy(command);
            assert!(!result.allowed, "{command} must be blocked");
            assert_eq!(result.reason, Some(REASON_BLOCKED));
        }
    }

    #[test]
    fn blocks_the_word_patterns_and_respects_ascii_boundaries() {
        assert!(!evaluate_node_command_policy("del /F /S /Q C:\\x").allowed);
        assert!(!evaluate_node_command_policy("format C:").allowed);
        assert!(!evaluate_node_command_policy("Invoke-Expression $x").allowed);
        assert!(!evaluate_node_command_policy("iex $x").allowed);
        // No trailing space, so only the `\bformat\b` pattern can catch it.
        assert!(
            !evaluate_node_command_policy("\u{e9}format").allowed,
            "é is no word char in JS"
        );
        assert!(evaluate_node_command_policy("formatter --check").allowed);
        assert!(evaluate_node_command_policy("ls -la").allowed);
    }

    #[test]
    fn empty_command_is_rejected_with_its_own_reason() {
        let result = evaluate_node_command_policy(" \t\u{feff} ");
        assert!(!result.allowed);
        assert_eq!(result.reason, Some(REASON_EMPTY));
    }

    #[test]
    fn normalisation_collapses_javascript_whitespace_including_bom() {
        assert_eq!(normalize_command("  echo\u{feff}\t hi \n"), "echo hi");
        assert_eq!(
            command_fingerprint("  echo   hi "),
            command_fingerprint("echo hi")
        );
    }

    #[test]
    fn fingerprint_is_sha256_of_the_normalised_text() {
        // SHA-256("abc"), the FIPS 180-2 test vector.
        assert_eq!(
            command_fingerprint("  abc  "),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
