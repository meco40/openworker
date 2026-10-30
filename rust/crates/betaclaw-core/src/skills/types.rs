//! Shared types of the S11 skill handlers.
//!
//! Mirrors `src/server/skills/types.ts`, reduced to the fields the ported handlers
//! read, and the environment reads the TypeScript handlers perform at call time
//! (`BETACLAW_*`, `PLAYWRIGHT_CLI_PATH`). The environment is read once by
//! [`SkillExecConfig::from_env`]; handlers receive the values as data, so tests never
//! mutate process-wide state.
//!
//! Not ported here: `enforceSkillActivation`, `conversationId`, `userId`, `platform`,
//! `externalChatId` and `invokeSubagentToolCall`. They belong to the dispatcher
//! (`executeSkill.ts`, not ported) and to the subagent slice (S8).
//!
//! The `js_*` helpers reproduce the JavaScript coercions the handlers rely on
//! (`String(x || '')`, `Number(x ?? d)`, `String.prototype.trim`), so inputs the LLM
//! sends in unexpected shapes behave as they do in TypeScript.

use std::env;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::{Map, Value};

use super::exec_approval::ExecApprovalStore;
use crate::personas::workspace::PersonaWorkspace;

/// Locks a std mutex, ignoring poisoning. The guarded values are plain buffers and
/// status fields, and a panicking reader leaves them consistent.
pub(crate) fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The fields of `SkillDispatchContext` that the ported handlers read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SkillDispatchContext {
    pub bypass_approval: bool,
    pub workspace_cwd: Option<String>,
}

/// A failure the TypeScript handler reports by throwing `new Error(message)`.
///
/// The message is user-facing and carries no secret values.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SkillError(pub String);

/// Exec limits and switches read from the environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillExecConfig {
    /// `BETACLAW_EXEC_APPROVALS_REQUIRED`, compared case-insensitively to `"true"`.
    pub approvals_required: bool,
    /// `BETACLAW_SHELL_TIMEOUT_MS`, clamped to 5 s ..= 2 h, default 10 min.
    pub shell_timeout: Duration,
    /// `BETACLAW_SHELL_MAX_BUFFER_BYTES`, clamped to 1 MB ..= 100 MB, default 10 MB.
    pub shell_max_buffer: usize,
    /// `PLAYWRIGHT_CLI_PATH`, trimmed; `None` when unset or blank.
    pub playwright_cli_path: Option<String>,
}

const SHELL_TIMEOUT_DEFAULT_MS: i128 = 10 * 60 * 1000;
const SHELL_TIMEOUT_MIN_MS: i128 = 5_000;
const SHELL_TIMEOUT_MAX_MS: i128 = 2 * 60 * 60 * 1000;
const SHELL_MAX_BUFFER_DEFAULT: i128 = 10_000_000;
const SHELL_MAX_BUFFER_MIN: i128 = 1_000_000;
const SHELL_MAX_BUFFER_MAX: i128 = 100_000_000;

impl SkillExecConfig {
    /// Reads the environment once. Process-wide, so call it at startup only.
    pub fn from_env() -> Self {
        Self::from_raw(
            env::var("BETACLAW_EXEC_APPROVALS_REQUIRED").ok().as_deref(),
            env::var("BETACLAW_SHELL_TIMEOUT_MS").ok().as_deref(),
            env::var("BETACLAW_SHELL_MAX_BUFFER_BYTES").ok().as_deref(),
            env::var("PLAYWRIGHT_CLI_PATH").ok().as_deref(),
        )
    }

    /// Builds the config from raw variable values, as `from_env` reads them.
    pub fn from_raw(
        approvals_required: Option<&str>,
        shell_timeout_ms: Option<&str>,
        shell_max_buffer: Option<&str>,
        playwright_cli_path: Option<&str>,
    ) -> Self {
        let timeout = parse_int_prefix(shell_timeout_ms.unwrap_or(""))
            .unwrap_or(SHELL_TIMEOUT_DEFAULT_MS)
            .clamp(SHELL_TIMEOUT_MIN_MS, SHELL_TIMEOUT_MAX_MS);
        let max_buffer = parse_int_prefix(shell_max_buffer.unwrap_or(""))
            .unwrap_or(SHELL_MAX_BUFFER_DEFAULT)
            .clamp(SHELL_MAX_BUFFER_MIN, SHELL_MAX_BUFFER_MAX);
        Self {
            approvals_required: approvals_required.unwrap_or("").to_lowercase() == "true",
            shell_timeout: Duration::from_millis(timeout as u64),
            shell_max_buffer: max_buffer as usize,
            playwright_cli_path: playwright_cli_path
                .map(js_trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string),
        }
    }
}

/// Everything a handler depends on besides its arguments and dispatch context.
///
/// The coordinator builds one of these at startup. The process manager is not part of
/// it: it owns mutable state of its own.
#[derive(Debug, Clone)]
pub struct SkillEnv {
    pub personas: PersonaWorkspace,
    pub approvals: ExecApprovalStore,
    pub exec: SkillExecConfig,
}

/// `parseInt(text, 10)`: optional leading whitespace and sign, then digits. Trailing
/// text is ignored. Returns `None` where JavaScript yields `NaN`.
fn parse_int_prefix(text: &str) -> Option<i128> {
    let trimmed = text.trim_start_matches(is_js_space);
    let (sign, rest) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    // Saturates on overflow, as the clamp that follows does in TypeScript.
    let value = digits.parse::<i128>().unwrap_or(i128::MAX);
    Some(sign * value)
}

