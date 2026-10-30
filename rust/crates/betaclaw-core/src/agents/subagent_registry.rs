//! Port of `src/server/agents/subagentRegistry.ts`.
//!
//! The registry keeps the subagent runs in memory and writes the whole store file after
//! every change, as the TypeScript module does: version 1, at most 300 persisted runs, and
//! every active run is always kept. Runs still marked `running` when the store is first
//! loaded are recovered as `killed`.
//!
//! Not ported: the module-level singleton, and the `SUBAGENT_RUNS_STORE_PATH` lookup, which
//! belongs to the caller (`resolve_store_path` takes the value as a parameter). The
//! TypeScript reset helper is replaced by creating a fresh registry.
//!
//! A stored record whose `status` is not one of the four TypeScript values is kept as it was
//! read and written back unchanged, as the TypeScript loader does. The abort flag is polled
//! through [`AbortSignal::is_aborted`]; there is no listener, as the TypeScript
//! `AbortController` has in its runtime.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::stats::util::now_iso;

const STORE_VERSION: u32 = 1;
const MAX_PERSISTED_RUNS: usize = 300;
const RECOVERED_ERROR: &str = "Subagent stopped after runtime restart.";
const DEFAULT_STOP_REASON: &str = "Subagent run was stopped.";
const DEFAULT_FAILURE: &str = "Subagent execution failed.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub enum SubagentRunStatus {
    Running,
    Completed,
    Error,
    Killed,
    /// A status this build does not know. The TypeScript loader keeps such records, so the
    /// text is kept and written back as it was.
    Other(String),
}

impl From<String> for SubagentRunStatus {
    fn from(value: String) -> Self {
        match value.as_str() {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "error" => Self::Error,
            "killed" => Self::Killed,
            _ => Self::Other(value),
        }
    }
}

impl From<SubagentRunStatus> for String {
    fn from(status: SubagentRunStatus) -> Self {
        match status {
            SubagentRunStatus::Running => "running".to_string(),
            SubagentRunStatus::Completed => "completed".to_string(),
            SubagentRunStatus::Error => "error".to_string(),
            SubagentRunStatus::Killed => "killed".to_string(),
            SubagentRunStatus::Other(value) => value,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunRecord {
    pub run_id: String,
    pub requester_conversation_id: String,
    pub requester_user_id: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_function_names: Option<Vec<String>>,
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guidance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_relative_path: Option<String>,
    pub status: SubagentRunStatus,
    pub created_at: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced_by_run_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CreateSubagentRunInput {
    pub requester_conversation_id: String,
    pub requester_user_id: String,
    pub agent_id: String,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub skill_ids: Option<Vec<String>>,
    pub tool_function_names: Option<Vec<String>>,
    pub task: String,
    pub guidance: Option<String>,
    pub model_override: Option<String>,
    pub project_id: Option<String>,
    pub workspace_path: Option<String>,
    pub workspace_relative_path: Option<String>,
}

/// `AbortController` for one run. The runtime holds a clone and polls [`Self::is_aborted`].
#[derive(Debug, Clone, Default)]
pub struct AbortSignal {
    aborted: Arc<AtomicBool>,
}

impl AbortSignal {
    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }
}

/// `listSubagentRunsForConversation` result.
#[derive(Debug, Clone, PartialEq)]
pub struct ConversationRuns {
    pub active: Vec<SubagentRunRecord>,
    pub recent: Vec<SubagentRunRecord>,
}

#[derive(Default)]
struct State {
    loaded: bool,
    /// Insertion order matters: the TypeScript `Map` keeps it, and stable sorts rely on it.
    runs: Vec<SubagentRunRecord>,
    runtimes: HashMap<String, AbortSignal>,
}

#[derive(Serialize)]
struct StoreFile<'a> {
    version: u32,
    runs: &'a [SubagentRunRecord],
}

pub struct SubagentRegistry {
    path: PathBuf,
    state: Mutex<State>,
}

/// `resolveStorePath` without the environment lookup: a custom path is taken relative to
/// `cwd`, otherwise `.local/subagent-runs.json` under `cwd`.
pub fn resolve_store_path(custom: Option<&str>, cwd: &Path) -> PathBuf {
    match non_empty(custom.map(str::trim)) {
        Some(value) => cwd.join(value),
        None => cwd.join(".local").join("subagent-runs.json"),
    }
}

impl SubagentRegistry {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `createSubagentRun`.
    pub fn create_run(&self, input: CreateSubagentRunInput) -> io::Result<SubagentRunRecord> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        let now = now_iso();
        let run = SubagentRunRecord {
            run_id: format!("subagent-{}", Uuid::new_v4()),
            requester_conversation_id: input.requester_conversation_id,
            requester_user_id: input.requester_user_id,
            agent_id: input.agent_id,
            profile_id: input.profile_id,
            profile_name: input.profile_name,
            skill_ids: input.skill_ids,
            tool_function_names: input.tool_function_names,
            task: input.task,
            guidance: input.guidance,
            model_override: input.model_override,
            project_id: input.project_id,
            workspace_path: input.workspace_path,
            workspace_relative_path: input.workspace_relative_path,
            status: SubagentRunStatus::Running,
            created_at: now.clone(),
            started_at: now,
            ended_at: None,
            result_preview: None,
            error: None,
            replaced_by_run_id: None,
        };
        upsert(&mut state.runs, run.clone());
        self.persist(&state)?;
        Ok(run)
    }

    pub fn attach_runtime(&self, run_id: &str, signal: AbortSignal) -> io::Result<()> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        state.runtimes.insert(run_id.to_string(), signal);
        Ok(())
    }

