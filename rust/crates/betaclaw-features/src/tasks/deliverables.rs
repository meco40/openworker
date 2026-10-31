//! Port of `ensureTaskDeliverablesFromProjectDir` and its helpers in
//! `src/server/tasks/autoTesting.ts:8-158`, and of the slug rule that
//! `buildTaskProjectSlug` and `buildProjectDirectory` (`dispatch/prepareDispatch.ts:14-19`)
//! share.
//!
//! Only the registration with an explicit project directory is ported. Its only
//! caller passes `taskProjectDir`, so the fallback to `getProjectsPath()` is not
//! needed here. The HTTP trigger `triggerAutomatedTaskTest` is not ported.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, Row};
use uuid::Uuid;

use super::types::TaskDeliverable;

const MAX_DISCOVERED_HTML_FILES: usize = 20;
const AUTO_REGISTERED_DESCRIPTION: &str = "Auto-registered from task output directory";

/// The result of `ensureTaskDeliverablesFromProjectDir`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RegistrationCount {
    pub existing: usize,
    pub added: usize,
    pub total: usize,
}

/// Lower-case, every run of other characters becomes one `-`, and no `-` at either end.
pub fn project_slug(title: &str) -> String {
    let lowered = title.to_lowercase();
    let mut slug = String::new();
    for run in lowered
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|run| !run.is_empty())
    {
        if !slug.is_empty() {
            slug.push('-');
        }
        slug.push_str(run);
    }
    slug
}

/// `expandHomePath`: a leading `~` followed by the end or a separator becomes the home directory.
pub fn expand_home_path(input: &str) -> String {
    let home = std::env::var("HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .unwrap_or_default();
    if home.is_empty() {
        return input.to_string();
    }
    match input.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => format!("{home}{rest}"),
        _ => input.to_string(),
    }
}

fn is_html_name(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    lowered.ends_with(".html") || lowered.ends_with(".htm")
}

/// `discoverHtmlFiles`: a depth-first walk that stops at 20 files. Entries are
/// visited in name order, which is the order libuv gives on POSIX.
fn discover_html_files(root: &Path) -> Vec<PathBuf> {
    let mut results = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while results.len() < MAX_DISCOVERED_HTML_FILES {
        let Some(current) = stack.pop() else {
            break;
        };
        let Ok(read) = fs::read_dir(&current) else {
            continue;
        };
        let mut entries: Vec<(String, PathBuf, bool)> = read
            .filter_map(Result::ok)
            .map(|entry| {
                let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    entry.path(),
                    is_dir,
                )
            })
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, path, is_dir) in entries {
            if is_dir {
                stack.push(path);
            } else if is_html_name(&name) {
                results.push(path);
                if results.len() >= MAX_DISCOVERED_HTML_FILES {
                    break;
                }
            }
        }
    }
    results
}

/// `ensureTaskDeliverablesFromProjectDir`. Registers the HTML files of the project
/// directory, unless the task already has deliverables.
pub fn ensure_from_project_dir(
    connection: &Connection,
    task_id: &str,
    project_dir: &str,
    now: &str,
) -> rusqlite::Result<RegistrationCount> {
    let existing: i64 = connection.query_row(
        "SELECT COUNT(*) FROM task_deliverables WHERE task_id = ?",
        [task_id],
        |row| row.get(0),
    )?;
    if existing > 0 {
        let existing = existing as usize;
        return Ok(RegistrationCount {
            existing,
            added: 0,
            total: existing,
        });
    }

    let resolved = PathBuf::from(expand_home_path(project_dir));
    if !resolved.exists() {
        return Ok(RegistrationCount::default());
    }
    let files = discover_html_files(&resolved);
    for file in &files {
        let title = file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        connection.execute(
            "INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, created_at)
             VALUES (?, ?, 'file', ?, ?, ?, ?)",
            params![
                Uuid::new_v4().to_string(),
                task_id,
                title,
                file.to_string_lossy().into_owned(),
                AUTO_REGISTERED_DESCRIPTION,
                now
            ],
        )?;
    }
    Ok(RegistrationCount {
        existing: 0,
        added: files.len(),
        total: files.len(),
    })
}

