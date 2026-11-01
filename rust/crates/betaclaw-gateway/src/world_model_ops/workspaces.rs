//! `betaclaw-scheduler workspaces-cleanup [--json]` replaces
//! `pnpm run workspaces:cleanup` and `pnpm run workspaces:cleanup:json`
//! (`scripts/cleanup-task-workspaces.ts`).
//!
//! It reads the ids of all tasks of mission-control.db (`DATABASE_PATH`) and removes
//! the task workspace directories that no task owns, with the removal rules of
//! `betaclaw_features::tasks::workspace::cleanup_orphan_task_workspaces`. The root and
//! the removal limit come from `TASK_WORKSPACES_ROOT` and
//! `TASK_WORKSPACES_CLEANUP_MAX_REMOVALS_PER_RUN`, as in the script.

use betaclaw_core::tasks::workspace::{
    cleanup_orphan_task_workspaces, resolve_cleanup_max_removals, resolve_root, CleanupReport,
};
use rusqlite::Connection;
use serde_json::{json, Value};

use super::mission_control_path;
use super::reconcile::open_readonly;

/// The flags (`parseArgs`, `cleanup-task-workspaces.ts:9-13`). Only `--json` exists.
pub fn wants_json(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--json")
}

/// `SELECT id FROM tasks`, read through the same file the script's `queryAll` opens.
pub fn active_task_ids() -> Result<Vec<String>, String> {
    let connection: Connection = open_readonly(&mission_control_path())?;
    let mut statement = connection
        .prepare("SELECT id FROM tasks")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

/// The JSON of `console.log(JSON.stringify({ activeTaskCount, ...report }, null, 2))`.
pub fn report_json(active_task_count: usize, report: &CleanupReport) -> Value {
    json!({
        "activeTaskCount": active_task_count,
        "scanned": report.scanned,
        "removed": report.removed,
        "kept": report.kept,
        "skipped": report.skipped,
        "reasonCounts": {
            "activeTask": report.reason_counts.active_task,
            "missingMetadata": report.reason_counts.missing_metadata,
            "invalidMetadata": report.reason_counts.invalid_metadata,
            "protected": report.reason_counts.protected,
            "limitReached": report.reason_counts.limit_reached,
            "removeFailed": report.reason_counts.remove_failed,
        },
    })
}

/// The lines of the text report of the script.
pub fn report_lines(active_task_count: usize, report: &CleanupReport) -> Vec<String> {
    let json = report_json(active_task_count, report);
    vec![
        "[cleanup-task-workspaces]".to_string(),
        format!("  activeTaskCount: {active_task_count}"),
        format!("  scanned: {}", report.scanned),
        format!("  removed: {}", report.removed),
        format!("  kept: {}", report.kept),
        format!("  skipped: {}", report.skipped),
        format!("  reasonCounts: {}", json["reasonCounts"]),
    ]
}

/// Runs the cleanup. Returns the exit status.
pub async fn run(args: &[String]) -> i32 {
    match run_inner(wants_json(args)) {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    }
}

fn run_inner(json_output: bool) -> Result<(), String> {
    let ids = active_task_ids()?;
    let report =
        cleanup_orphan_task_workspaces(&resolve_root(), ids.iter(), resolve_cleanup_max_removals())
            .map_err(|error| error.to_string())?;
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&report_json(ids.len(), &report)).unwrap_or_default()
        );
    } else {
        for line in report_lines(ids.len(), &report) {
            println!("{line}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use betaclaw_core::tasks::workspace::{CleanupReasonCounts, CleanupReport};

    fn sample() -> CleanupReport {
        CleanupReport {
            scanned: 4,
            removed: 1,
            kept: 2,
            skipped: 1,
            reason_counts: CleanupReasonCounts {
                active_task: 2,
                missing_metadata: 1,
                ..CleanupReasonCounts::default()
            },
        }
    }

    #[test]
    fn json_is_the_script_report_with_the_task_count_first() {
        assert!(wants_json(&["--json".to_string()]));
        assert!(!wants_json(&[]));
        let json = report_json(3, &sample());
        let keys: Vec<&str> = json
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "activeTaskCount",
                "scanned",
                "removed",
                "kept",
                "skipped",
                "reasonCounts"
            ]
        );
        assert_eq!(json["reasonCounts"]["activeTask"], 2);
        assert_eq!(json["reasonCounts"]["limitReached"], 0);
    }

    #[test]
    fn the_text_report_has_the_script_lines() {
        let lines = report_lines(3, &sample());
        assert_eq!(lines[0], "[cleanup-task-workspaces]");
        assert_eq!(lines[1], "  activeTaskCount: 3");
        assert_eq!(lines[3], "  removed: 1");
        assert!(lines[6].starts_with("  reasonCounts: {\"activeTask\":2"));
    }

    #[test]
    fn a_missing_mission_control_file_is_an_error() {
        let previous = std::env::var("DATABASE_PATH").ok();
        std::env::set_var("DATABASE_PATH", "does-not-exist/mission-control.db");
        assert!(active_task_ids().is_err());
        match previous {
            Some(value) => std::env::set_var("DATABASE_PATH", value),
            None => std::env::remove_var("DATABASE_PATH"),
        }
    }
}