    pub fn detach_runtime(&self, run_id: &str) -> io::Result<()> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        state.runtimes.remove(run_id);
        Ok(())
    }

    /// `completeSubagentRun`.
    pub fn complete_run(
        &self,
        run_id: &str,
        result_preview: Option<&str>,
    ) -> io::Result<Option<SubagentRunRecord>> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        state.runtimes.remove(run_id);
        let preview = non_empty(result_preview.map(str::trim)).map(str::to_string);
        self.update_locked(&mut state, run_id, |run| SubagentRunRecord {
            status: SubagentRunStatus::Completed,
            ended_at: Some(ended_or_now(run)),
            result_preview: preview.clone().or_else(|| run.result_preview.clone()),
            error: None,
            ..run.clone()
        })
    }

    /// `failSubagentRun`. A run that was already killed stays killed.
    pub fn fail_run(&self, run_id: &str, error: &str) -> io::Result<Option<SubagentRunRecord>> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        state.runtimes.remove(run_id);
        self.update_locked(&mut state, run_id, |run| SubagentRunRecord {
            status: if run.status == SubagentRunStatus::Killed {
                SubagentRunStatus::Killed
            } else {
                SubagentRunStatus::Error
            },
            ended_at: Some(ended_or_now(run)),
            error: Some(pick_text(
                Some(error.trim()),
                run.error.as_deref(),
                DEFAULT_FAILURE,
            )),
            ..run.clone()
        })
    }

    /// `markSubagentRunKilled`.
    pub fn mark_killed(
        &self,
        run_id: &str,
        reason: Option<&str>,
    ) -> io::Result<Option<SubagentRunRecord>> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        self.mark_killed_locked(&mut state, run_id, reason)
    }

    /// `replaceSubagentRun`: records which run took over.
    pub fn replace_run(&self, previous_run_id: &str, next_run_id: &str) -> io::Result<()> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        self.update_locked(&mut state, previous_run_id, |run| SubagentRunRecord {
            replaced_by_run_id: Some(next_run_id.to_string()),
            ..run.clone()
        })?;
        Ok(())
    }

    /// `abortSubagentRun`. Returns `true` when a live runtime was signalled.
    pub fn abort_run(&self, run_id: &str, reason: Option<&str>) -> io::Result<bool> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        let signal = state.runtimes.get(run_id).cloned();
        if let Some(signal) = &signal {
            signal.abort();
        }
        self.mark_killed_locked(
            &mut state,
            run_id,
            Some(non_empty(reason).unwrap_or(DEFAULT_STOP_REASON)),
        )?;
        Ok(signal.is_some())
    }

    pub fn count_active(&self, conversation_id: &str) -> io::Result<usize> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        Ok(state
            .runs
            .iter()
            .filter(|run| {
                run.requester_conversation_id == conversation_id
                    && run.status == SubagentRunStatus::Running
            })
            .count())
    }

    /// `listSubagentRunsForConversation`: active runs, and finished runs that ended within
    /// `recent_minutes` (at least one minute).
    pub fn list_for_conversation(
        &self,
        conversation_id: &str,
        recent_minutes: i64,
    ) -> io::Result<ConversationRuns> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        let cutoff = Utc::now().timestamp_millis() - recent_minutes.max(1) * 60_000;
        let all = conversation_runs(&state, conversation_id);
        let active: Vec<SubagentRunRecord> = all
            .iter()
            .filter(|run| run.status == SubagentRunStatus::Running)
            .cloned()
            .collect();
        let recent: Vec<SubagentRunRecord> = all
            .iter()
            .filter(|run| {
                run.status != SubagentRunStatus::Running
                    && to_timestamp(end_or_start(run)) >= cutoff
            })
            .cloned()
            .collect();
        Ok(ConversationRuns { active, recent })
    }

    /// `listActiveSubagentRuns`.
    pub fn list_active(&self, conversation_id: &str) -> io::Result<Vec<SubagentRunRecord>> {
        let mut state = self.lock();
        self.ensure_loaded(&mut state)?;
        Ok(conversation_runs(&state, conversation_id)
            .into_iter()
            .filter(|run| run.status == SubagentRunStatus::Running)
            .collect())
    }

    fn ensure_loaded(&self, state: &mut State) -> io::Result<()> {
        if state.loaded {
            return Ok(());
        }
        for run in read_store(&self.path) {
            let run = if run.status == SubagentRunStatus::Running {
                SubagentRunRecord {
                    status: SubagentRunStatus::Killed,
                    ended_at: Some(
                        non_empty(run.ended_at.as_deref()).map_or_else(now_iso, str::to_string),
                    ),
                    error: Some(pick_text(run.error.as_deref(), None, RECOVERED_ERROR)),
                    ..run
                }
            } else {
                run
            };
            upsert(&mut state.runs, run);
        }
        state.loaded = true;
        self.persist(state)
    }

    fn mark_killed_locked(
        &self,
        state: &mut State,
        run_id: &str,
        reason: Option<&str>,
    ) -> io::Result<Option<SubagentRunRecord>> {
        state.runtimes.remove(run_id);
        let reason = reason.map(str::trim).map(str::to_string);
        self.update_locked(state, run_id, |run| SubagentRunRecord {
            status: SubagentRunStatus::Killed,
            ended_at: Some(ended_or_now(run)),
            error: Some(pick_text(
                reason.as_deref(),
                run.error.as_deref(),
                DEFAULT_STOP_REASON,
            )),
            ..run.clone()
        })
    }

    /// `updateRun`: applies `update` to a stored run and persists the store.
    fn update_locked(
        &self,
        state: &mut State,
        run_id: &str,
        update: impl FnOnce(&SubagentRunRecord) -> SubagentRunRecord,
    ) -> io::Result<Option<SubagentRunRecord>> {
        self.ensure_loaded(state)?;
        let Some(index) = state.runs.iter().position(|run| run.run_id == run_id) else {
            return Ok(None);
        };
        let next = update(&state.runs[index]);
        state.runs[index] = next.clone();
        self.persist(state)?;
        Ok(Some(next))
    }

    /// `persist`: the active runs plus the newest finished runs, up to the cap.
    fn persist(&self, state: &State) -> io::Result<()> {
        let mut active: Vec<SubagentRunRecord> = state
            .runs
            .iter()
            .filter(|run| run.status == SubagentRunStatus::Running)
            .cloned()
            .collect();
        let mut finished: Vec<SubagentRunRecord> = state
            .runs
            .iter()
            .filter(|run| run.status != SubagentRunStatus::Running)
            .cloned()
            .collect();
        sort_newest_first(&mut finished);
        finished.truncate(MAX_PERSISTED_RUNS.saturating_sub(active.len()));
        active.append(&mut finished);
        sort_newest_first(&mut active);
        write_store(&self.path, &active)
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

/// First non-empty of `primary` and `fallback`, else `default`.
fn pick_text(primary: Option<&str>, fallback: Option<&str>, default: &str) -> String {
    non_empty(primary)
        .or(non_empty(fallback))
        .unwrap_or(default)
        .to_string()
}

fn ended_or_now(run: &SubagentRunRecord) -> String {
    non_empty(run.ended_at.as_deref()).map_or_else(now_iso, str::to_string)
}

fn end_or_start(run: &SubagentRunRecord) -> &str {
    non_empty(run.ended_at.as_deref()).unwrap_or(&run.started_at)
}

fn started_or_created(run: &SubagentRunRecord) -> &str {
    non_empty(Some(run.started_at.as_str())).unwrap_or(&run.created_at)
}

fn to_timestamp(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value).map_or(0, |parsed| parsed.timestamp_millis())
}

