//! Port of `src/server/channels/messages/service/types.ts`.
//!
//! The memory-only helpers that `types.ts` exports are ported here too, because
//! `prepareDispatchStage` and `dispatchModelStage` import them from this file.
//! `process.env` reads take an [`EnvOverrides`] argument, and `process.platform` is
//! passed as `is_windows`, so no function reads the host.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::channels::messages::service::utils::js_regex::{js_regex, slice_utf16};
use crate::memory::types::MemoryFeedbackSignal;
use crate::messages_store::types::{ChannelType, Conversation};
use crate::model_hub::env::EnvOverrides;

pub const MEMORY_CONTEXT_CHAR_LIMIT: usize = 5000;
pub const MEMORY_RECALL_LIMIT: i64 = 10;
pub const MEMORY_FEEDBACK_WINDOW_MS: i64 = 10 * 60 * 1000;
pub const MAX_TOOL_ROUNDS: i64 = 3;
pub const AUTONOMOUS_BUILD_MAX_TOOL_CALLS: i64 = 120;
pub const TOOL_CALLS_HARD_CAP: i64 = 500;
pub const MAX_REPEATED_FAILED_TOOL_CALLS: usize = 4;
pub const TOOL_OUTPUT_MAX_CHARS: usize = 50_000;
pub const TOOL_APPROVAL_TTL_MS: i64 = 30 * 60 * 1000;
pub const SUBAGENT_RECENT_MINUTES: i64 = 60;
pub const SUBAGENT_DEFAULT_AGENT_ID: &str = "worker";
pub const SUBAGENT_MAX_ACTIVE_PER_CONVERSATION: i64 = 5;
pub const SUBAGENT_RESULT_PREVIEW_MAX_CHARS: usize = 1200;
pub const SUBAGENT_ANNOUNCE_MAX_CHARS: usize = 3000;

/// `MODEL_HUB_GATEWAY_PREFIX_RE` (`types.ts:8`): `/^\[model-hub-gateway[^\]]*\]\s*/i`.
pub static MODEL_HUB_GATEWAY_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)^\[model-hub-gateway[^\]]*\]\s*"));

/// `LastRecallState` (`types.ts:21-26`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastRecallState {
    pub persona_id: String,
    pub user_id: String,
    pub node_ids: Vec<String>,
    pub queried_at: i64,
}

/// `ToolExecutionResult` (`types.ts:28-31`).
#[derive(Debug, Clone, PartialEq)]
pub enum ToolExecutionResult {
    Ok {
        output: String,
    },
    Error {
        output: String,
    },
    ApprovalRequired {
        prompt: String,
        pending: Box<PendingToolApproval>,
    },
}

/// `ResolvedToolContext` (`types.ts:33-37`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResolvedToolContext {
    pub tools: Vec<Value>,
    pub installed_function_names: HashSet<String>,
    pub function_to_skill_id: HashMap<String, String>,
}

/// `PendingToolApproval` (`types.ts:39-50`).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingToolApproval {
    pub token: String,
    pub user_id: String,
    pub conversation_id: String,
    pub platform: ChannelType,
    pub external_chat_id: String,
    pub tool_function_name: String,
    pub tool_id: Option<String>,
    pub args: serde_json::Map<String, Value>,
    pub command: Option<String>,
    pub created_at_ms: i64,
}

/// `SubagentAction` (`types.ts:67-75`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentAction {
    List,
    Spawn,
    Kill,
    Steer,
    Log,
    Info,
    Help,
    Profiles,
}

impl SubagentAction {
    pub fn as_str(self) -> &'static str {
        match self {
            SubagentAction::List => "list",
            SubagentAction::Spawn => "spawn",
            SubagentAction::Kill => "kill",
            SubagentAction::Steer => "steer",
            SubagentAction::Log => "log",
            SubagentAction::Info => "info",
            SubagentAction::Help => "help",
            SubagentAction::Profiles => "profiles",
        }
    }

    /// Exact, lower-case match, as in `parseSubagentAction` and the tool call check.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "list" => Some(SubagentAction::List),
            "spawn" => Some(SubagentAction::Spawn),
            "kill" => Some(SubagentAction::Kill),
            "steer" => Some(SubagentAction::Steer),
            "log" => Some(SubagentAction::Log),
            "info" => Some(SubagentAction::Info),
            "help" => Some(SubagentAction::Help),
            "profiles" => Some(SubagentAction::Profiles),
            _ => None,
        }
    }
}

