//! Port of `src/server/skills/handlers/shellExecute.ts`.
//!
//! Runs a policy-checked command through the platform shell (PowerShell on Windows,
//! `/bin/sh -lc` elsewhere) in the resolved workspace directory.
//!
//! Errors split as in TypeScript. An empty command, a policy block and a missing approval
//! are returned as `Err`, which the TypeScript handler throws. Everything after the
//! approval gate, including a workspace path that does not resolve, comes back as `Ok`
//! with `exit_code` and `stderr` set.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};
use tokio::fs;

use super::capped_exec::{command_line, run_capped};
use super::exec_approval::enforce_exec_approval;
use super::execution_cwd::resolve_skill_execution_cwd;
use super::node_command_policy::evaluate_node_command_policy;
use super::types::{arg_string, js_trim, SkillDispatchContext, SkillEnv, SkillError};

const TIMEOUT_EXIT_CODE: i32 = 124;
const TIMED_OUT_MESSAGE: &str = "Command timed out during shell execution.";

/// `{ stdout, stderr, exitCode }` as returned by the TypeScript handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// `shellExecuteHandler`.
pub async fn shell_execute(
    args: &Map<String, Value>,
    ctx: &SkillDispatchContext,
    env: &SkillEnv,
) -> Result<ShellOutput, SkillError> {
    let command = js_trim(&arg_string(args, "command")).to_string();
    if command.is_empty() {
        return Err(SkillError("shell_execute requires command.".to_string()));
    }
    let policy = evaluate_node_command_policy(&command);
    if !policy.allowed {
        return Err(SkillError(policy.reason.unwrap_or_default().to_string()));
    }
    enforce_exec_approval(env, ctx, &command, true)?;

    let cwd = match resolve_skill_execution_cwd(&env.personas, ctx) {
        Ok(cwd) => cwd,
        Err(SkillError(message)) => {
            return Ok(shell_failure(
                String::new(),
                "",
                format!("Error: {message}"),
                None,
                false,
            ));
        }
    };

    let (program, argv) = shell_invocation(&command);
    let run = run_capped(
        program,
        &argv,
        &cwd,
        env.exec.shell_timeout,
        env.exec.shell_max_buffer,
    )
    .await;
    if run.is_success() {
        let stderr = match shell_bleed_warning(&command, &cwd).await {
            Some(warning) => js_trim(&format!("{warning}\n{}", run.stderr)).to_string(),
            None => run.stderr,
        };
        return Ok(ShellOutput {
            stdout: run.stdout,
            stderr,
            exit_code: 0,
        });
    }
    let error_text = run.error_text(&command_line(program, &argv));
    Ok(shell_failure(
        run.stdout,
        &run.stderr,
        error_text,
        run.exit_code,
        run.killed,
    ))
}

/// The catch branch of the TypeScript handler.
///
/// The timeout check reads `stderr || error` for the word "timeout", as the TypeScript
/// regex does. A killed run counts as timed out. An exit code wins over the timeout
/// guess, and the timeout guess only applies when there is no exit code.
fn shell_failure(
    stdout: String,
    stderr: &str,
    error_text: String,
    exit_code: Option<i32>,
    killed: bool,
) -> ShellOutput {
    let detail = if stderr.is_empty() {
        error_text.as_str()
    } else {
        stderr
    };
    let timed_out = killed || timeout_pattern().is_match(detail);
    let stderr = if !stderr.is_empty() {
        stderr.to_string()
    } else if timed_out {
        TIMED_OUT_MESSAGE.to_string()
    } else {
        error_text
    };
    ShellOutput {
        stdout,
        stderr,
        exit_code: exit_code.unwrap_or(if timed_out { TIMEOUT_EXIT_CODE } else { 1 }),
    }
}

/// `resolveShell`.
pub(crate) fn shell_invocation(command: &str) -> (&'static str, Vec<String>) {
    if cfg!(windows) {
        (
            "powershell",
            vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ],
        )
    } else {
        // /bin/sh for broad Linux and container compatibility, as in TypeScript.
        ("/bin/sh", vec!["-lc".to_string(), command.to_string()])
    }
}

/// `warnIfShellBleed`. Advisory only: it returns a warning when a python or node script
/// named by the command contains `$VAR`-style text, and never fails.
async fn shell_bleed_warning(command: &str, cwd: &Path) -> Option<String> {
    let script = script_pattern().captures(command)?.get(1)?.as_str();
    let script_path: PathBuf = if Path::new(script).is_absolute() {
        PathBuf::from(script)
    } else {
        cwd.join(script)
    };
    let bytes = fs::read(&script_path).await.ok()?;
    let content = String::from_utf8_lossy(&bytes);

    let mut unique: Vec<&str> = Vec::new();
    for found in env_var_pattern().find_iter(&content) {
        if !unique.contains(&found.as_str()) {
            unique.push(found.as_str());
        }
        if unique.len() == 3 {
            break;
        }
    }
    if unique.is_empty() {
        return None;
    }
    Some(format!(
        "[shell-bleed-warning] Possible shell variable syntax ({}) detected in {script}. \
         In Python use os.environ.get('VAR'), in Node use process.env.VAR.",
        unique.join(", ")
    ))
}

