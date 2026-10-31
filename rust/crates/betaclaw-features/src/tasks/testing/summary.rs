//! Port of the result handling of `runTaskTestsNow` in
//! `src/server/tasks/testing/service.ts:266-347`: the summary text, the activity
//! and its metadata, and the status that follows a pass or a failure.

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use uuid::Uuid;

use super::TestResult;

/// The outcome of one test run, as written to the activity log and the task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestOutcome {
    pub passed: bool,
    pub summary: String,
    pub activity_type: &'static str,
    pub activity_message: String,
    pub new_status: &'static str,
    pub status_message: &'static str,
}

/// `summarize`: the pass rule is "every deliverable passed". A pass moves the
/// task to `review`, a failure moves it back to `assigned`.
pub fn summarize(results: &[TestResult]) -> TestOutcome {
    let passed = results.iter().all(|result| result.passed);
    let total = results.len();
    let summary = if passed {
        format!(
            "All {total} deliverable(s) passed automated testing. No console errors, CSS errors, or broken resources detected."
        )
    } else {
        let failed = results.iter().filter(|result| !result.passed).count();
        let issues: Vec<String> = results
            .iter()
            .filter(|result| !result.passed)
            .map(|result| {
                let mut kinds = Vec::new();
                if !result.console_errors.is_empty() {
                    kinds.push(format!("{} JS errors", result.console_errors.len()));
                }
                if !result.css_errors.is_empty() {
                    kinds.push(format!("{} CSS errors", result.css_errors.len()));
                }
                if !result.resource_errors.is_empty() {
                    kinds.push(format!("{} broken resources", result.resource_errors.len()));
                }
                format!("{}: {}", result.deliverable.title, kinds.join(", "))
            })
            .collect();
        format!(
            "{failed}/{total} deliverable(s) failed. Issues: {}",
            issues.join("; ")
        )
    };

    if passed {
        TestOutcome {
            passed,
            activity_type: "test_passed",
            activity_message: format!(
                "Automated test passed - {total} deliverable(s) verified, no issues found"
            ),
            new_status: "review",
            status_message:
                "Task moved to REVIEW - automated tests passed, awaiting human approval",
            summary,
        }
    } else {
        TestOutcome {
            passed,
            activity_type: "test_failed",
            activity_message: format!("Automated test failed - {summary}"),
            new_status: "assigned",
            status_message: "Task moved back to ASSIGNED due to failed automated tests - agent needs to fix issues",
            summary,
        }
    }
}

/// The `metadata` of the activity: one entry per deliverable with the problem counts.
pub fn activity_metadata(results: &[TestResult]) -> Value {
    let entries: Vec<Value> = results
        .iter()
        .map(|result| {
            json!({
                "deliverable": result.deliverable.title,
                "type": result.deliverable.kind,
                "passed": result.passed,
                "consoleErrors": result.console_errors.len(),
                "cssErrors": result.css_errors.len(),
                "resourceErrors": result.resource_errors.len(),
                "screenshot": result.screenshot_path,
            })
        })
        .collect();
    json!({ "results": entries })
}

/// Writes the test activity, moves the task and logs the status change.
pub fn record_test_run(
    connection: &Connection,
    task_id: &str,
    results: &[TestResult],
    now: &str,
) -> rusqlite::Result<TestOutcome> {
    let outcome = summarize(results);
    connection.execute(
        "INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            Uuid::new_v4().to_string(),
            task_id,
            outcome.activity_type,
            outcome.activity_message,
            activity_metadata(results).to_string(),
            now
        ],
    )?;
    connection.execute(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
        params![outcome.new_status, now, task_id],
    )?;
    connection.execute(
        "INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
         VALUES (?, ?, 'status_changed', ?, ?)",
        params![
            Uuid::new_v4().to_string(),
            task_id,
            outcome.status_message,
            now
        ],
    )?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::super::DeliverableRef;
    use super::*;
    use crate::tasks::test_support::{insert_task, memory_connection};

    fn result(title: &str, passed: bool, console: usize, resources: usize) -> TestResult {
        TestResult {
            passed,
            deliverable: DeliverableRef {
                id: format!("d-{title}"),
                title: title.to_string(),
                path: format!("/out/{title}.html"),
                kind: "file".to_string(),
            },
            console_errors: vec!["boom".to_string(); console],
            css_errors: Vec::new(),
            resource_errors: vec!["404".to_string(); resources],
            screenshot_path: None,
        }
    }

    #[test]
    fn all_passing_moves_to_review_with_the_fixed_texts() {
        let outcome = summarize(&[result("index", true, 0, 0), result("about", true, 0, 0)]);
        assert!(outcome.passed);
        assert_eq!(outcome.new_status, "review");
        assert_eq!(outcome.activity_type, "test_passed");
        assert_eq!(
            outcome.activity_message,
            "Automated test passed - 2 deliverable(s) verified, no issues found"
        );
        assert_eq!(
            outcome.summary,
            "All 2 deliverable(s) passed automated testing. No console errors, CSS errors, or broken resources detected."
        );
    }

    #[test]
    fn a_failure_lists_the_problems_per_deliverable() {
        let outcome = summarize(&[
            result("index", true, 0, 0),
            result("shop", false, 1, 2),
            result("blog", false, 0, 1),
        ]);
        assert!(!outcome.passed);
        assert_eq!(outcome.new_status, "assigned");
        assert_eq!(
            outcome.summary,
            "2/3 deliverable(s) failed. Issues: shop: 1 JS errors, 2 broken resources; blog: 1 broken resources"
        );
        assert_eq!(
            outcome.activity_message,
            format!("Automated test failed - {}", outcome.summary)
        );
    }

    #[test]
    fn metadata_counts_each_kind_of_problem() {
        let metadata = activity_metadata(&[result("shop", false, 1, 2)]);
        assert_eq!(metadata["results"][0]["consoleErrors"], 1);
        assert_eq!(metadata["results"][0]["resourceErrors"], 2);
        assert_eq!(metadata["results"][0]["cssErrors"], 0);
        assert_eq!(metadata["results"][0]["screenshot"], Value::Null);
    }

    #[test]
    fn record_writes_the_activity_and_moves_the_task() {
        let connection = memory_connection();
        insert_task(&connection, "task-7", "Shop", "testing", None);
        let outcome = record_test_run(
            &connection,
            "task-7",
            &[result("shop", false, 1, 0)],
            "2026-01-01T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!(outcome.new_status, "assigned");

        let status: String = connection
            .query_row("SELECT status FROM tasks WHERE id = 'task-7'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "assigned");
        let logged: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM task_activities WHERE task_id = 'task-7' AND activity_type IN ('test_failed', 'status_changed')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(logged, 2);
    }
}
