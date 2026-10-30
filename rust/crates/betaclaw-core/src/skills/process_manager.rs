//! Port of `src/server/skills/handlers/processManager.ts`.
//!
//! Background processes that outlive one tool call: `start`, `poll` (alias `log`),
//! `write`, `kill`, `list`. Output is read through pipes, not a PTY, so interactive
//! programs do not work. Use `shell_execute` for those.
//!
//! The registry is an owned [`ProcessManager`], not a process-wide map. The gateway holds
//! one and calls [`ProcessManager::kill_all`] at shutdown.
//!
//! The TypeScript `{ ok, result }` / `{ ok: false, error }` reply maps to `Ok(result)` and
//! `Err(error)`.
//!
//! Buffer and output lengths count Unicode scalar values. TypeScript counts UTF-16 units,
//! so the two differ only for characters outside the Basic Multilingual Plane.
//!
//! Deviations:
//! - Path boundary: `cwd` is also checked through symbolic links (`assertRealPathWithinRoot`).
//!   The TypeScript handler does not check them, so a link inside the workspace could start a
//!   process outside it. The checks and messages otherwise match `resolveProcessCwd`.
//! - Signals: on Unix, every signal except SIGKILL goes through `kill -s` in `/bin/sh`,
//!   because the crate has no libc binding. On Windows, every kill is `TerminateProcess`,
//!   which is what Node does there too.
//! - `start` returns when the process exits or the start timeout ends. A spawn failure
//!   returns at once, not after the timeout. The output text is the same.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex, Notify};

use super::exec_approval::enforce_exec_approval;
use super::execution_cwd::{
    assert_real_path_within_root, is_within_root, lexical_resolve, resolve_skill_execution_cwd,
};
use super::node_command_policy::evaluate_node_command_policy;
use super::shell_execute::shell_invocation;
use super::types::{
    arg_number, arg_string, arg_text, js_trim, lock_unpoisoned, SkillDispatchContext, SkillEnv,
};
use crate::safe_error_message;

const MAX_BUFFER_CHARS: usize = 200_000;
const DEFAULT_POLL_CHARS: usize = 4_000;
const DEFAULT_START_TIMEOUT_MS: f64 = 2_000.0;
const LABEL_MAX_CHARS: usize = 80;
/// Largest value `setTimeout` accepts. Anything beyond it fires after 1 ms in Node.
const MAX_TIMER_MS: f64 = 2_147_483_647.0;
const KNOWN_SIGNALS: [&str; 7] = [
    "SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGKILL", "SIGUSR1", "SIGUSR2",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Running,
    Exited,
    Killed,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Killed => "killed",
        }
    }
}

struct State {
    status: Status,
    exit_code: Option<i32>,
    buffer: String,
}

/// One managed process. Shared between the handler and its I/O tasks.
struct Managed {
    id: String,
    label: String,
    pid: Option<u32>,
    state: Mutex<State>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    kill: Mutex<Option<oneshot::Sender<String>>>,
    exited: Notify,
}

impl Managed {
    fn new(id: String, label: String, pid: Option<u32>) -> Self {
        Self {
            id,
            label,
            pid,
            state: Mutex::new(State {
                status: Status::Running,
                exit_code: None,
                buffer: String::new(),
            }),
            stdin: AsyncMutex::new(None),
            kill: Mutex::new(None),
            exited: Notify::new(),
        }
    }

    /// Sends `signal` to a running process. Returns false when it was not running.
    fn request_kill(&self, signal: &str) -> bool {
        {
            let mut state = lock_unpoisoned(&self.state);
            if state.status != Status::Running {
                return false;
            }
            state.status = Status::Killed;
        }
        if let Some(sender) = lock_unpoisoned(&self.kill).take() {
            let _ = sender.send(signal.to_string());
        }
        true
    }

    fn status(&self) -> Status {
        lock_unpoisoned(&self.state).status
    }
}

/// The registry of managed processes. Cheap to share behind an `Arc`.
#[derive(Default)]
pub struct ProcessManager {
    entries: Mutex<Vec<Arc<Managed>>>,
    counter: AtomicU64,
}

impl ProcessManager {
    /// `killAllManagedProcesses`: sends SIGTERM to every running process and forgets all
    /// of them.
    pub fn kill_all(&self) {
        let mut entries = lock_unpoisoned(&self.entries);
        for entry in entries.iter() {
            entry.request_kill("SIGTERM");
        }
        entries.clear();
    }