/// Newest first by `startedAt || createdAt`. The sort is stable, as in TypeScript.
fn sort_newest_first(runs: &mut [SubagentRunRecord]) {
    runs.sort_by_key(|run| std::cmp::Reverse(to_timestamp(started_or_created(run))));
}

fn conversation_runs(state: &State, conversation_id: &str) -> Vec<SubagentRunRecord> {
    let mut runs: Vec<SubagentRunRecord> = state
        .runs
        .iter()
        .filter(|run| run.requester_conversation_id == conversation_id)
        .cloned()
        .collect();
    sort_newest_first(&mut runs);
    runs
}

/// `Map.set` semantics: an existing run keeps its position.
fn upsert(runs: &mut Vec<SubagentRunRecord>, run: SubagentRunRecord) {
    match runs
        .iter()
        .position(|existing| existing.run_id == run.run_id)
    {
        Some(index) => runs[index] = run,
        None => runs.push(run),
    }
}

/// `readStore`: a missing, unreadable or wrong-version file reads as empty.
fn read_store(path: &Path) -> Vec<SubagentRunRecord> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    if parsed.get("version").and_then(Value::as_u64) != Some(u64::from(STORE_VERSION)) {
        return Vec::new();
    }
    let Some(entries) = parsed.get("runs").and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter(|entry| is_valid_entry(entry))
        .filter_map(|entry| serde_json::from_value::<SubagentRunRecord>(entry.clone()).ok())
        .collect()
}

