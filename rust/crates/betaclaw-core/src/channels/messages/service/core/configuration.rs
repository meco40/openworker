//! Port of `src/server/channels/messages/service/core/configuration.ts`.
//!
//! The TypeScript functions read `process.env` directly. The port takes an
//! [`EnvOverrides`] argument instead, so tests can set values without touching the
//! process environment.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::channels::messages::service::types::{
    AUTONOMOUS_BUILD_MAX_TOOL_CALLS, SUBAGENT_MAX_ACTIVE_PER_CONVERSATION, TOOL_CALLS_HARD_CAP,
};
use crate::channels::messages::service::utils::js_regex::js_regex;
use crate::model_hub::env::EnvOverrides;

/// `/```[\s\S]*?```/g`.
static CODE_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)```.*?```").expect("static"));
static EXCESS_NEWLINES_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n{3,}").expect("static"));
static ASKS_FOR_CODE_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)\b(code|source|snippet|beispielcode|zeige code|show code|codeblock|implementation details?)\b",
    )
});

/// JavaScript `parseInt(value, 10)` for the env strings used here: optional
/// whitespace and sign, then leading digits. Trailing text is ignored. `None` is `NaN`.
fn parse_int_prefix(value: &str) -> Option<i64> {
    let trimmed = value.trim_start();
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1i64, rest),
        None => (1i64, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    // JavaScript yields a large float here, which the callers clamp. Saturate so
    // the same clamp applies instead of falling back to the default.
    let magnitude = digits[..end].parse::<i64>().unwrap_or(i64::MAX);
    Some(sign * magnitude)
}

/// `getSubagentMaxActivePerConversation()` (`configuration.ts:15-21`).
pub fn get_subagent_max_active_per_conversation(env: &EnvOverrides) -> i64 {
    let raw = env
        .get("SUBAGENT_MAX_ACTIVE")
        .and_then(|value| parse_int_prefix(&value));
    match raw {
        Some(value) if value > 0 => value.clamp(1, 20),
        _ => SUBAGENT_MAX_ACTIVE_PER_CONVERSATION,
    }
}

/// `requiresInteractiveToolApproval()` (`configuration.ts:26-28`).
pub fn requires_interactive_tool_approval(env: &EnvOverrides) -> bool {
    env.get_or("BETACLAW_EXEC_APPROVALS_REQUIRED", "false")
        .to_lowercase()
        == "true"
}

/// `resolveAutonomousBuildMaxToolCalls()` (`configuration.ts:33-39`).
pub fn resolve_autonomous_build_max_tool_calls(env: &EnvOverrides) -> i64 {
    let raw = env
        .get("BETACLAW_AUTONOMOUS_MAX_TOOL_CALLS")
        .and_then(|value| parse_int_prefix(&value));
    match raw {
        Some(value) if value > 0 => {
            AUTONOMOUS_BUILD_MAX_TOOL_CALLS.max(TOOL_CALLS_HARD_CAP.min(value))
        }
        _ => AUTONOMOUS_BUILD_MAX_TOOL_CALLS,
    }
}

/// `shouldAllowCodeInResponse(userInput, metadata)` (`configuration.ts:44-58`).
/// Code is allowed when the user asks for it, or when the turn failed.
pub fn should_allow_code_in_response(user_input: &str, metadata: &Value) -> bool {
    if ASKS_FOR_CODE_RE.is_match(user_input) {
        return true;
    }
    if metadata.get("ok") == Some(&Value::Bool(false)) {
        return true;
    }
    let status = match metadata.get("status") {
        Some(Value::String(text)) => text.as_str(),
        _ => "",
    };
    status.contains("error") || status.contains("failed")
}

/// `stripCodeBlocksIfNeeded(content, shouldAllowCode)` (`configuration.ts:63-72`).
pub fn strip_code_blocks_if_needed(content: &str, should_allow_code: bool) -> String {
    if should_allow_code {
        return content.to_string();
    }
    if !content.contains("```") {
        return content.to_string();
    }
    let stripped = CODE_BLOCK_RE.replace_all(
        content,
        "[Code weggelassen. Umsetzung wurde im Projekt-Workspace ausgefuehrt.]",
    );
    EXCESS_NEWLINES_RE
        .replace_all(&stripped, "\n\n")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_int_follows_javascript_prefix_rules() {
        assert_eq!(parse_int_prefix("12px"), Some(12));
        assert_eq!(parse_int_prefix("  -3"), Some(-3));
        assert_eq!(parse_int_prefix("+7"), Some(7));
        assert_eq!(parse_int_prefix("abc"), None);
        assert_eq!(parse_int_prefix(""), None);
    }

    #[test]
    fn subagent_limit_is_clamped_to_one_through_twenty() {
        let unset = EnvOverrides::new();
        assert_eq!(get_subagent_max_active_per_conversation(&unset), 5);
        let high = EnvOverrides::new().with("SUBAGENT_MAX_ACTIVE", "99");
        assert_eq!(get_subagent_max_active_per_conversation(&high), 20);
        let zero = EnvOverrides::new().with("SUBAGENT_MAX_ACTIVE", "0");
        assert_eq!(get_subagent_max_active_per_conversation(&zero), 5);
    }

    #[test]
    fn approval_flag_is_case_insensitive_true_only() {
        assert!(requires_interactive_tool_approval(
            &EnvOverrides::new().with("BETACLAW_EXEC_APPROVALS_REQUIRED", "TRUE")
        ));
        assert!(!requires_interactive_tool_approval(
            &EnvOverrides::new().with("BETACLAW_EXEC_APPROVALS_REQUIRED", "1")
        ));
        assert!(!requires_interactive_tool_approval(&EnvOverrides::new()));
    }

    #[test]
    fn autonomous_cap_never_drops_below_the_default() {
        let small = EnvOverrides::new().with("BETACLAW_AUTONOMOUS_MAX_TOOL_CALLS", "10");
        assert_eq!(resolve_autonomous_build_max_tool_calls(&small), 120);
        let big = EnvOverrides::new().with("BETACLAW_AUTONOMOUS_MAX_TOOL_CALLS", "900");
        assert_eq!(resolve_autonomous_build_max_tool_calls(&big), 500);
        assert_eq!(
            resolve_autonomous_build_max_tool_calls(&EnvOverrides::new()),
            120
        );
    }

    #[test]
    fn code_is_allowed_on_request_or_failure() {
        assert!(should_allow_code_in_response("zeig code bitte", &json!({})));
        assert!(should_allow_code_in_response("hi", &json!({"ok": false})));
        assert!(should_allow_code_in_response(
            "hi",
            &json!({"status": "tool_failed"})
        ));
        assert!(!should_allow_code_in_response(
            "hi",
            &json!({"ok": true, "status": "done"})
        ));
    }

    #[test]
    fn code_blocks_are_replaced_and_blank_runs_collapsed() {
        let text = "Intro\n\n```rs\nfn a() {}\n```\n\n\n\nOutro";
        assert_eq!(
            strip_code_blocks_if_needed(text, false),
            "Intro\n\n[Code weggelassen. Umsetzung wurde im Projekt-Workspace ausgefuehrt.]\n\nOutro"
        );
        assert_eq!(strip_code_blocks_if_needed(text, true), text);
        assert_eq!(strip_code_blocks_if_needed("plain", false), "plain");
    }
}