/// `SubagentDispatchContext` (`types.ts:77-81`).
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentDispatchContext {
    pub conversation: Conversation,
    pub platform: ChannelType,
    pub external_chat_id: String,
}

static MEMORY_SAVE_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)^speichere\s+ab\b"));
static GREETING_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)^(ok|okay|danke|thx|merci|hi|hallo|hey|moin|ja|nein|passt|super|top|alles klar|gut)\W*$",
    )
});
static QUESTION_START_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(r"(?i)^(was|wie|wann|wo|wer|warum|wieso|which|what|when|where|who|why)\b")
});
static RULES_CUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)\b(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)\b",
    )
});
static RECALL_CUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)\b(erinner|erinnerst|erinnern|remember|recall|schon mal|damals|frueher|früher|letzte|letzten|gestern|vorgestern|besprochen|gesagt|vereinbart|ausgehandelt|waren wir|haben wir)\b",
    )
});
static DIRECTIVE_RECALL_CUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(r"(?i)\b(nenne|sag|sage|zeige|zeig|liste|list|fass|fasse|summarize|tell)\b")
});
static EXPLICIT_RECALL_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)\b(erinner(?:e)?\s+dich|remember|recall)\b"));
static FEEDBACK_NEGATIVE_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"(?i)\b(falsch|stimmt nicht|nicht korrekt|inkorrekt|wrong|incorrect|not true|das ist nicht richtig)\b",
    )
});
static FEEDBACK_POSITIVE_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(r"(?i)\b(genau|stimmt|korrekt|richtig|exactly|correct|that's right)\b")
});
static CORRECTION_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        js_regex(r"(?i)\bsondern\s+(.+)$"),
        js_regex(r"(?i)\b(richtig ist|korrekt ist|eigentlich)\s+(.+)$"),
        js_regex(r"(?i)\bfalsch\b\s*[,.:;-]\s*(.+)$"),
        js_regex(r"(?i)^\s*(falsch|nein)\s*[,.:;-]?\s*(.+)$"),
    ]
});
static ASKS_FILE_COUNT_WIE_VIELE_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\bwie viele\b"));
static ASKS_FILE_COUNT_DATEI_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\bdatei(?:en)?\b"));
static ASKS_FILE_COUNT_HOW_MANY_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\bhow many\b"));
static ASKS_FILE_COUNT_FILES_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\bfiles?\b"));
static DESKTOP_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"\bdesktop\b"));

/// `extractMemorySaveContent` (`types.ts:84-100`). `None` when the prefix is absent,
/// `Some("")` when the prefix has no payload.
pub fn extract_memory_save_content(content: &str) -> Option<String> {
    let trimmed = content.trim();
    let prefix = MEMORY_SAVE_PREFIX_RE.find(trimmed)?;
    let mut remainder = trimmed[prefix.end()..].trim_start();
    if let Some(first) = remainder.chars().next() {
        if matches!(first, ':' | '-' | '\u{2013}' | '\u{2014}') {
            remainder = remainder[first.len_utf8()..].trim_start();
        }
    }
    Some(remainder.trim().to_string())
}

/// `shouldRecallMemoryForInput` (`types.ts:102-140`).
pub fn should_recall_memory_for_input(content: &str) -> bool {
    let normalized = content.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    if extract_memory_save_content(&normalized).is_some() {
        return false;
    }

    if GREETING_RE.is_match(&normalized) {
        return false;
    }

    let token_count = normalized.split_whitespace().count();
    if token_count <= 2 && !normalized.contains('?') {
        return false;
    }

    let has_question_signal = normalized.contains('?') || QUESTION_START_RE.is_match(&normalized);
    let has_rules_cue = RULES_CUE_RE.is_match(&normalized);
    let has_recall_cue = RECALL_CUE_RE.is_match(&normalized);
    let has_explicit_recall_command = is_explicit_recall_command(&normalized);
    let has_directive_recall_cue = DIRECTIVE_RECALL_CUE_RE.is_match(&normalized);

    if has_explicit_recall_command {
        return true;
    }
    if has_rules_cue && (has_question_signal || has_directive_recall_cue) {
        return true;
    }
    if has_question_signal && has_recall_cue {
        return true;
    }
    if has_directive_recall_cue && has_recall_cue {
        return true;
    }
    false
}

/// `isExplicitRecallCommand` (`types.ts:142-146`).
pub fn is_explicit_recall_command(content: &str) -> bool {
    let normalized = content.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    EXPLICIT_RECALL_RE.is_match(&normalized)
}

