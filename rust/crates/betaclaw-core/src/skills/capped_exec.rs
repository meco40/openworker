//! Run-to-completion runner behind `shell_execute`, `python_execute` and `playwright_cli`.
//!
//! Mirrors `promisify(execFile)` with `{ cwd, timeout, maxBuffer }`:
//! - stdout and stderr are each capped at `max_buffer` bytes, as Node's `maxBuffer` is;
//! - a run that hits the cap or the timeout is killed, and the output captured so far is
//!   returned, as Node returns partial output on its error object;
//! - such a kill is reported as `killed` with signal `SIGTERM`, which is what Node reports.
//!
//! Deliberate deviations, both visible to the caller:
//! - The child's stdin is `/dev/null`. Node leaves a pipe open that nothing writes to, so
//!   a command that reads stdin hangs until the timeout.
//! - A killed child gets SIGKILL on Unix (`start_kill`). Node sends SIGTERM, and this crate
//!   has no libc binding to send other signals. On Windows, `TerminateProcess` is what
//!   Node does as well.

use std::io;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::Notify;

use super::types::lock_unpoisoned;
use crate::safe_error_message;

/// How long stdout and stderr may still drain after the child is gone. A grandchild that
/// inherited the pipes can keep them open.
const DRAIN_GRACE: Duration = Duration::from_secs(1);

/// The program could not be started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SpawnFailure {
    /// `ENOENT`: the program does not exist.
    pub not_found: bool,
    /// Node's `String(error)`, for example `Error: spawn powershell ENOENT`.
    pub message: String,
}

/// Outcome of one [`run_capped`] call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CappedRun {
    pub stdout: String,
    pub stderr: String,
    /// `Some` only when the child exited by itself.
    pub exit_code: Option<i32>,
    /// Timed out, overflowed `max_buffer`, or ended with SIGTERM.
    pub killed: bool,
    /// Set when the program did not start.
    pub spawn_failure: Option<SpawnFailure>,
    /// Signal name of a child that was killed.
    pub signal: Option<String>,
}

impl CappedRun {
    /// Node's success condition: exit code 0, nothing killed, nothing failed to spawn.
    pub fn is_success(&self) -> bool {
        self.spawn_failure.is_none() && self.exit_code == Some(0) && !self.killed
    }

    /// `String(error)` for a failed `execFile`. A child that ran reports
    /// `Error: Command failed: <cmd>` followed by its stderr, as Node does.
    pub fn error_text(&self, command_line: &str) -> String {
        match &self.spawn_failure {
            Some(failure) => failure.message.clone(),
            None => format!("Error: Command failed: {command_line}\n{}", self.stderr),
        }
    }
}

/// `file + ' ' + args.join(' ')`, the command text Node puts into its error message.
pub(crate) fn command_line(program: &str, args: &[String]) -> String {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Runs `program` in `cwd` to completion, with stdout and stderr each capped at
/// `max_buffer` bytes and a hard `timeout`.
pub(crate) async fn run_capped(
    program: &str,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
    max_buffer: usize,
) -> CappedRun {
    let mut child = match Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return spawn_failed(program, &error),
    };

    let captured = Arc::new(Mutex::new(Captured::default()));
    let overflow = Arc::new(Notify::new());
    let mut out_task = tokio::spawn(pump(
        child.stdout.take(),
        Stream::Stdout,
        captured.clone(),
        max_buffer,
        overflow.clone(),
    ));
    let mut err_task = tokio::spawn(pump(
        child.stderr.take(),
        Stream::Stderr,
        captured.clone(),
        max_buffer,
        overflow.clone(),
    ));

    let outcome = tokio::select! {
        status = child.wait() => Outcome::Exited(status),
        _ = overflow.notified() => Outcome::Killed,
        _ = tokio::time::sleep(timeout) => Outcome::Killed,
    };
    let (exit_code, signal, killed) = match outcome {
        Outcome::Exited(Ok(status)) => (status.code(), signal_name(&status), false),
        Outcome::Exited(Err(_)) => (None, None, false),
        Outcome::Killed => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            (None, Some("SIGTERM".to_string()), true)
        }
    };

    let _ = tokio::time::timeout(DRAIN_GRACE, async {
        let _ = (&mut out_task).await;
        let _ = (&mut err_task).await;
    })
    .await;
    out_task.abort();
    err_task.abort();

    let state = lock_unpoisoned(&captured);
    let killed = killed || state.overflow || signal.as_deref() == Some("SIGTERM");
    CappedRun {
        stdout: String::from_utf8_lossy(&state.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&state.stderr).into_owned(),
        exit_code,
        killed,
        spawn_failure: None,
        signal,
    }
}

