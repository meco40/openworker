//! Port of `src/server/channels/messages/service/toolLoopDetector.ts`.
//!
//! Sliding window of the last 30 tool calls per dispatch. Pre-call detection uses the
//! args hash only; post-call detection also uses the result hash. Warnings are added
//! to the tool result, so the model corrects itself.
//!
//! JavaScript truthiness: an empty `resultHash` is falsy (`!entry.resultHash`), but
//! `!== undefined` still counts it as present. Both checks are kept as written.

use serde_json::Value;

use crate::channels::messages::service::utils::js_regex::slice_utf16;

const HISTORY_SIZE: usize = 30;
const WARN_THRESHOLD: usize = 10;
const CRITICAL_THRESHOLD: usize = 20;
const CIRCUIT_BREAKER_THRESHOLD: u32 = 30;

const POLL_BACKOFF_MS: [u64; 4] = [5_000, 10_000, 30_000, 60_000];

/// Tool names that are commonly polled (partial match).
const POLL_TOOL_NAMES: [&str; 4] = ["shell_execute", "file_read", "web_fetch", "http_request"];

/// `ToolCallEntry` (`toolLoopDetector.ts:26-31`). The TypeScript `ts` field is only
/// written, never read, so it is not ported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallEntry {
    pub tool_name: String,
    pub args_hash: String,
    pub result_hash: Option<String>,
}

/// `LoopDetectorState` (`toolLoopDetector.ts:33-36`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoopDetectorState {
    pub history: Vec<ToolCallEntry>,
    pub no_progress_streak: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopLevel {
    None,
    Warning,
    Critical,
}

impl LoopLevel {
    fn as_str(self) -> &'static str {
        match self {
            LoopLevel::None => "none",
            LoopLevel::Warning => "warning",
            LoopLevel::Critical => "critical",
        }
    }
}

/// `LoopDetectionResult` (`toolLoopDetector.ts:40-43`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopDetectionResult {
    pub level: LoopLevel,
    pub message: String,
}

impl LoopDetectionResult {
    fn none() -> Self {
        Self {
            level: LoopLevel::None,
            message: String::new(),
        }
    }
}

/// `createLoopDetectorState()`.
pub fn create_loop_detector_state() -> LoopDetectorState {
    LoopDetectorState::default()
}

/// `buildArgsHash(toolName, args)` (`toolLoopDetector.ts:53-61`). `args || {}`: a
/// JSON `null` serialises as `{}`.
pub fn build_args_hash(tool_name: &str, args: &Value) -> String {
    let serialized = if args.is_null() {
        "{}".to_string()
    } else {
        serde_json::to_string(args).unwrap_or_else(|_| "[unserializable]".to_string())
    };
    format!("{tool_name}:{serialized}")
}

/// `buildResultHash(output)`: the first 2000 UTF-16 units of the output.
pub fn build_result_hash(output: &str) -> String {
    slice_utf16(output, 2000).to_string()
}

/// `recordCall` (`toolLoopDetector.ts:75-80`).
pub fn record_call(state: &mut LoopDetectorState, tool_name: &str, args_hash: &str) {
    state.history.push(ToolCallEntry {
        tool_name: tool_name.to_string(),
        args_hash: args_hash.to_string(),
        result_hash: None,
    });
    if state.history.len() > HISTORY_SIZE {
        let drop = state.history.len() - HISTORY_SIZE;
        state.history.drain(..drop);
    }
}

/// `recordOutcome` (`toolLoopDetector.ts:88-136`).
pub fn record_outcome(
    state: &mut LoopDetectorState,
    tool_name: &str,
    args_hash: &str,
    result_hash: &str,
) {
    // Back-fill the most recent entry that has no result yet (`!entry.resultHash`
    // is true for `None` and for an empty string).
    for entry in state.history.iter_mut().rev() {
        if entry.tool_name == tool_name
            && entry.args_hash == args_hash
            && !is_truthy(&entry.result_hash)
        {
            entry.result_hash = Some(result_hash.to_string());
            break;
        }
    }

    // Find the previous call with the same args after the current one.
    let mut previous_result_hash: Option<String> = None;
    let mut found_current = false;
    for entry in state.history.iter().rev() {
        if !found_current
            && entry.tool_name == tool_name
            && entry.args_hash == args_hash
            && entry.result_hash.as_deref() == Some(result_hash)
        {
            found_current = true;
            continue;
        }
        if found_current
            && entry.tool_name == tool_name
            && entry.args_hash == args_hash
            && is_truthy(&entry.result_hash)
        {
            previous_result_hash = entry.result_hash.clone();
            break;
        }
    }

    if let Some(previous) = previous_result_hash {
        if previous == result_hash {
            state.no_progress_streak += 1;
        } else {
            state.no_progress_streak = 0;
        }
    }
}