fn script_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"(?:python3?|node(?:js)?)\s+"?([A-Za-z0-9_./\\-]+\.(?:py|mjs?|cjs?))"?"#)
            .expect("static regex")
    })
}

fn env_var_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\$[A-Z_][A-Z0-9_]{2,}").expect("static regex"))
}

fn timeout_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)(?-u:\b)timeout(?-u:\b)").expect("static regex"))
}

#[cfg(test)]
mod tests {
    use super::super::types::test_support::TempDir;
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    fn args(command: &str) -> Map<String, Value> {
        json!({ "command": command })
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn empty_and_blocked_commands_are_thrown_errors() {
        let dir = TempDir::new();
        let env = dir.env(false);
        let ctx = SkillDispatchContext::default();

        let err = shell_execute(&args("   "), &ctx, &env)
            .await
            .expect_err("empty");
        assert_eq!(err.0, "shell_execute requires command.");

        let err = shell_execute(&args("rm -rf /"), &ctx, &env)
            .await
            .expect_err("blocked");
        assert_eq!(err.0, "Command blocked by security policy.");
    }

    #[tokio::test]
    async fn unapproved_command_is_refused_when_approvals_are_required() {
        let dir = TempDir::new();
        let env = dir.env(true);
        let err = shell_execute(&args("echo hi"), &SkillDispatchContext::default(), &env)
            .await
            .expect_err("needs approval");
        assert!(err.0.contains("Fingerprint: "));
        assert!(err.0.contains("npm run cli -- node approve"));
    }

    #[tokio::test]
    async fn workspace_escape_is_reported_as_a_result_not_a_throw() {
        let dir = TempDir::new();
        let env = dir.env(false);
        let ctx = SkillDispatchContext {
            workspace_cwd: Some("../../outside".to_string()),
            ..SkillDispatchContext::default()
        };
        let out = shell_execute(&args("echo hi"), &ctx, &env)
            .await
            .expect("result");
        assert_eq!(out.exit_code, 1);
        assert_eq!(out.stdout, "");
        assert_eq!(
            out.stderr,
            "Error: workspaceCwd must resolve inside persona workspace root."
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn success_returns_stdout_and_zero_exit() {
        let dir = TempDir::new();
        let out = shell_execute(
            &args("echo hi"),
            &SkillDispatchContext::default(),
            &dir.env(false),
        )
        .await
        .expect("run");
        assert_eq!(
            out,
            ShellOutput {
                stdout: "hi\n".to_string(),
                stderr: String::new(),
                exit_code: 0,
            }
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn non_zero_exit_keeps_the_code_and_the_command_in_the_error_text() {
        let dir = TempDir::new();
        let out = shell_execute(
            &args("exit 7"),
            &SkillDispatchContext::default(),
            &dir.env(false),
        )
        .await
        .expect("run");
        assert_eq!(out.exit_code, 7);
        assert!(out
            .stderr
            .starts_with("Error: Command failed: /bin/sh -lc exit 7\n"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_maps_to_exit_124_and_the_timeout_message() {
        let dir = TempDir::new();
        let mut env = dir.env(false);
        env.exec.shell_timeout = Duration::from_millis(300);
        let out = shell_execute(&args("sleep 30"), &SkillDispatchContext::default(), &env)
            .await
            .expect("run");
        assert_eq!(out.exit_code, TIMEOUT_EXIT_CODE);
        assert_eq!(out.stderr, TIMED_OUT_MESSAGE);
    }

    #[test]
    fn a_timeout_word_in_stderr_marks_a_run_without_exit_code_as_timed_out() {
        let out = shell_failure(
            String::new(),
            "",
            "Error: spawn x ENOENT".into(),
            None,
            false,
        );
        assert_eq!(out.exit_code, 1);
        assert_eq!(out.stderr, "Error: spawn x ENOENT");

        let out = shell_failure(String::new(), "request timeout", String::new(), None, false);
        assert_eq!(out.exit_code, TIMEOUT_EXIT_CODE);
        assert_eq!(out.stderr, "request timeout");

        let out = shell_failure(String::new(), "bad", String::new(), Some(2), true);
        assert_eq!(out.exit_code, 2, "a real exit code wins");
    }

    #[tokio::test]
    async fn bleed_warning_names_up_to_three_distinct_shell_variables() {
        let dir = TempDir::new();
        let script = dir.0.join("tool.py");
        std::fs::write(
            &script,
            "import os\nprint('$HOME_DIR $USER_NAME $HOME_DIR $TMP_X $OTHER')\n",
        )
        .expect("script");

        let warning = shell_bleed_warning("python3 tool.py", &dir.0)
            .await
            .expect("warning");
        assert!(
            warning.contains("($HOME_DIR, $USER_NAME, $TMP_X)"),
            "{warning}"
        );
        assert!(warning.contains("detected in tool.py."));

        assert!(shell_bleed_warning("python3 missing.py", &dir.0)
            .await
            .is_none());
        assert!(shell_bleed_warning("ls -la", &dir.0).await.is_none());
    }
}