enum Outcome {
    Exited(io::Result<ExitStatus>),
    Killed,
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

#[derive(Default)]
struct Captured {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    overflow: bool,
}

/// Copies one pipe into the shared buffers until EOF. On overflow it keeps the bytes
/// that fit, flags the run, and wakes the waiter so the child is killed.
async fn pump<R: AsyncRead + Unpin>(
    reader: Option<R>,
    stream: Stream,
    captured: Arc<Mutex<Captured>>,
    cap: usize,
    overflow: Arc<Notify>,
) {
    let Some(mut reader) = reader else {
        return;
    };
    let mut chunk = [0u8; 8192];
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        let mut state = lock_unpoisoned(&captured);
        let buffer = match stream {
            Stream::Stdout => &mut state.stdout,
            Stream::Stderr => &mut state.stderr,
        };
        let room = cap.saturating_sub(buffer.len());
        if read > room {
            buffer.extend_from_slice(&chunk[..room]);
            state.overflow = true;
            drop(state);
            overflow.notify_one();
            return;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

fn spawn_failed(program: &str, error: &io::Error) -> CappedRun {
    let not_found = error.kind() == io::ErrorKind::NotFound;
    let reason = if not_found {
        "ENOENT".to_string()
    } else {
        safe_error_message(error)
    };
    CappedRun {
        stdout: String::new(),
        stderr: String::new(),
        exit_code: None,
        killed: false,
        spawn_failure: Some(SpawnFailure {
            not_found,
            message: format!("Error: spawn {program} {reason}"),
        }),
        signal: None,
    }
}

#[cfg(unix)]
fn signal_name(status: &ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    let name = match status.signal()? {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        6 => "SIGABRT",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        15 => "SIGTERM",
        _ => return None,
    };
    Some(name.to_string())
}

#[cfg(not(unix))]
fn signal_name(_status: &ExitStatus) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn sh(script: &str) -> Vec<String> {
        vec!["-c".to_string(), script.to_string()]
    }

    fn temp() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn captures_both_streams_and_the_exit_code() {
        let run = run_capped(
            "/bin/sh",
            &sh("echo hi; echo err >&2; exit 3"),
            &temp(),
            Duration::from_secs(5),
            1_000_000,
        )
        .await;
        assert_eq!(run.stdout, "hi\n");
        assert_eq!(run.stderr, "err\n");
        assert_eq!(run.exit_code, Some(3));
        assert!(!run.killed);
        assert!(!run.is_success());
        assert_eq!(
            run.error_text("/bin/sh -c x"),
            "Error: Command failed: /bin/sh -c x\nerr\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_the_child_and_keeps_the_partial_output() {
        let run = run_capped(
            "/bin/sh",
            &sh("echo partial; sleep 30"),
            &temp(),
            Duration::from_millis(300),
            1_000_000,
        )
        .await;
        assert!(run.killed);
        assert_eq!(run.exit_code, None);
        assert_eq!(run.stdout, "partial\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_over_the_cap_kills_the_child_and_truncates() {
        let run = run_capped(
            "/bin/sh",
            &sh("while :; do echo y; done"),
            &temp(),
            Duration::from_secs(10),
            1000,
        )
        .await;
        assert!(run.killed);
        assert_eq!(run.stdout.len(), 1000);
    }

    #[tokio::test]
    async fn a_missing_program_is_a_spawn_failure_not_an_exit() {
        let run = run_capped(
            "betaclaw-no-such-program-xyz",
            &[],
            &temp(),
            Duration::from_secs(5),
            1000,
        )
        .await;
        let failure = run.spawn_failure.expect("spawn failure");
        assert!(failure.not_found);
        assert_eq!(
            failure.message,
            "Error: spawn betaclaw-no-such-program-xyz ENOENT"
        );
        assert_eq!(run.exit_code, None);
        assert!(!run.killed);
    }

    #[test]
    fn command_line_joins_program_and_arguments() {
        assert_eq!(
            command_line("node", &["cli.js".to_string(), "test".to_string()]),
            "node cli.js test"
        );
    }
}
