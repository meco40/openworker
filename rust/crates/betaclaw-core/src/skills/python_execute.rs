//! Port of `src/server/skills/handlers/pythonExecute.ts`.
//!
//! The policy and the approval see the command `python -c <json code> # code-sha256=<hash>`.
//! The hash covers the raw code, so programs whose normalised text is equal still get
//! distinct approvals. `normalizeCommand` would otherwise collapse the indentation of the
//! code.
//!
//! Deviation, fixing a TypeScript bug: a run killed on timeout gets exit code 1 here.
//! TypeScript computes `Number(null)`, which is `0`, so a timed-out program was reported
//! as successful.

use std::time::Duration;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::capped_exec::run_capped;
use super::exec_approval::enforce_exec_approval;
use super::execution_cwd::resolve_skill_execution_cwd;
use super::node_command_policy::evaluate_node_command_policy;
use super::shell_execute::ShellOutput;
use super::types::{arg_string, js_trim, SkillDispatchContext, SkillEnv, SkillError};

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BUFFER: usize = 1_000_000;
const NOT_INSTALLED: &str =
    "Python is not installed. Install Python 3 or use the supported Docker image.";
const FAILED: &str = "Python execution failed.";

/// `buildPythonCommand`: the command text that policy and approval check.
pub fn build_python_command(code: &str) -> Result<String, SkillError> {
    if code.is_empty() {
        return Err(SkillError("python_execute requires code.".to_string()));
    }
    let hash: String = Sha256::digest(code.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    // JSON.stringify: a Rust string always serialises.
    let quoted = serde_json::to_string(code).expect("serialising a string cannot fail");
    Ok(format!("python -c {quoted} # code-sha256={hash}"))
}

/// `pythonExecuteHandler`.
pub async fn python_execute(
    args: &Map<String, Value>,
    ctx: &SkillDispatchContext,
    env: &SkillEnv,
) -> Result<ShellOutput, SkillError> {
    let code = js_trim(&arg_string(args, "code")).to_string();
    let command = build_python_command(&code)?;
    let policy = evaluate_node_command_policy(&command);
    if !policy.allowed {
        return Err(SkillError(policy.reason.unwrap_or_default().to_string()));
    }
    enforce_exec_approval(env, ctx, &command, false)?;

    let Ok(cwd) = resolve_skill_execution_cwd(&env.personas, ctx) else {
        return Ok(ShellOutput {
            stdout: String::new(),
            stderr: FAILED.to_string(),
            exit_code: 1,
        });
    };

    let program = if cfg!(windows) { "python" } else { "python3" };
    let argv = vec!["-c".to_string(), code];
    let run = run_capped(program, &argv, &cwd, TIMEOUT, MAX_BUFFER).await;
    if run.is_success() {
        return Ok(ShellOutput {
            stdout: run.stdout,
            stderr: run.stderr,
            exit_code: 0,
        });
    }

    let stderr = if !run.stderr.is_empty() {
        run.stderr
    } else if run
        .spawn_failure
        .as_ref()
        .is_some_and(|failure| failure.not_found)
    {
        NOT_INSTALLED.to_string()
    } else {
        FAILED.to_string()
    };
    Ok(ShellOutput {
        stdout: run.stdout,
        stderr,
        exit_code: run.exit_code.unwrap_or(1),
    })
}

#[cfg(test)]
mod tests {
    use super::super::types::test_support::TempDir;
    use super::*;
    use serde_json::json;

    fn args(code: &str) -> Map<String, Value> {
        json!({ "code": code })
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn command_carries_the_json_code_and_a_hash_of_the_raw_code() {
        let command = build_python_command("x = 1\nprint(x)").expect("command");
        assert!(command.starts_with("python -c \"x = 1\\nprint(x)\" # code-sha256="));
        let hash = command.rsplit('=').next().expect("hash");
        assert_eq!(hash.len(), 64);

        let other = build_python_command("x = 1\n print(x)").expect("command");
        assert_ne!(command, other, "indentation changes the hash");
    }

    #[test]
    fn empty_code_is_rejected() {
        let err = build_python_command("").expect_err("empty");
        assert_eq!(err.0, "python_execute requires code.");
    }

    #[tokio::test]
    async fn blocked_code_is_refused_before_anything_runs() {
        let dir = TempDir::new();
        let err = python_execute(
            &args("import os; os.system('rm -rf /')"),
            &SkillDispatchContext::default(),
            &dir.env(false),
        )
        .await
        .expect_err("blocked");
        assert_eq!(err.0, "Command blocked by security policy.");
    }

    #[tokio::test]
    async fn approval_message_has_no_cli_hint_for_python() {
        let dir = TempDir::new();
        let err = python_execute(
            &args("print(1)"),
            &SkillDispatchContext::default(),
            &dir.env(true),
        )
        .await
        .expect_err("needs approval");
        assert!(err
            .0
            .starts_with("Command requires approval. Fingerprint: "));
        assert!(!err.0.contains("npm run cli"));
    }
}
