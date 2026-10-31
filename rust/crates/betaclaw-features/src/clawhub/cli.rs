//! Port of `src/server/clawhub/clawhubCli.ts`.
//!
//! Runs the `clawhub` CLI through the first launcher that exists: the configured
//! binary, then `npx`, `npm exec` and `pnpm dlx`, then the same three next to the
//! running executable. A missing binary moves on to the next candidate; any
//! other failure stops the search. On Windows a `.cmd` launcher that cannot be
//! spawned directly is run through `ComSpec /d /c`.
//!
//! The process spawn sits behind [`CommandRunner`], so the launcher order is
//! tested without a real process. Output is capped at 1 MiB per stream, as Node's
//! `maxBuffer`. The error text never includes stderr, which can carry registry
//! details; the exit code is what the message names.

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::errors::ClawHubError;
use super::types::CliResult;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
pub const MAX_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("ClawHub CLI could not be started: {0}")]
    Spawn(#[source] io::Error),
    /// stderr is not kept: it can carry registry details and must not reach logs.
    #[error("ClawHub CLI exited with code {}", .code.map_or_else(|| "none".to_string(), |code| code.to_string()))]
    Exit { code: Option<i32> },
    #[error("ClawHub CLI timed out")]
    Timeout,
    #[error("ClawHub CLI output exceeded the buffer limit")]
    MaxBuffer,
    #[error("No supported ClawHub launcher found.")]
    NoLauncher,
}

impl ExecError {
    /// `ENOENT`: the launcher does not exist, so the next candidate is tried.
    fn is_missing_binary(&self) -> bool {
        matches!(self, ExecError::Spawn(error) if error.kind() == io::ErrorKind::NotFound)
    }