fn deliverable_from_row(row: &Row<'_>) -> rusqlite::Result<TaskDeliverable> {
    Ok(TaskDeliverable {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        deliverable_type: row.get("deliverable_type")?,
        title: row.get("title")?,
        path: row.get("path")?,
        description: row.get("description")?,
        created_at: row.get("created_at")?,
    })
}

/// The deliverables that the test run covers: `file` and `url` types.
pub fn list_testable_deliverables(
    connection: &Connection,
    task_id: &str,
) -> rusqlite::Result<Vec<TaskDeliverable>> {
    let mut statement = connection.prepare(
        "SELECT * FROM task_deliverables WHERE task_id = ? AND deliverable_type IN ('file', 'url')",
    )?;
    let rows = statement.query_map([task_id], deliverable_from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::test_support::{insert_agent, insert_task, memory_connection, temp_root};

    #[test]
    fn slug_collapses_runs_and_trims_the_ends() {
        assert_eq!(project_slug("Hello, World!"), "hello-world");
        assert_eq!(project_slug("  --A--  "), "a");
        assert_eq!(project_slug("Ä b"), "b");
        assert_eq!(project_slug("!!!"), "");
    }

    #[test]
    fn home_expansion_needs_a_bare_or_separated_tilde() {
        assert_eq!(expand_home_path("~x/y"), "~x/y");
        assert_eq!(expand_home_path("a/~/b"), "a/~/b");
        assert_eq!(expand_home_path("/plain/path"), "/plain/path");
    }

    #[test]
    fn registers_html_files_once_and_caps_the_count() {
        let connection = memory_connection();
        insert_agent(&connection, "agent-1", "Builder", false, "standby");
        insert_task(&connection, "task-1", "Site", "assigned", None);
        let root = temp_root("deliverables");
        fs::create_dir_all(root.join("sub")).unwrap();
        for index in 0..25 {
            fs::write(root.join(format!("page-{index:02}.html")), "<html/>").unwrap();
        }
        fs::write(root.join("notes.txt"), "text").unwrap();
        fs::write(root.join("sub").join("CAPS.HTM"), "<html/>").unwrap();

        let directory = root.to_string_lossy().into_owned();
        let first = ensure_from_project_dir(
            &connection,
            "task-1",
            &directory,
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!(first.added, 20);
        assert_eq!(first.total, 20);

        let second = ensure_from_project_dir(
            &connection,
            "task-1",
            &directory,
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            second,
            RegistrationCount {
                existing: 20,
                added: 0,
                total: 20
            }
        );

        let listed = list_testable_deliverables(&connection, "task-1").unwrap();
        assert_eq!(listed.len(), 20);
        assert!(listed.iter().all(|d| d.deliverable_type == "file"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_directory_registers_nothing() {
        let connection = memory_connection();
        insert_task(&connection, "task-2", "Site", "assigned", None);
        let root = temp_root("absent");
        let count = ensure_from_project_dir(
            &connection,
            "task-2",
            &root.to_string_lossy(),
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!(count, RegistrationCount::default());
    }

    #[test]
    fn testable_list_returns_file_and_url_rows_only() {
        let connection = memory_connection();
        insert_task(&connection, "task-3", "Site", "testing", None);
        for (id, kind) in [("d1", "file"), ("d2", "url"), ("d3", "artifact")] {
            connection
                .execute(
                    "INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
                     VALUES (?, 'task-3', ?, 'x', '2026-01-01T00:00:00.000Z')",
                    params![id, kind],
                )
                .unwrap();
        }
        let listed = list_testable_deliverables(&connection, "task-3").unwrap();
        let kinds: Vec<&str> = listed.iter().map(|d| d.deliverable_type.as_str()).collect();
        assert_eq!(kinds, ["file", "url"]);
    }
}