    /// `processManagerHandler`.
    pub async fn handle(
        &self,
        args: &Map<String, Value>,
        ctx: &SkillDispatchContext,
        env: &SkillEnv,
    ) -> Result<String, String> {
        match arg_string(args, "action").as_str() {
            "start" => self.start(args, ctx, env).await,
            "list" => Ok(self.list()),
            "poll" | "log" => self.poll(args),
            "write" => self.write(args).await,
            "kill" => self.kill(args),
            other => Err(format!(
                "Unknown action \"{other}\". Valid actions: start, poll, log, write, kill, list."
            )),
        }
    }

    async fn start(
        &self,
        args: &Map<String, Value>,
        ctx: &SkillDispatchContext,
        env: &SkillEnv,
    ) -> Result<String, String> {
        let command = js_trim(&arg_string(args, "command")).to_string();
        if command.is_empty() {
            return Err("action=start requires a non-empty command.".to_string());
        }
        let policy = evaluate_node_command_policy(&command);
        if !policy.allowed {
            return Err(policy.reason.unwrap_or_default().to_string());
        }
        enforce_exec_approval(env, ctx, &command, true).map_err(|error| error.0)?;

        let requested_label = arg_string(args, "label");
        let label_source = if requested_label.is_empty() {
            command.clone()
        } else {
            requested_label
        };
        let label: String = label_source.chars().take(LABEL_MAX_CHARS).collect();
        let cwd = resolve_process_cwd(args, ctx, env)?;
        let wait = start_wait(args);

        let id = self.next_id();
        let (program, argv) = shell_invocation(&command);
        let spawned = Command::new(program)
            .args(&argv)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn();

        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => {
                let entry = Arc::new(Managed::new(id, label.clone(), None));
                fail_spawn(&entry, &error);
                lock_unpoisoned(&self.entries).push(entry.clone());
                return Ok(start_report(&entry, &label));
            }
        };

