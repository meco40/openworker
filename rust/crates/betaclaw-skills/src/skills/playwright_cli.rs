//! Port of `src/server/skills/handlers/playwrightCli.ts`.
//!
//! Runs the Playwright CLI. A local CLI (`node_modules/playwright/cli.js`, or the path in
//! `PLAYWRIGHT_CLI_PATH`) runs directly under `node`. Without one, the command goes through
//! the platform shell as `npx playwright …`.
//!
//! Deviation: TypeScript runs the local CLI under `process.execPath`. This port runs `node`
//! from PATH, because the crate does not know which Node binary the gateway was started
//! with.
//!
//! Security: on the shell fallback, each token is quoted, and the subcommand allow-list
//! covers only the first token. On Windows, PowerShell also treats the typographic single
//! quotes U+2018, U+2019, U+201A and U+201B as string delimiters. A token containing one
//! could end the quoted string and run extra code. TypeScript quotes only ASCII `'`. This
//! port refuses such tokens on the shell path. The local-CLI path never uses a shell, so it
//! is not affected.

use std::env;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::capped_exec::{command_line, run_capped};
use super::exec_approval::enforce_exec_approval;
use super::execution_cwd::{lexical_resolve, resolve_skill_execution_cwd};
use super::node_command_policy::evaluate_node_command_policy;
use super::playwright_cli_command::{
    assert_playwright_subcommand_allowed, build_playwright_cli_command,
    resolve_playwright_cli_tokens,
};
use super::types::{SkillDispatchContext, SkillEnv, SkillError};

/// Typographic single quotes that PowerShell accepts as string delimiters.
const POWERSHELL_SINGLE_QUOTES: [char; 5] = ['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];

/// `{ command, cwd, stdout, stderr, exitCode, signal? }` as returned by the handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaywrightResult {
    pub command: String,
    pub cwd: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    /// Set only for a failed run that was killed by a signal.
    pub signal: Option<String>,
}

/// `playwrightCliHandler`. A workspace or invocation failure throws, as in TypeScript.
/// Only a failed run is reported as a result.
pub async fn playwright_cli(
    args: &Map<String, Value>,
    ctx: &SkillDispatchContext,
    env: &SkillEnv,
) -> Result<PlaywrightResult, SkillError> {
    let tokens = resolve_playwright_cli_tokens(args);
    assert_playwright_subcommand_allowed(&tokens)?;
    let command = build_playwright_cli_command(&tokens);

    let policy = evaluate_node_command_policy(&command);
    if !policy.allowed {
        return Err(SkillError(policy.reason.unwrap_or_default().to_string()));
    }
    enforce_exec_approval(env, ctx, &command, true)?;

    let cwd = resolve_skill_execution_cwd(&env.personas, ctx)?;
    let process_cwd =
        env::current_dir().map_err(|error| SkillError(crate::safe_error_message(&error)))?;
    let (program, argv) = resolve_playwright_invocation(
        &tokens,
        env.exec.playwright_cli_path.as_deref(),
        &process_cwd,
        cfg!(windows),
    )?;

    let run = run_capped(
        &program,
        &argv,
        &cwd,
        env.exec.shell_timeout,
        env.exec.shell_max_buffer,
    )
    .await;
    let cwd_text = cwd.to_string_lossy().into_owned();
    if run.is_success() {
        return Ok(PlaywrightResult {
            command,
            cwd: cwd_text,
            stdout: run.stdout,
            stderr: run.stderr,
            exit_code: 0,
            signal: None,
        });
    }
    let stderr = if run.stderr.is_empty() {
        run.error_text(&command_line(&program, &argv))
    } else {
        run.stderr
    };
    Ok(PlaywrightResult {
        command,
        cwd: cwd_text,
        stdout: run.stdout,
        stderr,
        exit_code: run.exit_code.unwrap_or(1),
        signal: run.signal,
    })
}