/// `isStrictEvidenceRecallEnabled(env)` (`types.ts:148-156`).
pub fn is_strict_evidence_recall_enabled(env: &EnvOverrides) -> bool {
    let normalized = env
        .get("RECALL_STRICT_EVIDENCE")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
}

/// `normalizeMemoryContext` (`types.ts:158-163`). The limit counts UTF-16 units.
pub fn normalize_memory_context(context: &str) -> Option<String> {
    let trimmed = context.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.to_lowercase() == "no relevant memories found." {
        return None;
    }
    Some(slice_utf16(trimmed, MEMORY_CONTEXT_CHAR_LIMIT).to_string())
}

/// `detectMemoryFeedbackSignal` (`types.ts:165-182`).
pub fn detect_memory_feedback_signal(content: &str) -> Option<MemoryFeedbackSignal> {
    let normalized = content.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if FEEDBACK_NEGATIVE_RE.is_match(&normalized) {
        return Some(MemoryFeedbackSignal::Negative);
    }
    if FEEDBACK_POSITIVE_RE.is_match(&normalized) {
        return Some(MemoryFeedbackSignal::Positive);
    }
    None
}

/// `extractCorrectionContent` (`types.ts:184-204`). Candidates shorter than eight
/// UTF-16 units are skipped and the next pattern is tried.
pub fn extract_correction_content(content: &str) -> Option<String> {
    let normalized = collapse_whitespace(content);
    let normalized = normalized.trim();
    if normalized.is_empty() {
        return None;
    }

    for pattern in CORRECTION_PATTERNS.iter() {
        let Some(captures) = pattern.captures(normalized) else {
            continue;
        };
        // `(match[2] || match[1] || '').trim()`: the last capture group that exists.
        let raw = captures
            .get(2)
            .or_else(|| captures.get(1))
            .map(|m| m.as_str())
            .unwrap_or("");
        let candidate = raw.trim();
        if crate::channels::messages::service::utils::js_regex::utf16_len(candidate) < 8 {
            continue;
        }
        return Some(candidate.to_string());
    }
    None
}