    /// `EINVAL` on a `.cmd` launcher: Rust reports `InvalidInput` for batch files
    /// it refuses to pass to `cmd.exe` directly.
    fn is_invalid_spawn(&self) -> bool {
        matches!(self, ExecError::Spawn(error) if error.kind() == io::ErrorKind::InvalidInput)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
}

/// Runs one process to completion. Fails on spawn errors, a non-zero exit, a
/// timeout or oversized output.
pub trait CommandRunner: Send + Sync {
    fn execute(
        &self,
        file: &str,
        args: &[String],
        cwd: &Path,
        timeout: Duration,
    ) -> impl Future<Output = Result<ExecOutput, ExecError>> + Send;
}

/// The real runner, on `tokio::process`. The child is killed when the timeout
/// drops the future.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessRunner;

impl CommandRunner for ProcessRunner {
    fn execute(
        &self,
        file: &str,
        args: &[String],
        cwd: &Path,
        timeout: Duration,
    ) -> impl Future<Output = Result<ExecOutput, ExecError>> + Send {
        let mut command = tokio::process::Command::new(file);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        async move {
            let output = match tokio::time::timeout(timeout, command.output()).await {
                Err(_elapsed) => return Err(ExecError::Timeout),
                Ok(result) => result.map_err(ExecError::Spawn)?,
            };
            if output.stdout.len() > MAX_BUFFER_BYTES || output.stderr.len() > MAX_BUFFER_BYTES {
                return Err(ExecError::MaxBuffer);
            }
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            if !output.status.success() {
                return Err(ExecError::Exit {
                    code: output.status.code(),
                });
            }
            Ok(ExecOutput { stdout, stderr })
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClawHubCliOptions {
    pub workdir: PathBuf,
    pub timeout: Duration,
    pub binary: String,
    /// Directory of the running executable, where a Node install keeps `npx`,
    /// `npm` and `pnpm`.
    pub exe_dir: PathBuf,
    /// Applies the Windows launcher rules (`.cmd` suffixes, `ComSpec` fallback).
    pub windows: bool,
}

impl ClawHubCliOptions {
    /// `CLAWHUB_BIN` (default `clawhub`), the running executable's directory and
    /// the platform of the host.
    pub fn from_env(workdir: PathBuf) -> Self {
        let binary = std::env::var("CLAWHUB_BIN")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "clawhub".to_string());
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_default();
        Self {
            workdir,
            timeout: DEFAULT_TIMEOUT,
            binary,
            exe_dir,
            windows: cfg!(windows),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Candidate {
    command: String,
    argv: Vec<String>,
}

/// `buildCandidates`: the order of the launchers. Duplicates by command are
/// dropped, so a binary already named `npx` is not tried twice.
fn build_candidates(options: &ClawHubCliOptions, command: &str, args: &[String]) -> Vec<Candidate> {
    let mut common: Vec<String> = vec![
        "--workdir".to_string(),
        options.workdir.to_string_lossy().into_owned(),
        "--no-input".to_string(),
        command.to_string(),
    ];
    common.extend(args.iter().cloned());
    let with_prefix = |prefix: &[&str]| -> Vec<String> {
        prefix
            .iter()
            .map(|part| part.to_string())
            .chain(common.iter().cloned())
            .collect()
    };

    let binary = options.binary.as_str();
    let mut candidates = vec![Candidate {
        command: binary.to_string(),
        argv: common.clone(),
    }];
    if binary != "npx" {
        candidates.push(Candidate {
            command: "npx".to_string(),
            argv: with_prefix(&["-y", "clawhub"]),
        });
    }
    if binary != "npm" {
        candidates.push(Candidate {
            command: "npm".to_string(),
            argv: with_prefix(&["exec", "--yes", "clawhub", "--"]),
        });
    }
    if binary != "pnpm" {
        candidates.push(Candidate {
            command: "pnpm".to_string(),
            argv: with_prefix(&["dlx", "clawhub"]),
        });
    }

    let extension = if options.windows { ".cmd" } else { "" };
    let node_dir_launchers = [
        (format!("npx{extension}"), with_prefix(&["-y", "clawhub"])),
        (
            format!("npm{extension}"),
            with_prefix(&["exec", "--yes", "clawhub", "--"]),
        ),
        (format!("pnpm{extension}"), with_prefix(&["dlx", "clawhub"])),
    ];
    for (name, argv) in node_dir_launchers {
        let path = options.exe_dir.join(name).to_string_lossy().into_owned();
        if !candidates.iter().any(|candidate| candidate.command == path) {
            candidates.push(Candidate {
                command: path,
                argv,
            });
        }
    }
    candidates
}

/// `isWindowsCmdLauncher` without the platform check, which the caller applies.
fn is_cmd_launcher(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

fn success(output: ExecOutput, command: String, argv: Vec<String>) -> CliResult {
    CliResult {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: 0,
        command,
        argv,
    }
}

pub struct ClawHubCli<R: CommandRunner> {
    runner: R,
    options: ClawHubCliOptions,
}

impl<R: CommandRunner> ClawHubCli<R> {
    pub fn new(runner: R, options: ClawHubCliOptions) -> Self {
        Self { runner, options }
    }

    async fn exec_once(&self, file: &str, argv: &[String]) -> Result<ExecOutput, ExecError> {
        self.runner
            .execute(file, argv, &self.options.workdir, self.options.timeout)
            .await
    }

    /// `ClawHubCli.run(command, args)`.
    pub async fn run(&self, command: &str, args: &[String]) -> Result<CliResult, ClawHubError> {
        let mut last_error: Option<ExecError> = None;

        for candidate in build_candidates(&self.options, command, args) {
            let error = match self.exec_once(&candidate.command, &candidate.argv).await {
                Ok(output) => return Ok(success(output, candidate.command, candidate.argv)),
                Err(error) => error,
            };

            let error = if self.options.windows
                && is_cmd_launcher(&candidate.command)
                && error.is_invalid_spawn()
            {
                let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
                let mut wrapper_argv = vec![
                    "/d".to_string(),
                    "/c".to_string(),
                    candidate.command.clone(),
                ];
                wrapper_argv.extend(candidate.argv.iter().cloned());
                match self.exec_once(&comspec, &wrapper_argv).await {
                    Ok(output) => return Ok(success(output, comspec, wrapper_argv)),
                    Err(wrapper_error) => wrapper_error,
                }
            } else {
                error
            };

            if !error.is_missing_binary() {
                return Err(ClawHubError::Exec(error));
            }
            last_error = Some(error);
        }

        Err(ClawHubError::Exec(
            last_error.unwrap_or(ExecError::NoLauncher),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// Replays scripted results and records every call.
    struct ScriptedRunner {
        script: Mutex<VecDeque<Result<ExecOutput, ExecError>>>,
        calls: Mutex<Vec<(String, Vec<String>)>>,
    }

    impl ScriptedRunner {
        fn new(script: Vec<Result<ExecOutput, ExecError>>) -> Self {
            Self {
                script: Mutex::new(script.into()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.lock().expect("calls").clone()
        }
    }

    impl CommandRunner for ScriptedRunner {
        fn execute(
            &self,
            file: &str,
            args: &[String],
            _cwd: &Path,
            _timeout: Duration,
        ) -> impl Future<Output = Result<ExecOutput, ExecError>> + Send {
            self.calls
                .lock()
                .expect("calls")
                .push((file.to_string(), args.to_vec()));
            let next = self
                .script
                .lock()
                .expect("script")
                .pop_front()
                .expect("a scripted result for every call");
            async move { next }
        }
    }

    fn missing() -> ExecError {
        ExecError::Spawn(io::Error::from(io::ErrorKind::NotFound))
    }

    fn ok(stdout: &str) -> Result<ExecOutput, ExecError> {
        Ok(ExecOutput {
            stdout: stdout.into(),
            stderr: String::new(),
        })
    }

    fn options(windows: bool) -> ClawHubCliOptions {
        ClawHubCliOptions {
            workdir: PathBuf::from("/work"),
            timeout: Duration::from_secs(5),
            binary: "clawhub".into(),
            exe_dir: PathBuf::from("/node/bin"),
            windows,
        }
    }

    fn args() -> Vec<String> {
        vec!["--limit".into(), "5".into(), "weather".into()]
    }

    #[tokio::test]
    async fn the_configured_binary_is_tried_first() {
        let runner = ScriptedRunner::new(vec![ok("found")]);
        let cli = ClawHubCli::new(runner, options(false));
        let result = cli.run("search", &args()).await.expect("runs");
        assert_eq!(result.stdout, "found");
        assert_eq!(result.command, "clawhub");
        assert_eq!(result.exit_code, 0);
        assert_eq!(
            result.argv,
            vec![
                "--workdir",
                "/work",
                "--no-input",
                "search",
                "--limit",
                "5",
                "weather"
            ]
        );
    }

    #[tokio::test]
    async fn a_missing_binary_moves_on_to_npx() {
        let runner = ScriptedRunner::new(vec![Err(missing()), ok("")]);
        let cli = ClawHubCli::new(runner, options(false));
        let result = cli.run("search", &args()).await.expect("runs");
        assert_eq!(result.command, "npx");
        assert_eq!(result.argv[..2], ["-y".to_string(), "clawhub".to_string()]);
        assert_eq!(cli.runner.calls().len(), 2);
    }

    #[tokio::test]
    async fn a_non_zero_exit_stops_the_search_at_once() {
        let runner = ScriptedRunner::new(vec![Err(ExecError::Exit { code: Some(2) })]);
        let cli = ClawHubCli::new(runner, options(false));
        let error = cli.run("install", &args()).await.expect_err("fails");
        assert!(matches!(
            error,
            ClawHubError::Exec(ExecError::Exit { code: Some(2), .. })
        ));
        assert_eq!(error.to_string(), "ClawHub CLI exited with code 2");
        assert_eq!(
            cli.runner.calls().len(),
            1,
            "no launcher fallback after a real failure"
        );
    }

    #[tokio::test]
    async fn when_nothing_exists_the_last_missing_error_is_returned() {
        // binary, npx, npm, pnpm, then the three launchers next to the executable.
        let runner = ScriptedRunner::new((0..7).map(|_| Err(missing())).collect());
        let cli = ClawHubCli::new(runner, options(false));
        let error = cli.run("search", &args()).await.expect_err("fails");
        assert!(matches!(error, ClawHubError::Exec(ExecError::Spawn(_))));
        assert_eq!(cli.runner.calls().len(), 7);
        assert_eq!(cli.runner.calls()[6].0, "/node/bin/pnpm");
    }

    #[tokio::test]
    async fn a_cmd_launcher_that_cannot_spawn_is_run_through_comspec() {
        let mut script: Vec<Result<ExecOutput, ExecError>> =
            (0..4).map(|_| Err(missing())).collect();
        script.push(Err(ExecError::Spawn(io::Error::from(
            io::ErrorKind::InvalidInput,
        ))));
        script.push(ok("via shell"));
        let runner = ScriptedRunner::new(script);
        let cli = ClawHubCli::new(runner, options(true));

        let result = cli.run("search", &args()).await.expect("runs");
        let expected_shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        assert_eq!(result.command, expected_shell);
        assert_eq!(result.stdout, "via shell");
        assert_eq!(result.argv[..3], ["/d", "/c", "/node/bin/npx.cmd"]);
    }

    #[tokio::test]
    async fn the_process_runner_reports_a_missing_program_as_not_found() {
        let runner = ProcessRunner;
        let error = runner
            .execute(
                "/definitely/not/a/clawhub-binary",
                &[],
                Path::new("."),
                Duration::from_secs(5),
            )
            .await
            .expect_err("missing program");
        assert!(error.is_missing_binary());
    }
}