/// `resolvePlaywrightInvocation`: the program and its arguments.
///
/// `process_cwd` stands in for `process.cwd()`, which the local CLI path is resolved
/// against. `windows` selects the shell fallback's quoting and shell.
pub(crate) fn resolve_playwright_invocation(
    tokens: &[String],
    configured_cli: Option<&str>,
    process_cwd: &Path,
    windows: bool,
) -> Result<(String, Vec<String>), SkillError> {
    let cli_path: PathBuf = match configured_cli {
        Some(path) => lexical_resolve(Path::new(path)),
        None => lexical_resolve(&process_cwd.join("node_modules/playwright/cli.js")),
    };
    if cli_path.exists() {
        let mut argv = vec![cli_path.to_string_lossy().into_owned()];
        argv.extend(tokens.iter().cloned());
        return Ok(("node".to_string(), argv));
    }

    let command = shell_fallback_command(tokens, windows)?;
    if windows {
        Ok((
            "powershell".to_string(),
            vec!["-NoProfile".into(), "-Command".into(), command],
        ))
    } else {
        Ok(("/bin/sh".to_string(), vec!["-lc".into(), command]))
    }
}

/// `buildShellCommand`: `npx playwright` followed by every token quoted for the platform.
fn shell_fallback_command(tokens: &[String], windows: bool) -> Result<String, SkillError> {
    if windows
        && tokens
            .iter()
            .any(|token| token.chars().any(|c| POWERSHELL_SINGLE_QUOTES.contains(&c)))
    {
        return Err(SkillError(
            "Playwright CLI argument contains a quote character that PowerShell treats as a string delimiter."
                .to_string(),
        ));
    }
    let quoted: Vec<String> = tokens
        .iter()
        .map(|token| quote_token(token, windows))
        .collect();
    Ok(format!("npx playwright {}", quoted.join(" ")))
}

/// `quoteToken`: single quotes, with an embedded quote written as `''` (PowerShell) or
/// `'"'"'` (POSIX shells).
fn quote_token(token: &str, windows: bool) -> String {
    if token.is_empty() {
        return "''".to_string();
    }
    if windows {
        format!("'{}'", token.replace('\'', "''"))
    } else {
        format!("'{}'", token.replace('\'', "'\"'\"'"))
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::test_support::TempDir;
    use super::*;
    use serde_json::json;

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn posix_quoting_survives_an_embedded_single_quote() {
        assert_eq!(quote_token("a'b", false), "'a'\"'\"'b'");
        assert_eq!(quote_token("", false), "''");
        assert_eq!(quote_token("x y", false), "'x y'");
    }

    #[test]
    fn powershell_quoting_doubles_the_ascii_quote() {
        assert_eq!(quote_token("it's", true), "'it''s'");
    }

    #[test]
    fn powershell_smart_quotes_are_refused_on_the_shell_path() {
        let tokens = ["test".to_string(), "x\u{2019}; calc".to_string()];
        let err = shell_fallback_command(&tokens, true).expect_err("refused");
        assert!(err.0.contains("PowerShell treats as a string delimiter"));
        assert!(
            shell_fallback_command(&tokens, false).is_ok(),
            "POSIX quoting is safe"
        );
    }

    #[test]
    fn local_cli_runs_under_node_and_missing_cli_falls_back_to_the_shell() {
        let dir = TempDir::new();
        let tokens = ["test".to_string(), "a'b".to_string()];

        let (program, argv) =
            resolve_playwright_invocation(&tokens, None, &dir.0, false).expect("fallback");
        assert_eq!(program, "/bin/sh");
        assert_eq!(argv, ["-lc", "npx playwright 'test' 'a'\"'\"'b'"]);

        let cli = dir.0.join("node_modules/playwright/cli.js");
        std::fs::create_dir_all(cli.parent().expect("parent")).expect("dirs");
        std::fs::write(&cli, "").expect("cli");
        let (program, argv) =
            resolve_playwright_invocation(&tokens, None, &dir.0, false).expect("local");
        assert_eq!(program, "node");
        assert_eq!(argv[0], lexical_resolve(&cli).to_string_lossy());
        assert_eq!(&argv[1..], ["test", "a'b"]);
    }

    #[tokio::test]
    async fn unsupported_subcommands_and_blocked_text_are_thrown_before_running() {
        let dir = TempDir::new();
        let env = dir.env(false);
        let ctx = SkillDispatchContext::default();

        let err = playwright_cli(&args(json!({ "command": "eval 1" })), &ctx, &env)
            .await
            .expect_err("subcommand");
        assert!(err
            .0
            .starts_with("Unsupported Playwright CLI subcommand \"eval\""));

        let err = playwright_cli(&args(json!({ "command": "test rm -rf x" })), &ctx, &env)
            .await
            .expect_err("blocked");
        assert_eq!(err.0, "Command blocked by security policy.");
    }
}