/// `s.replace(/\s+/g, ' ')`.
fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `inferShellCommandFromNaturalLanguage` (`types.ts:206-223`). `is_windows` replaces
/// `process.platform === 'win32'`.
pub fn infer_shell_command_from_natural_language(
    content: &str,
    is_windows: bool,
) -> Option<String> {
    let normalized = content.trim().to_lowercase();
    if normalized.is_empty() {
        return None;
    }

    let asks_file_count = ((ASKS_FILE_COUNT_WIE_VIELE_RE.is_match(&normalized)
        && ASKS_FILE_COUNT_DATEI_RE.is_match(&normalized))
        || (ASKS_FILE_COUNT_HOW_MANY_RE.is_match(&normalized)
            && ASKS_FILE_COUNT_FILES_RE.is_match(&normalized)))
        && DESKTOP_RE.is_match(&normalized);

    if asks_file_count {
        if is_windows {
            return Some("$desktop=[Environment]::GetFolderPath('Desktop'); (Get-ChildItem -LiteralPath $desktop -Force -File | Measure-Object).Count".to_string());
        }
        return Some(
            r#"if [ -d "$HOME/Desktop" ]; then find "$HOME/Desktop" -maxdepth 1 -type f | wc -l; else echo 0; fi"#
                .to_string(),
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_hub::env::EnvOverrides;

    #[test]
    fn memory_save_prefix_strips_the_separator() {
        assert_eq!(
            extract_memory_save_content("Speichere ab: Ich mag Tee"),
            Some("Ich mag Tee".to_string())
        );
        assert_eq!(
            extract_memory_save_content("speichere ab \u{2014} Sonne"),
            Some("Sonne".to_string())
        );
        assert_eq!(extract_memory_save_content("speichere abends"), None);
        assert_eq!(
            extract_memory_save_content("speichere ab"),
            Some(String::new())
        );
    }

    #[test]
    fn greetings_and_short_turns_skip_recall() {
        assert!(!should_recall_memory_for_input("danke!"));
        assert!(!should_recall_memory_for_input("ok"));
        assert!(!should_recall_memory_for_input("Speichere ab: etwas"));
    }

    #[test]
    fn question_with_recall_cue_triggers_recall() {
        assert!(should_recall_memory_for_input(
            "Was haben wir gestern besprochen?"
        ));
        assert!(should_recall_memory_for_input(
            "erinnere dich bitte an den Plan"
        ));
        // A plain statement with no question and no cue does not.
        assert!(!should_recall_memory_for_input(
            "Der Bus fuhr heute pünktlich los"
        ));
    }

    #[test]
    fn rules_cue_needs_a_question_or_directive() {
        assert!(should_recall_memory_for_input("Welche Regeln gelten hier?"));
        assert!(should_recall_memory_for_input(
            "nenne mir die regeln fuer das projekt"
        ));
        assert!(!should_recall_memory_for_input(
            "die regeln sind eindeutig und gut"
        ));
    }

    #[test]
    fn explicit_recall_command_is_detected() {
        assert!(is_explicit_recall_command("Erinnere dich an X"));
        assert!(is_explicit_recall_command("please recall the plan"));
        assert!(!is_explicit_recall_command("   "));
    }

    #[test]
    fn strict_evidence_flag_accepts_only_the_listed_values() {
        let on = EnvOverrides::new().with("RECALL_STRICT_EVIDENCE", " YES ");
        assert!(is_strict_evidence_recall_enabled(&on));
        let off = EnvOverrides::new().with("RECALL_STRICT_EVIDENCE", "2");
        assert!(!is_strict_evidence_recall_enabled(&off));
        assert!(!is_strict_evidence_recall_enabled(&EnvOverrides::new()));
    }

    #[test]
    fn memory_context_is_trimmed_and_capped() {
        assert_eq!(normalize_memory_context("   "), None);
        assert_eq!(
            normalize_memory_context("No relevant memories found."),
            None
        );
        let long = "a".repeat(MEMORY_CONTEXT_CHAR_LIMIT + 10);
        assert_eq!(
            normalize_memory_context(&long).expect("kept").len(),
            MEMORY_CONTEXT_CHAR_LIMIT
        );
    }

    #[test]
    fn feedback_signal_prefers_negative() {
        assert_eq!(
            detect_memory_feedback_signal("Das ist falsch"),
            Some(MemoryFeedbackSignal::Negative)
        );
        assert_eq!(
            detect_memory_feedback_signal("Genau so ist es"),
            Some(MemoryFeedbackSignal::Positive)
        );
        assert_eq!(detect_memory_feedback_signal("hallo"), None);
    }

    #[test]
    fn correction_takes_the_candidate_after_the_cue() {
        // Pattern 2 captures everything after the cue, including "ist".
        assert_eq!(
            extract_correction_content("Nein, eigentlich ist es Berlin"),
            Some("ist es Berlin".to_string())
        );
        // Shorter than eight units: no correction.
        assert_eq!(extract_correction_content("falsch, ja"), None);
    }

    #[test]
    fn shell_inference_is_platform_specific() {
        let win = infer_shell_command_from_natural_language(
            "Wie viele Dateien liegen auf dem Desktop?",
            true,
        )
        .expect("inferred");
        assert!(win.starts_with("$desktop=[Environment]::GetFolderPath('Desktop')"));
        let posix =
            infer_shell_command_from_natural_language("How many files are on my desktop", false)
                .expect("inferred");
        assert!(posix.contains("wc -l"));
        assert_eq!(
            infer_shell_command_from_natural_language("Wie viele Dateien gibt es?", false),
            None
        );
    }

    #[test]
    fn recall_helpers_keep_the_sondern_pattern_and_the_sentinel() {
        assert_eq!(
            extract_correction_content("Nein, sondern Dienstag"),
            Some("Dienstag".to_string())
        );
        assert_eq!(
            extract_correction_content("falsch, der Termin ist morgen"),
            Some("der Termin ist morgen".to_string())
        );
        assert_eq!(extract_correction_content("falsch, ja"), None);
        assert!(is_explicit_recall_command("Erinnere dich bitte"));
        assert!(!is_explicit_recall_command("   "));
        assert!(should_recall_memory_for_input(
            "Erinnere dich an meinen Plan"
        ));
        assert!(!should_recall_memory_for_input("Yoga morgen"));
        assert!(!should_recall_memory_for_input("speichere ab: Milch"));
        assert_eq!(detect_memory_feedback_signal("vielleicht"), None);
        assert_eq!(normalize_memory_context("  "), None);
        assert_eq!(
            normalize_memory_context("No relevant memories found."),
            None
        );
        let long = "x".repeat(MEMORY_CONTEXT_CHAR_LIMIT + 10);
        assert_eq!(
            normalize_memory_context(&long).map(|text| text.len()),
            Some(MEMORY_CONTEXT_CHAR_LIMIT)
        );
    }
}
