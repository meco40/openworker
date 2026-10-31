//! Port of `src/server/tasks/taskWorkspace.ts`. Each task owns a directory that
//! holds a `.workspace.json` naming the task, so the directory can be found again
//! after its row is gone.
//!
//! The functions take the root as a parameter. The environment is read only by
//! `resolve_root` and `resolve_cleanup_max_removals`, which follow the source:
//! `TASK_WORKSPACES_ROOT` is ignored when `NODE_ENV` is `production`.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::js_string;
use crate::js::js_number_str;
use crate::stats::util::{now_iso, parse_iso_ms};

pub const METADATA_FILENAME: &str = ".workspace.json";
pub const DEFAULT_CLEANUP_MAX_REMOVALS: usize = 200;

/// The content of `.workspace.json`, in the key order of the source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetadata {
    pub task_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub created_at: String,
    pub version: u32,
}

#[derive(Debug, PartialEq, Eq)]
enum MetadataRead {
    Ok(WorkspaceMetadata),
    Missing,
    Invalid,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CleanupReasonCounts {
    pub active_task: usize,
    pub missing_metadata: usize,
    pub invalid_metadata: usize,
    pub protected: usize,
    pub limit_reached: usize,
    pub remove_failed: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CleanupReport {
    pub scanned: usize,
    pub removed: usize,
    pub kept: usize,
    pub skipped: usize,
    pub reason_counts: CleanupReasonCounts,
}

/// `resolveTaskWorkspacesRoot`.
pub fn resolve_root() -> PathBuf {
    if std::env::var("NODE_ENV").as_deref() != Ok("production") {
        if let Ok(configured) = std::env::var("TASK_WORKSPACES_ROOT") {
            if !configured.trim().is_empty() {
                return std::path::absolute(&configured)
                    .unwrap_or_else(|_| PathBuf::from(&configured));
            }
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("workspaces")
}

/// `resolveCleanupMaxRemovalsPerRun`. An unset variable is `NaN` in JavaScript
/// and takes the default, like any non-finite or negative value.
pub fn resolve_cleanup_max_removals() -> usize {
    let configured = match std::env::var("TASK_WORKSPACES_CLEANUP_MAX_REMOVALS_PER_RUN") {
        Ok(text) => js_number_str(&text),
        Err(_) => f64::NAN,
    };
    if configured.is_finite() && configured >= 0.0 {
        configured.floor() as usize
    } else {
        DEFAULT_CLEANUP_MAX_REMOVALS
    }
}

/// `sanitizeTaskWorkspaceDirectoryName`.
pub fn sanitize_dir_name(task_id: &str) -> String {
    let normalized = super::js_trim(task_id);
    let fallback = if normalized.is_empty() {
        "task-unknown"
    } else {
        normalized
    };
    let safe: String = fallback
        .chars()
        .filter(|c| (*c as u32) >= 32)
        .map(|c| if "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let trimmed = safe.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "task-unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

fn workspace_dir(root: &Path, task_id: &str) -> io::Result<PathBuf> {
    let candidate = root.join(sanitize_dir_name(task_id));
    if candidate.parent() != Some(root) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Task workspace path escapes root.",
        ));
    }
    Ok(candidate)
}

/// `normalizeTaskWorkspaceMetadata`. A metadata file without a task id is invalid.
fn normalize(raw: &Value) -> Option<WorkspaceMetadata> {
    let object = raw.as_object()?;
    let task_id = js_trim_owned(js_string(object.get("taskId")));
    if task_id.is_empty() {
        return None;
    }
    let kind = js_trim_owned(js_string(object.get("type")));
    let kind = if kind.is_empty() {
        "general".to_string()
    } else {
        kind
    };
    let created_raw = js_trim_owned(js_string(object.get("createdAt")));
    let created_at = if parse_iso_ms(&created_raw).is_some() {
        created_raw
    } else {
        now_iso()
    };
    Some(WorkspaceMetadata {
        task_id,
        kind,
        created_at,
        version: 1,
    })
}

fn js_trim_owned(text: String) -> String {
    super::js_trim(&text).to_string()
}

fn read_metadata(dir: &Path) -> MetadataRead {
    let path = dir.join(METADATA_FILENAME);
    if !path.exists() {
        return MetadataRead::Missing;
    }
    let parsed = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|raw| normalize(&raw));
    match parsed {
        Some(metadata) => MetadataRead::Ok(metadata),
        None => MetadataRead::Invalid,
    }
}

/// `ensureTaskWorkspace`. An existing task id and creation time are kept. The
/// `type` is always overwritten with `kind`, as in the source.
pub fn ensure_task_workspace(root: &Path, task_id: &str, kind: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(root)?;
    let dir = workspace_dir(root, task_id)?;
    fs::create_dir_all(dir.join("logs"))?;

    let existing = match read_metadata(&dir) {
        MetadataRead::Ok(metadata) => Some(metadata),
        _ => None,
    };
    let metadata = WorkspaceMetadata {
        task_id: existing
            .as_ref()
            .map_or_else(|| task_id.to_string(), |metadata| metadata.task_id.clone()),
        kind: kind.to_string(),
        created_at: existing
            .map(|metadata| metadata.created_at)
            .unwrap_or_else(now_iso),
        version: 1,
    };
    let content = serde_json::to_string_pretty(&metadata).map_err(io::Error::other)?;
    fs::write(dir.join(METADATA_FILENAME), content)?;
    Ok(dir)
}

/// `deleteTaskWorkspace`. Removes the directory of the task and every other
/// directory whose metadata names the task.
pub fn delete_task_workspace(root: &Path, task_id: &str) -> io::Result<()> {
    if !root.exists() {
        return Ok(());
    }
    let mut candidates = vec![workspace_dir(root, task_id)?];
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        if let MetadataRead::Ok(metadata) = read_metadata(&path) {
            if metadata.task_id == task_id && !candidates.contains(&path) {
                candidates.push(path);
            }
        }
    }
    for dir in candidates {
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
    }
    Ok(())
}

/// `cleanupOrphanTaskWorkspaces`. Directories of active tasks are kept. Directories
/// with missing or invalid metadata and dot directories are skipped. At most
/// `max_removals` directories are removed per call.
pub fn cleanup_orphan_task_workspaces<I, S>(
    root: &Path,
    active_task_ids: I,
    max_removals: usize,
) -> io::Result<CleanupReport>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut report = CleanupReport::default();
    if !root.exists() {
        return Ok(report);
    }
    let active: HashSet<String> = active_task_ids
        .into_iter()
        .map(|id| js_trim_owned(id.as_ref().to_string()))
        .filter(|id| !id.is_empty())
        .collect();

    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        report.scanned += 1;
        if entry.file_name().to_string_lossy().starts_with('.') {
            report.skipped += 1;
            report.reason_counts.protected += 1;
            continue;
        }
        let dir = entry.path();
        let metadata = match read_metadata(&dir) {
            MetadataRead::Ok(metadata) => metadata,
            MetadataRead::Missing => {
                report.skipped += 1;
                report.reason_counts.missing_metadata += 1;
                continue;
            }
            MetadataRead::Invalid => {
                report.skipped += 1;
                report.reason_counts.invalid_metadata += 1;
                continue;
            }
        };
        if active.contains(&metadata.task_id) {
            report.kept += 1;
            report.reason_counts.active_task += 1;
            continue;
        }
        if report.removed >= max_removals {
            report.skipped += 1;
            report.reason_counts.limit_reached += 1;
            continue;
        }
        match fs::remove_dir_all(&dir) {
            Ok(()) => report.removed += 1,
            Err(_) => {
                report.skipped += 1;
                report.reason_counts.remove_failed += 1;
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::test_support::temp_root;

    #[test]
    fn sanitizer_replaces_separators_and_strips_trailing_dots() {
        assert_eq!(sanitize_dir_name("a/b:c"), "a_b_c");
        assert_eq!(sanitize_dir_name("name. "), "name");
        assert_eq!(sanitize_dir_name("..."), "task-unknown");
        assert_eq!(sanitize_dir_name("   "), "task-unknown");
        assert_eq!(sanitize_dir_name("ctrl\u{1}x"), "ctrlx");
    }

    #[test]
    fn ensure_writes_metadata_and_keeps_identity_on_the_second_call() {
        let root = temp_root("ensure");
        let dir = ensure_task_workspace(&root, "task-1", "general").unwrap();
        assert!(dir.join("logs").is_dir());
        let first: Value =
            serde_json::from_str(&fs::read_to_string(dir.join(METADATA_FILENAME)).unwrap())
                .unwrap();
        assert_eq!(first["taskId"], "task-1");
        assert_eq!(first["type"], "general");
        assert_eq!(first["version"], 1);

        ensure_task_workspace(&root, "task-1", "deliverable").unwrap();
        let second: Value =
            serde_json::from_str(&fs::read_to_string(dir.join(METADATA_FILENAME)).unwrap())
                .unwrap();
        assert_eq!(second["createdAt"], first["createdAt"]);
        assert_eq!(second["type"], "deliverable");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn metadata_file_uses_the_two_space_layout_of_the_source() {
        let root = temp_root("layout");
        let dir = ensure_task_workspace(&root, "t", "general").unwrap();
        let raw = fs::read_to_string(dir.join(METADATA_FILENAME)).unwrap();
        assert!(
            raw.starts_with("{\n  \"taskId\": \"t\",\n  \"type\": \"general\",\n  \"createdAt\"")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_finds_the_directory_by_its_metadata_too() {
        let root = temp_root("delete");
        ensure_task_workspace(&root, "task-2", "general").unwrap();
        // A directory with another name that still names the task.
        let renamed = root.join("renamed-dir");
        fs::create_dir_all(&renamed).unwrap();
        fs::write(
            renamed.join(METADATA_FILENAME),
            r#"{"taskId":"task-2","type":"general","createdAt":"2026-01-01T00:00:00.000Z","version":1}"#,
        )
        .unwrap();
        let unrelated = ensure_task_workspace(&root, "task-3", "general").unwrap();

        delete_task_workspace(&root, "task-2").unwrap();
        assert!(!root.join("task-2").exists());
        assert!(!renamed.exists());
        assert!(unrelated.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_keeps_active_tasks_and_counts_each_reason() {
        let root = temp_root("cleanup");
        ensure_task_workspace(&root, "active", "general").unwrap();
        ensure_task_workspace(&root, "orphan", "general").unwrap();
        fs::create_dir_all(root.join("no-metadata")).unwrap();
        let invalid = root.join("invalid");
        fs::create_dir_all(&invalid).unwrap();
        fs::write(invalid.join(METADATA_FILENAME), "not json").unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();

        let report = cleanup_orphan_task_workspaces(&root, ["active"], 10).unwrap();
        assert_eq!(report.scanned, 5);
        assert_eq!(report.kept, 1);
        assert_eq!(report.removed, 1);
        assert_eq!(report.reason_counts.missing_metadata, 1);
        assert_eq!(report.reason_counts.invalid_metadata, 1);
        assert_eq!(report.reason_counts.protected, 1);
        assert!(root.join("active").exists());
        assert!(!root.join("orphan").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleanup_stops_removing_at_the_limit() {
        let root = temp_root("limit");
        for id in ["a", "b", "c"] {
            ensure_task_workspace(&root, id, "general").unwrap();
        }
        let report = cleanup_orphan_task_workspaces(&root, Vec::<String>::new(), 2).unwrap();
        assert_eq!(report.removed, 2);
        assert_eq!(report.reason_counts.limit_reached, 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_root_yields_an_empty_report() {
        let root = temp_root("absent");
        let report = cleanup_orphan_task_workspaces(&root, ["x"], 5).unwrap();
        assert_eq!(report, CleanupReport::default());
    }

    #[test]
    fn metadata_without_a_task_id_is_invalid() {
        assert!(normalize(&serde_json::json!({"taskId": "  "})).is_none());
        assert!(normalize(&serde_json::json!("text")).is_none());
        let metadata = normalize(&serde_json::json!({"taskId": 7, "createdAt": "nope"})).unwrap();
        assert_eq!(metadata.task_id, "7");
        assert_eq!(metadata.kind, "general");
    }
}
