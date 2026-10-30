//! Port of `src/server/skills/handlers/playwrightCliCommand.ts`.
//!
//! Turns the handler arguments into Playwright CLI tokens and enforces the subcommand
//! allow-list. The tokenizer keeps quoted words together and strips their quotes. The
//! allow-list checks only the first token, so the handler quotes the rest.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use super::types::{arg_string, js_string_or_empty, js_trim, SkillError};

/// The allowed first tokens, in the order `[...set].sort()` gives in TypeScript.
const ALLOWED_SUBCOMMANDS: [&str; 12] = [
    "clear-cache",
    "codegen",
    "help",
    "install",
    "install-deps",
    "merge-reports",
    "open",
    "pdf",
    "screenshot",
    "show-report",
    "show-trace",
    "test",
];

/// `resolvePlaywrightCliTokens`: from the `args` array if it has content, otherwise from
/// the tokenised `command` string. Empty input means `--help`.
pub fn resolve_playwright_cli_tokens(args: &Map<String, Value>) -> Vec<String> {
    if let Some(Value::Array(entries)) = args.get("args") {
        let tokens: Vec<String> = entries
            .iter()
            .map(|entry| js_trim(&js_string_or_empty(entry)).to_string())
            .filter(|token| !token.is_empty())
            .collect();
        if !tokens.is_empty() {
            return tokens;
        }
    }

    let command = js_trim(&arg_string(args, "command")).to_string();
    if command.is_empty() {
        return vec!["--help".to_string()];
    }
    let tokens: Vec<String> = token_pattern()
        .find_iter(&command)
        .map(|found| strip_wrapping_quotes(found.as_str()))
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        vec!["--help".to_string()]
    } else {
        tokens
    }
}

/// `assertPlaywrightSubcommandAllowed`. Flags (`-…`) pass; any other first token must be
/// on the allow-list.
pub fn assert_playwright_subcommand_allowed(tokens: &[String]) -> Result<(), SkillError> {
    let first = js_trim(tokens.first().map_or("--help", String::as_str));
    if first.is_empty() || first.starts_with('-') {
        return Ok(());
    }
    if ALLOWED_SUBCOMMANDS.contains(&first) {
        return Ok(());
    }
    Err(SkillError(format!(
        "Unsupported Playwright CLI subcommand \"{first}\". Allowed: {}.",
        ALLOWED_SUBCOMMANDS.join(", ")
    )))
}

/// `buildPlaywrightCliCommand`: the text the policy and the approval check. The tokens are
/// not quoted here, so this is not the text the shell fallback executes.
pub fn build_playwright_cli_command(tokens: &[String]) -> String {
    js_trim(&format!("npx playwright {}", tokens.join(" "))).to_string()
}

/// `stripWrappingQuotes`. A lone quote character becomes the empty string, as `slice(1, -1)`
/// gives in JavaScript.
fn strip_wrapping_quotes(token: &str) -> String {
    let trimmed = js_trim(token);
    let quoted = (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''));
    if quoted {
        trimmed
            .get(1..trimmed.len().saturating_sub(1))
            .unwrap_or("")
            .to_string()
    } else {
        trimmed.to_string()
    }
}

/// `TOKEN_PATTERN`: a double-quoted or single-quoted word (with backslash escapes), or a run
/// of non-whitespace. `\s` and `\S` follow JavaScript, and `.` excludes the same line
/// terminators.
fn token_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(concat!(
            r#""(?:[^"\\]|\\[^\n\r\x{2028}\x{2029}])*""#,
            "|",
            r"'(?:[^'\\]|\\[^\n\r\x{2028}\x{2029}])*'",
            "|",
            r"[^\s\x{FEFF}]+",
        ))
        .expect("static regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn tokenizer_keeps_quoted_words_together_and_strips_the_quotes() {
        let tokens = resolve_playwright_cli_tokens(&args(json!({
            "command": "test --grep \"a b\" 'c d' x"
        })));
        assert_eq!(tokens, ["test", "--grep", "a b", "c d", "x"]);
    }

    #[test]
    fn args_array_wins_and_drops_blank_entries() {
        let tokens = resolve_playwright_cli_tokens(&args(json!({
            "command": "install",
            "args": ["", "show-report", " ", "dir"]
        })));
        assert_eq!(tokens, ["show-report", "dir"]);
    }

    #[test]
    fn empty_input_means_help() {
        assert_eq!(resolve_playwright_cli_tokens(&args(json!({}))), ["--help"]);
        assert_eq!(
            resolve_playwright_cli_tokens(&args(json!({ "command": "   " }))),
            ["--help"]
        );
    }

    #[test]
    fn only_the_first_token_is_checked_against_the_allow_list() {
        assert!(assert_playwright_subcommand_allowed(&["test".into(), "rm".into()]).is_ok());
        assert!(assert_playwright_subcommand_allowed(&["--version".into()]).is_ok());

        let err = assert_playwright_subcommand_allowed(&["eval".into()]).expect_err("not allowed");
        assert_eq!(
            err.0,
            "Unsupported Playwright CLI subcommand \"eval\". Allowed: clear-cache, codegen, \
             help, install, install-deps, merge-reports, open, pdf, screenshot, show-report, \
             show-trace, test."
        );
    }

    #[test]
    fn the_allow_list_is_sorted_as_typescript_renders_it() {
        let mut sorted = ALLOWED_SUBCOMMANDS;
        sorted.sort_unstable();
        assert_eq!(sorted, ALLOWED_SUBCOMMANDS);
    }

    #[test]
    fn command_text_joins_the_tokens_without_quoting() {
        assert_eq!(
            build_playwright_cli_command(&["test".into(), "a b".into()]),
            "npx playwright test a b"
        );
    }
}