/// The characters JavaScript's `\s` and `String.prototype.trim` treat as whitespace.
///
/// Rust's `char::is_whitespace` differs in two places: it accepts U+0085 and not
/// U+FEFF. This predicate follows JavaScript.
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `String(value)`.
pub fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        // `Array.prototype.toString` joins with "," and renders null as "".
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_to_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `Number(value)`. Arrays and objects yield `NaN`; JavaScript would coerce a one-element
/// array, which no handler relies on.
pub fn js_to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => {
            let trimmed = js_trim(text);
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

fn js_number_to_string(number: f64) -> String {
    if number.is_nan() {
        "NaN".to_string()
    } else if number.is_infinite() {
        String::from(if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        })
    } else if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{}", number as i128)
    } else {
        format!("{number}")
    }
}

/// `String(value || '')`: a falsy value becomes the empty string.
pub fn js_string_or_empty(value: &Value) -> String {
    if is_falsy(value) {
        String::new()
    } else {
        js_to_string(value)
    }
}

/// `String(args[key] || '')`.
pub fn arg_string(args: &Map<String, Value>, key: &str) -> String {
    args.get(key).map(js_string_or_empty).unwrap_or_default()
}

/// `String(args[key] ?? '')`: only a missing key or null becomes the empty string.
pub fn arg_text(args: &Map<String, Value>, key: &str) -> String {
    match args.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_to_string(value),
    }
}

/// `Number(args[key] ?? fallback)`.
pub fn arg_number(args: &Map<String, Value>, key: &str, fallback: f64) -> f64 {
    match args.get(key) {
        None | Some(Value::Null) => fallback,
        Some(value) => js_to_number(value),
    }
}

fn is_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(number) => number.as_f64().is_none_or(|n| n == 0.0 || n.is_nan()),
        Value::String(text) => text.is_empty(),
        Value::Array(_) | Value::Object(_) => false,
    }
}

/// Scratch directories and handler environments for the skill tests.
#[cfg(test)]
pub(crate) mod test_support {
    use std::fs;
    use std::path::PathBuf;

    use super::super::exec_approval::ExecApprovalStore;
    use super::{SkillEnv, SkillExecConfig};
    use crate::personas::workspace::PersonaWorkspace;

    /// A unique directory under the system temp dir, removed on drop.
    pub(crate) struct TempDir(pub PathBuf);

    impl TempDir {
        pub(crate) fn new() -> Self {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let path = std::env::temp_dir().join(format!("betaclaw-skills-{unique}"));
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        /// Personas under `<dir>/personas`, approvals under `<dir>/.local`.
        pub(crate) fn env(&self, approvals_required: bool) -> SkillEnv {
            SkillEnv {
                personas: PersonaWorkspace::new(self.0.join("personas")),
                approvals: ExecApprovalStore::new(
                    self.0.join(".local").join("exec-approvals.json"),
                ),
                exec: SkillExecConfig::from_raw(
                    Some(if approvals_required { "true" } else { "false" }),
                    None,
                    None,
                    None,
                ),
            }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exec_config_defaults_and_clamps_match_the_env_parsers() {
        let defaults = SkillExecConfig::from_raw(None, None, None, None);
        assert!(!defaults.approvals_required);
        assert_eq!(defaults.shell_timeout, Duration::from_millis(600_000));
        assert_eq!(defaults.shell_max_buffer, 10_000_000);
        assert_eq!(defaults.playwright_cli_path, None);

        let clamped =
            SkillExecConfig::from_raw(Some("TRUE"), Some("1"), Some("999999999999"), Some("  "));
        assert!(clamped.approvals_required);
        assert_eq!(clamped.shell_timeout, Duration::from_millis(5_000));
        assert_eq!(clamped.shell_max_buffer, 100_000_000);
        assert_eq!(clamped.playwright_cli_path, None, "blank path is unset");

        let parsed =
            SkillExecConfig::from_raw(Some(" true"), Some("30000ms"), None, Some(" /x/cli.js "));
        assert!(!parsed.approvals_required, "no trimming, as in TypeScript");
        assert_eq!(parsed.shell_timeout, Duration::from_millis(30_000));
        assert_eq!(parsed.playwright_cli_path.as_deref(), Some("/x/cli.js"));
    }

    #[test]
    fn js_string_coercions_follow_javascript() {
        let args = json!({ "zero": 0, "text": "ls", "list": ["a", null, "b"], "flag": true })
            .as_object()
            .cloned()
            .unwrap_or_default();
        assert_eq!(arg_string(&args, "missing"), "");
        assert_eq!(
            arg_string(&args, "zero"),
            "",
            "0 is falsy, so String(0 || '') is ''"
        );
        assert_eq!(arg_string(&args, "text"), "ls");
        assert_eq!(arg_string(&args, "list"), "a,,b");
        assert_eq!(arg_string(&args, "flag"), "true");
        assert_eq!(js_trim("\u{feff} echo \u{a0}"), "echo");
    }

    #[test]
    fn js_number_coercions_follow_javascript() {
        let args = json!({ "text": " 42 ", "blank": "", "bad": "abc", "nothing": null })
            .as_object()
            .cloned()
            .unwrap_or_default();
        assert_eq!(arg_number(&args, "text", 7.0), 42.0);
        assert_eq!(arg_number(&args, "blank", 7.0), 0.0);
        assert!(arg_number(&args, "bad", 7.0).is_nan());
        assert_eq!(
            arg_number(&args, "nothing", 7.0),
            7.0,
            "?? falls back on null"
        );
        assert_eq!(arg_number(&args, "absent", 7.0), 7.0);
    }
}