fn is_truthy(value: &Option<String>) -> bool {
    matches!(value, Some(text) if !text.is_empty())
}

/// `getPollBackoffMs` (`toolLoopDetector.ts:138-142`).
fn poll_backoff_ms(streak: u32) -> u64 {
    if (streak as usize) < WARN_THRESHOLD {
        return 0;
    }
    let index = ((streak as usize - WARN_THRESHOLD) / 5).min(POLL_BACKOFF_MS.len() - 1);
    POLL_BACKOFF_MS[index]
}

fn is_poll_tool(tool_name: &str) -> bool {
    POLL_TOOL_NAMES.iter().any(|name| tool_name.contains(name))
}

/// `detectLoop` (`toolLoopDetector.ts:153-244`). Checks in order: circuit breaker,
/// poll loop, ping-pong, generic repeat.
pub fn detect_loop(
    state: &LoopDetectorState,
    tool_name: &str,
    args_hash: &str,
) -> LoopDetectionResult {
    let history = &state.history;
    let total_calls = history.len();

    // 1. Global circuit breaker.
    if state.no_progress_streak >= CIRCUIT_BREAKER_THRESHOLD {
        return LoopDetectionResult {
            level: LoopLevel::Critical,
            message: format!(
                "⛔ AGENT STUCK [circuit breaker]: {} aufeinanderfolgende Tool-Calls \
                 ohne neues Ergebnis. Stoppe sofort. Erkläre was du versucht hast, warum es nicht \
                 funktioniert, und frage den User nach dem nächsten Schritt.",
                state.no_progress_streak
            ),
        };
    }

    // 2. Known poll / no-progress.
    if is_poll_tool(tool_name) && total_calls >= WARN_THRESHOLD {
        let recent = &history[total_calls - WARN_THRESHOLD..];
        let same_args_count = recent.iter().filter(|e| e.args_hash == args_hash).count();
        let all_same_result = same_args_count == recent.len()
            && recent
                .iter()
                .all(|e| e.result_hash.is_some() && e.result_hash == recent[0].result_hash);

        if all_same_result && same_args_count >= CRITICAL_THRESHOLD {
            let backoff_ms = poll_backoff_ms(state.no_progress_streak);
            let wait = if backoff_ms > 0 {
                format!("Warte mindestens {}s. ", backoff_ms / 1000)
            } else {
                String::new()
            };
            return LoopDetectionResult {
                level: LoopLevel::Critical,
                message: format!(
                    "⛔ POLL LOOP [critical]: Gleiches Tool \"{tool_name}\" mit gleichem Ergebnis \
                     {same_args_count}+ mal aufgerufen. {wait}\
                     Versuche eine andere Strategie oder warte auf externen Trigger."
                ),
            };
        }

        if all_same_result && same_args_count >= WARN_THRESHOLD {
            let backoff_ms = poll_backoff_ms(state.no_progress_streak);
            let hint = if backoff_ms > 0 {
                format!(
                    "Hint: Warte {}s vor dem nächsten Versuch. ",
                    backoff_ms / 1000
                )
            } else {
                String::new()
            };
            return LoopDetectionResult {
                level: LoopLevel::Warning,
                message: format!(
                    "⚠️ POLL LOOP [warning]: \"{tool_name}\" liefert {same_args_count} mal das gleiche Ergebnis. \
                     {hint}Prüfe ob sich der Systemzustand wirklich ändert oder wähle andere Herangehensweise."
                ),
            };
        }
    }

    // 3. Ping-pong between two patterns without progress.
    if total_calls >= WARN_THRESHOLD {
        let recent = &history[total_calls - WARN_THRESHOLD..];
        let mut unique: Vec<&str> = Vec::new();
        for entry in recent {
            if !unique.contains(&entry.args_hash.as_str()) {
                unique.push(entry.args_hash.as_str());
            }
        }
        if unique.len() == 2 {
            let all_have_results = recent.iter().all(|e| e.result_hash.is_some());
            if all_have_results {
                let results_match = recent
                    .iter()
                    .all(|e| e.result_hash == recent[0].result_hash);
                let level = if total_calls >= CRITICAL_THRESHOLD && results_match {
                    LoopLevel::Critical
                } else {
                    LoopLevel::Warning
                };
                return LoopDetectionResult {
                    level,
                    message: format!(
                        "⚠️ PING-PONG LOOP [{}]: Alterniere zwischen 2 Tool-Mustern ohne Fortschritt \
                         ({} Calls). Wechsle die Strategie grundlegend.",
                        level.as_str(),
                        recent.len()
                    ),
                };
            }
        }
    }

    // 4. Generic repeat: same tool with the same args in the window.
    if total_calls >= WARN_THRESHOLD {
        let same_args_in_window = history[total_calls - WARN_THRESHOLD..]
            .iter()
            .filter(|e| e.tool_name == tool_name && e.args_hash == args_hash)
            .count();
        if same_args_in_window >= WARN_THRESHOLD {
            return LoopDetectionResult {
                level: LoopLevel::Warning,
                message: format!(
                    "⚠️ TOOL REPEAT [warning]: \"{tool_name}\" wurde {same_args_in_window} mal mit gleichen \
                     Argumenten aufgerufen. Versuche andere Parameter oder eine völlig andere Methode."
                ),
            };
        }
    }

    LoopDetectionResult::none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Records a call and its outcome the way `runModelToolLoop` does
    /// (`runModelToolLoop.ts:171-186`): only a critical pre-check aborts, warnings
    /// from the pre-check are ignored, and the post-check result is returned.
    fn run(
        state: &mut LoopDetectorState,
        tool: &str,
        args: &Value,
        output: &str,
    ) -> LoopDetectionResult {
        let hash = build_args_hash(tool, args);
        record_call(state, tool, &hash);
        let pre = detect_loop(state, tool, &hash);
        if pre.level == LoopLevel::Critical {
            return pre;
        }
        record_outcome(state, tool, &hash, &build_result_hash(output));
        detect_loop(state, tool, &hash)
    }

    #[test]
    fn args_hash_is_tool_name_plus_json() {
        assert_eq!(
            build_args_hash("file_read", &json!({"path": "a"})),
            "file_read:{\"path\":\"a\"}"
        );
        assert_eq!(build_args_hash("noop", &Value::Null), "noop:{}");
    }

    #[test]
    fn history_is_capped_at_thirty_entries() {
        let mut state = create_loop_detector_state();
        for index in 0..35 {
            record_call(&mut state, "t", &format!("h{index}"));
        }
        assert_eq!(state.history.len(), HISTORY_SIZE);
        assert_eq!(state.history[0].args_hash, "h5");
    }

    #[test]
    fn repeat_of_the_same_args_warns_at_ten() {
        let mut state = create_loop_detector_state();
        let args = json!({"q": "x"});
        let mut last = LoopDetectionResult::none();
        for index in 0..10 {
            last = run(
                &mut state,
                "web_search",
                &args,
                &format!("different {index}"),
            );
        }
        assert_eq!(last.level, LoopLevel::Warning);
        assert!(last.message.contains("TOOL REPEAT"), "{}", last.message);
    }

    /// The poll branch counts over the 10-entry window, so `sameArgsCount` can never
    /// reach `CRITICAL_THRESHOLD` (20). The TypeScript source has the same gap, and the
    /// port keeps it: identical polls end at the warning, not the critical message.
    #[test]
    fn identical_poll_results_warn_and_never_reach_the_poll_critical_branch() {
        let mut state = create_loop_detector_state();
        let args = json!({"command": "status"});
        let mut last = LoopDetectionResult::none();
        for _ in 0..20 {
            last = run(&mut state, "shell_execute", &args, "same output");
        }
        assert_eq!(last.level, LoopLevel::Warning, "{}", last.message);
        assert!(
            last.message.contains("POLL LOOP [warning]"),
            "{}",
            last.message
        );
        assert!(
            last.message.contains("Warte 10s"),
            "backoff hint: {}",
            last.message
        );
    }

    #[test]
    fn circuit_breaker_stops_after_thirty_no_progress_outcomes() {
        let mut state = create_loop_detector_state();
        state.no_progress_streak = CIRCUIT_BREAKER_THRESHOLD;
        let result = detect_loop(&state, "any", "h");
        assert_eq!(result.level, LoopLevel::Critical);
        assert!(result.message.contains("AGENT STUCK"));
    }

    #[test]
    fn progress_resets_the_streak_and_same_result_grows_it() {
        let mut state = create_loop_detector_state();
        let args = json!({"a": 1});
        run(&mut state, "t", &args, "one");
        run(&mut state, "t", &args, "one");
        assert_eq!(state.no_progress_streak, 1, "a repeated result counts");
        run(&mut state, "t", &args, "two");
        assert_eq!(state.no_progress_streak, 0, "a changed result resets it");
    }

    #[test]
    fn empty_result_hash_is_falsy_for_backfill_only() {
        let mut state = create_loop_detector_state();
        let hash = build_args_hash("t", &json!({}));
        record_call(&mut state, "t", &hash);
        record_outcome(&mut state, "t", &hash, "");
        // An empty result still counts as a result for `!== undefined` checks.
        assert_eq!(state.history[0].result_hash.as_deref(), Some(""));
        // A second outcome back-fills the same entry because "" is falsy.
        record_outcome(&mut state, "t", &hash, "x");
        assert_eq!(state.history[0].result_hash.as_deref(), Some("x"));
    }

    #[test]
    fn result_hash_is_capped_in_utf16_units() {
        let output = "a".repeat(2500);
        assert_eq!(build_result_hash(&output).len(), 2000);
    }
}