fn is_valid_entry(entry: &Value) -> bool {
    let text = |key: &str| entry.get(key).and_then(Value::as_str).is_some();
    // An optional key must be a string when present; JSON `null` is not a string.
    let optional_text = |key: &str| entry.get(key).is_none_or(Value::is_string);
    text("runId")
        && text("requesterConversationId")
        && text("requesterUserId")
        && text("agentId")
        && text("task")
        && text("status")
        && text("createdAt")
        && text("startedAt")
        && optional_text("projectId")
        && optional_text("workspacePath")
        && optional_text("workspaceRelativePath")
}

fn write_store(path: &Path, runs: &[SubagentRunRecord]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&StoreFile {
        version: STORE_VERSION,
        runs,
    })
    .map_err(io::Error::other)?;
    fs::write(path, json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("subagent-registry-{}", Uuid::new_v4()));
        let path = dir.join("subagent-runs.json");
        (dir, path)
    }

    fn input() -> CreateSubagentRunInput {
        CreateSubagentRunInput {
            requester_conversation_id: "conv-1".to_string(),
            requester_user_id: "u1".to_string(),
            agent_id: "researcher".to_string(),
            task: "Find sources".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn a_completed_run_survives_a_reload() {
        let (dir, path) = temp_store();
        let registry = SubagentRegistry::new(&path);
        let run = registry.create_run(input()).unwrap();
        registry
            .complete_run(&run.run_id, Some("  found 3  "))
            .unwrap();

        let listing = SubagentRegistry::new(&path)
            .list_for_conversation("conv-1", 60)
            .unwrap();
        assert!(listing.active.is_empty());
        assert_eq!(listing.recent.len(), 1);
        assert_eq!(listing.recent[0].status, SubagentRunStatus::Completed);
        assert_eq!(listing.recent[0].result_preview.as_deref(), Some("found 3"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_run_that_was_running_at_restart_is_recovered_as_killed() {
        let (dir, path) = temp_store();
        let run = SubagentRegistry::new(&path).create_run(input()).unwrap();

        let listing = SubagentRegistry::new(&path)
            .list_for_conversation("conv-1", 60)
            .unwrap();
        assert!(listing.active.is_empty());
        assert_eq!(listing.recent[0].run_id, run.run_id);
        assert_eq!(listing.recent[0].status, SubagentRunStatus::Killed);
        assert_eq!(
            listing.recent[0].error.as_deref(),
            Some("Subagent stopped after runtime restart.")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn aborting_a_run_signals_its_runtime_and_marks_it_killed() {
        let (dir, path) = temp_store();
        let registry = SubagentRegistry::new(&path);
        let run = registry.create_run(input()).unwrap();
        let signal = AbortSignal::default();
        registry
            .attach_runtime(&run.run_id, signal.clone())
            .unwrap();

        assert!(registry.abort_run(&run.run_id, None).unwrap());
        assert!(signal.is_aborted());

        let listing = registry.list_for_conversation("conv-1", 60).unwrap();
        assert_eq!(listing.recent[0].status, SubagentRunStatus::Killed);
        assert_eq!(
            listing.recent[0].error.as_deref(),
            Some("Subagent run was stopped.")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_record_with_an_unknown_status_is_kept_on_load() {
        let (dir, path) = temp_store();
        fs::create_dir_all(&dir).unwrap();
        let store = serde_json::json!({
            "version": 1,
            "runs": [{
                "runId": "subagent-from-another-build",
                "requesterConversationId": "conv-1",
                "requesterUserId": "u1",
                "agentId": "researcher",
                "task": "Find sources",
                "status": "paused",
                "createdAt": "2026-10-11T10:00:00.000Z",
                "startedAt": "2026-10-11T10:00:00.000Z"
            }]
        });
        fs::write(&path, store.to_string()).unwrap();

        // Any call loads the store, and loading writes it back.
        SubagentRegistry::new(&path).count_active("conv-1").unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"subagent-from-another-build\""));
        assert!(raw.contains("\"status\": \"paused\""));
        let _ = fs::remove_dir_all(dir);
    }
}