        let entry = Arc::new(Managed::new(id, label.clone(), child.id()));
        *entry.stdin.lock().await = child.stdin.take();
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(pump_output(stdout, entry.clone(), None));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(pump_output(stderr, entry.clone(), Some("[stderr] ")));
        }
        let (kill_tx, kill_rx) = oneshot::channel();
        *lock_unpoisoned(&entry.kill) = Some(kill_tx);
        tokio::spawn(wait_for_exit(child, entry.clone(), kill_rx));
        lock_unpoisoned(&self.entries).push(entry.clone());

        let _ = tokio::time::timeout(wait, entry.exited.notified()).await;
        Ok(start_report(&entry, &label))
    }

    fn list(&self) -> String {
        let entries = lock_unpoisoned(&self.entries);
        if entries.is_empty() {
            return "No managed processes.".to_string();
        }
        entries
            .iter()
            .map(|entry| {
                let pid = entry.pid.map_or("?".to_string(), |pid| pid.to_string());
                format!(
                    "id={}  status={}  pid={pid}  label=\"{}\"",
                    entry.id,
                    entry.status().as_str(),
                    entry.label
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn poll(&self, args: &Map<String, Value>) -> Result<String, String> {
        let id = arg_string(args, "id");
        if id.is_empty() {
            return Err("action=poll requires id.".to_string());
        }
        let entry = self.find(&id)?;
        let bytes = arg_number(args, "bytes", DEFAULT_POLL_CHARS as f64);
        let limit = if bytes.is_finite() && bytes >= 0.0 {
            bytes as usize
        } else {
            DEFAULT_POLL_CHARS
        };

        let state = lock_unpoisoned(&entry.state);
        let mut status_line = format!("[status={}", state.status.as_str());
        if let Some(code) = state.exit_code {
            status_line.push_str(&format!(", exit_code={code}"));
        }
        status_line.push(']');
        let output = if state.buffer.is_empty() {
            "(no output yet)".to_string()
        } else {
            trimmed_tail(&state.buffer, limit)
        };
        Ok(format!("{status_line}\n{output}"))
    }

    async fn write(&self, args: &Map<String, Value>) -> Result<String, String> {
        let id = arg_string(args, "id");
        let text = arg_text(args, "text");
        if id.is_empty() {
            return Err("action=write requires id.".to_string());
        }
        let entry = self.find(&id)?;
        let status = entry.status();
        if status != Status::Running {
            return Err(format!(
                "Process {id} is not running (status={}).",
                status.as_str()
            ));
        }
        let mut stdin = entry.stdin.lock().await;
        let Some(handle) = stdin.as_mut() else {
            return Err("stdin write error: stdin is closed.".to_string());
        };
        match handle.write_all(text.as_bytes()).await {
            Ok(()) => Ok(format!(
                "Wrote {} chars to stdin of {id}.",
                text.encode_utf16().count()
            )),
            Err(error) => Err(format!("stdin write error: {}", safe_error_message(&error))),
        }
    }

    fn kill(&self, args: &Map<String, Value>) -> Result<String, String> {
        let id = arg_string(args, "id");
        if id.is_empty() {
            return Err("action=kill requires id.".to_string());
        }
        let entry = self.find(&id)?;
        let status = entry.status();
        if status != Status::Running {
            return Ok(format!(
                "Process {id} already ended (status={}).",
                status.as_str()
            ));
        }
        let requested = arg_string(args, "signal");
        let signal = if requested.is_empty() {
            "SIGTERM".to_string()
        } else {
            requested
        };
        if !KNOWN_SIGNALS.contains(&signal.as_str()) {
            return Err(format!("kill failed: Unknown signal: {signal}"));
        }
        entry.request_kill(&signal);
        lock_unpoisoned(&self.entries).retain(|candidate| candidate.id != id);
        Ok(format!(
            "Sent {signal} to process {id} (\"{}\").",
            entry.label
        ))
    }

    fn find(&self, id: &str) -> Result<Arc<Managed>, String> {
        lock_unpoisoned(&self.entries)
            .iter()
            .find(|entry| entry.id == id)
            .cloned()
            .ok_or_else(|| format!("No process with id={id}."))
    }

    fn next_id(&self) -> String {
        let sequence = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        format!("proc-{millis}-{sequence}")
    }
}

/// `resolveProcessCwd`: `cwd` is relative to the workspace root and must stay inside it.
fn resolve_process_cwd(
    args: &Map<String, Value>,
    ctx: &SkillDispatchContext,
    env: &SkillEnv,
) -> Result<PathBuf, String> {
    let workspace_root = resolve_skill_execution_cwd(&env.personas, ctx).map_err(|e| e.0)?;
    let requested = js_trim(&arg_string(args, "cwd")).to_string();
    if requested.is_empty() {
        return Ok(workspace_root);
    }
    let resolved = lexical_resolve(&workspace_root.join(&requested));
    if !is_within_root(&resolved, &workspace_root) {
        return Err("cwd must stay within workspace root.".to_string());
    }
    assert_real_path_within_root(&resolved, &workspace_root).map_err(|e| e.0)?;
    fs::create_dir_all(&resolved).map_err(|error| safe_error_message(&error))?;
    Ok(resolved)
}

/// How long `start` waits for an early exit. Mirrors `setTimeout`: a negative, NaN or
/// oversized delay fires after 1 ms.
fn start_wait(args: &Map<String, Value>) -> Duration {
    let ms = arg_number(args, "start_timeout_ms", DEFAULT_START_TIMEOUT_MS);
    let millis = if ms.is_finite() && (0.0..=MAX_TIMER_MS).contains(&ms) {
        ms as u64
    } else {
        1
    };
    Duration::from_millis(millis)
}

/// The reply of `start`: a status line, then the first output if any.
fn start_report(entry: &Managed, label: &str) -> String {
    let state = lock_unpoisoned(&entry.state);
    let id = &entry.id;
    let status_line = if state.status == Status::Running {
        let pid = entry.pid.unwrap_or_default();
        format!("Process \"{label}\" started (id={id}, pid={pid}).")
    } else {
        let code = state
            .exit_code
            .map_or("null".to_string(), |code| code.to_string());
        format!("Process \"{label}\" exited immediately (exit_code={code}, id={id}).")
    };
    if state.buffer.is_empty() {
        status_line
    } else {
        format!(
            "{status_line}\nInitial output:\n{}",
            trimmed_tail(&state.buffer, DEFAULT_POLL_CHARS)
        )
    }
}

/// `trimmedTail`: the last `chars` characters with a truncation note, or the text itself.
fn trimmed_tail(text: &str, chars: usize) -> String {
    let total = text.chars().count();
    if total <= chars {
        return text.to_string();
    }
    let tail: String = text.chars().skip(total - chars).collect();
    format!("[...truncated, showing last {chars} chars]\n{tail}")
}

/// Appends to the bounded buffer, keeping the last `MAX_BUFFER_CHARS` characters.
///
/// Ponytail: once full, every append counts characters over the whole buffer. A byte-index
/// trim would be cheaper if this ever shows up in a profile.
fn append(buffer: &mut String, text: &str) {
    buffer.push_str(text);
    if buffer.len() <= MAX_BUFFER_CHARS {
        return;
    }
    let excess = buffer.chars().count().saturating_sub(MAX_BUFFER_CHARS);
    if excess > 0 {
        let cut = buffer
            .char_indices()
            .nth(excess)
            .map_or(buffer.len(), |(index, _)| index);
        buffer.drain(..cut);
    }
}

fn fail_spawn(entry: &Managed, error: &io::Error) {
    let mut state = lock_unpoisoned(&entry.state);
    state.status = Status::Exited;
    state.exit_code = Some(-1);
    append(
        &mut state.buffer,
        &format!("[spawn error] {}\n", safe_error_message(error)),
    );
}

/// Copies one output pipe into the buffer until EOF. Each stderr chunk gets the
/// `[stderr] ` prefix, as in TypeScript.
async fn pump_output<R: AsyncRead + Unpin>(
    mut reader: R,
    entry: Arc<Managed>,
    prefix: Option<&'static str>,
) {
    let mut chunk = [0u8; 8192];
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        let text = String::from_utf8_lossy(&chunk[..read]);
        let mut state = lock_unpoisoned(&entry.state);
        match prefix {
            Some(prefix) => append(&mut state.buffer, &format!("{prefix}{text}")),
            None => append(&mut state.buffer, &text),
        }
    }
}

/// Owns the child. Records its exit, or delivers a kill request first.
async fn wait_for_exit(mut child: Child, entry: Arc<Managed>, kill_rx: oneshot::Receiver<String>) {
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        request = kill_rx => {
            if let Ok(signal) = request {
                deliver_signal(&mut child, &signal).await;
            }
            child.wait().await.ok()
        }
    };
    {
        let mut state = lock_unpoisoned(&entry.state);
        if state.status != Status::Killed {
            state.status = Status::Exited;
        }
        state.exit_code = status.and_then(|status| status.code());
    }
    entry.exited.notify_one();
}

async fn deliver_signal(child: &mut Child, signal: &str) {
    if signal != "SIGKILL" {
        if let Some(pid) = child.id() {
            if send_unix_signal(pid, signal).await {
                return;
            }
        }
    }
    let _ = child.start_kill();
}

#[cfg(unix)]
async fn send_unix_signal(pid: u32, signal: &str) -> bool {
    // POSIX `kill -s` takes the name without its SIG prefix. The pid and the name are
    // passed as separate arguments, never spliced into the script.
    let pid_text = pid.to_string();
    let name = signal.trim_start_matches("SIG");
    Command::new("/bin/sh")
        .args(["-c", "kill -s \"$1\" \"$2\"", "sh", name, pid_text.as_str()])
        .status()
        .await
        .is_ok_and(|status| status.success())
}

#[cfg(not(unix))]
async fn send_unix_signal(_pid: u32, _signal: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::super::types::test_support::TempDir;
    use super::*;
    use serde_json::json;
    use std::time::Instant;

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn id_of(report: &str) -> String {
        let start = report.find("id=").expect("id") + 3;
        report[start..]
            .split([',', ')', '.'])
            .next()
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn trimmed_tail_keeps_the_last_characters_with_a_note() {
        assert_eq!(trimmed_tail("abc", 5), "abc");
        assert_eq!(
            trimmed_tail("abcdef", 2),
            "[...truncated, showing last 2 chars]\nef"
        );
    }

    #[test]
    fn append_bounds_the_buffer_to_the_last_characters() {
        let mut buffer = "x".repeat(MAX_BUFFER_CHARS);
        append(&mut buffer, "tail");
        assert_eq!(buffer.chars().count(), MAX_BUFFER_CHARS);
        assert!(buffer.ends_with("tail"));
    }

    #[test]
    fn start_wait_matches_set_timeout_for_odd_inputs() {
        assert_eq!(start_wait(&args(json!({}))), Duration::from_millis(2_000));
        assert_eq!(
            start_wait(&args(json!({ "start_timeout_ms": 300 }))),
            Duration::from_millis(300)
        );
        assert_eq!(
            start_wait(&args(json!({ "start_timeout_ms": "abc" }))),
            Duration::from_millis(1)
        );
        assert_eq!(
            start_wait(&args(json!({ "start_timeout_ms": -5 }))),
            Duration::from_millis(1)
        );
    }

    #[tokio::test]
    async fn unknown_action_and_missing_ids_are_errors() {
        let dir = TempDir::new();
        let env = dir.env(false);
        let manager = ProcessManager::default();
        let ctx = SkillDispatchContext::default();

        let err = manager
            .handle(&args(json!({ "action": "nope" })), &ctx, &env)
            .await;
        assert!(err
            .expect_err("unknown")
            .starts_with("Unknown action \"nope\""));

        let err = manager
            .handle(&args(json!({ "action": "poll", "id": "x" })), &ctx, &env)
            .await;
        assert_eq!(err.expect_err("missing"), "No process with id=x.");

        let err = manager
            .handle(&args(json!({ "action": "kill" })), &ctx, &env)
            .await;
        assert_eq!(err.expect_err("needs id"), "action=kill requires id.");
    }

    #[tokio::test]
    async fn start_refuses_a_cwd_that_leaves_the_workspace() {
        let dir = TempDir::new();
        let manager = ProcessManager::default();
        let err = manager
            .handle(
                &args(json!({ "action": "start", "command": "echo hi", "cwd": "../../.." })),
                &SkillDispatchContext::default(),
                &dir.env(false),
            )
            .await
            .expect_err("cwd escape");
        assert_eq!(err, "cwd must stay within workspace root.");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_exiting_process_reports_its_exit_code_at_start() {
        let dir = TempDir::new();
        let manager = ProcessManager::default();
        let report = manager
            .handle(
                &args(json!({ "action": "start", "command": "exit 3", "start_timeout_ms": 5000 })),
                &SkillDispatchContext::default(),
                &dir.env(false),
            )
            .await
            .expect("start");
        assert!(
            report.contains("exited immediately (exit_code=3, id=proc-"),
            "{report}"
        );
        let listed = manager
            .handle(
                &args(json!({ "action": "list" })),
                &SkillDispatchContext::default(),
                &dir.env(false),
            )
            .await
            .expect("list");
        assert!(listed.contains("status=exited"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_running_process_can_be_written_to_polled_and_killed() {
        let dir = TempDir::new();
        let env = dir.env(false);
        let ctx = SkillDispatchContext::default();
        let manager = ProcessManager::default();

        let report = manager
            .handle(
                &args(json!({ "action": "start", "command": "cat", "start_timeout_ms": 100 })),
                &ctx,
                &env,
            )
            .await
            .expect("start");
        assert!(report.contains("started (id=proc-"), "{report}");
        let id = id_of(&report);

        let written = manager
            .handle(
                &args(json!({ "action": "write", "id": id, "text": "hello\n" })),
                &ctx,
                &env,
            )
            .await
            .expect("write");
        assert_eq!(written, format!("Wrote 6 chars to stdin of {id}."));

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let polled = manager
                .handle(&args(json!({ "action": "poll", "id": id })), &ctx, &env)
                .await
                .expect("poll");
            if polled.contains("hello") {
                break;
            }
            assert!(Instant::now() < deadline, "cat never echoed: {polled}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let bad_signal = manager
            .handle(
                &args(json!({ "action": "kill", "id": id, "signal": "SIGFOO" })),
                &ctx,
                &env,
            )
            .await;
        assert_eq!(
            bad_signal.expect_err("unknown signal"),
            "kill failed: Unknown signal: SIGFOO"
        );

        let killed = manager
            .handle(&args(json!({ "action": "kill", "id": id })), &ctx, &env)
            .await
            .expect("kill");
        assert!(killed.starts_with("Sent SIGTERM to process "), "{killed}");

        let gone = manager
            .handle(&args(json!({ "action": "poll", "id": id })), &ctx, &env)
            .await;
        assert!(gone.is_err(), "killed processes leave the registry");
    }
}
