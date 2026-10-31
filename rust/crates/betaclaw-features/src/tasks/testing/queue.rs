//! Port of the in-memory test queue of `src/server/tasks/testing/service.ts:175-231`
//! (`enqueueTaskTestJob`, `drainTaskTestQueue`) and of the body of `runTaskTestsNow`
//! (`service.ts:254-364`) that needs no browser. The check of one deliverable sits
//! behind [`DeliverableRunner`], because the Playwright runner is not in the workspace.

use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use serde_json::{json, Value};

use super::jobs::{self, COMPLETED, FAILED};
use super::summary::record_test_run;
use super::{DeliverableRef, TestResult};
use crate::tasks::deliverables::list_testable_deliverables;
use crate::tasks::repository::find_task;

/// The browser check of one deliverable (`testDeliverable`, `deliverableTester.ts`).
/// An `Err` fails the whole job with HTTP 500, as the drain's `catch` does in TS.
pub trait DeliverableRunner: Send + Sync {
    fn run(&self, deliverable: &DeliverableRef) -> Result<TestResult, String>;
}

/// `pendingTaskTestJobIds`: the ids of the queued jobs, in request order.
#[derive(Default)]
pub struct TestQueue {
    pending: Mutex<VecDeque<String>>,
}

impl TestQueue {
    /// `enqueueTaskTestJob`. The caller starts [`drain`] afterwards.
    pub fn enqueue(&self, job_id: &str) {
        self.lock().push_back(job_id.to_string());
    }

    fn next(&self) -> Option<String> {
        self.lock().pop_front()
    }

    fn lock(&self) -> MutexGuard<'_, VecDeque<String>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// `drainTaskTestQueue`: runs the queued jobs until the queue is empty. A job that is no
/// longer `queued` is skipped. The caller holds the connection, so drains run one at a time.
pub fn drain(
    connection: &Connection,
    queue: &TestQueue,
    runner: &dyn DeliverableRunner,
    clock: &dyn Fn() -> String,
) -> rusqlite::Result<()> {
    while let Some(job_id) = queue.next() {
        run_job(connection, runner, &job_id, clock)?;
    }
    Ok(())
}

fn run_job(
    connection: &Connection,
    runner: &dyn DeliverableRunner,
    job_id: &str,
    clock: &dyn Fn() -> String,
) -> rusqlite::Result<()> {
    let Some(job) = jobs::job_by_id(connection, job_id)? else {
        return Ok(());
    };
    if job.status != jobs::QUEUED {
        return Ok(());
    }
    jobs::mark_running(connection, job_id, &clock())?;
    let (http_status, body) = run_tests(connection, runner, &job.task_id, clock)?;
    let completed = (200..300).contains(&http_status);
    let error = (!completed).then(|| {
        body["error"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map_or_else(
                || format!("Task test job failed with HTTP {http_status}"),
                str::to_string,
            )
    });
    jobs::mark_terminal(
        connection,
        job_id,
        if completed { COMPLETED } else { FAILED },
        http_status,
        Some(&body),
        error.as_deref(),
        &clock(),
    )
}

/// What `runTaskTestsNow` answers: the HTTP status and the JSON body.
fn run_tests(
    connection: &Connection,
    runner: &dyn DeliverableRunner,
    task_id: &str,
    clock: &dyn Fn() -> String,
) -> rusqlite::Result<(i64, Value)> {
    let Some(task) = find_task(connection, task_id)? else {
        return Ok((404, json!({ "error": "Task not found" })));
    };
    let deliverables = list_testable_deliverables(connection, task_id)?;
    if deliverables.is_empty() {
        return Ok((
            400,
            json!({ "error": "No testable deliverables found (file or url types)" }),
        ));
    }
    let mut results = Vec::with_capacity(deliverables.len());
    for deliverable in &deliverables {
        let reference = DeliverableRef {
            id: deliverable.id.clone(),
            title: deliverable.title.clone(),
            path: deliverable.path.clone().unwrap_or_default(),
            kind: deliverable.deliverable_type.clone(),
        };
        match runner.run(&reference) {
            Ok(result) => results.push(result),
            Err(message) => return Ok((500, json!({ "error": message }))),
        }
    }
    let outcome = record_test_run(connection, task_id, &results, &clock())?;
    Ok((
        200,
        json!({
            "taskId": task_id,
            "taskTitle": task.title,
            "passed": outcome.passed,
            "results": results.iter().map(result_json).collect::<Vec<_>>(),
            "summary": outcome.summary,
            "testedAt": clock(),
            "newStatus": outcome.new_status,
        }),
    ))
}

/// One result as `TestResponse.results` carries it (`types.ts:13-29`), with the fields
/// that the Rust [`TestResult`] keeps.
fn result_json(result: &TestResult) -> Value {
    json!({
        "deliverable": {
            "id": result.deliverable.id,
            "title": result.deliverable.title,
            "path": result.deliverable.path,
            "type": result.deliverable.kind,
        },
        "passed": result.passed,
        "consoleErrors": result.console_errors,
        "cssErrors": result.css_errors,
        "resourceErrors": result.resource_errors,
        "screenshotPath": result.screenshot_path,
    })
}

#[cfg(test)]
mod tests {
    use super::super::jobs::{create_job, job_by_id, request_job};
    use super::*;
    use crate::tasks::test_support::{insert_task, memory_connection, FIXED_TIME};
    use rusqlite::params;

    /// Passes or fails every deliverable, or fails the run with `error`.
    struct FakeRunner {
        passed: bool,
        error: Option<&'static str>,
    }

    impl DeliverableRunner for FakeRunner {
        fn run(&self, deliverable: &DeliverableRef) -> Result<TestResult, String> {
            if let Some(message) = self.error {
                return Err(message.to_string());
            }
            Ok(TestResult {
                passed: self.passed,
                deliverable: deliverable.clone(),
                console_errors: if self.passed {
                    Vec::new()
                } else {
                    vec!["boom".to_string()]
                },
                css_errors: Vec::new(),
                resource_errors: Vec::new(),
                screenshot_path: None,
            })
        }
    }

    fn add_deliverable(connection: &Connection, task_id: &str, kind: &str) {
        connection
            .execute(
                "INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path)
                 VALUES (?, ?, ?, 'Shop', '/out/shop.html')",
                params![format!("d-{task_id}-{kind}"), task_id, kind],
            )
            .expect("insert deliverable");
    }

    fn run_queued(connection: &Connection, job_id: &str, runner: &dyn DeliverableRunner) {
        let queue = TestQueue::default();
        queue.enqueue(job_id);
        drain(connection, &queue, runner, &|| FIXED_TIME.to_string()).expect("drain");
    }

    fn task_status(connection: &Connection, task_id: &str) -> String {
        connection
            .query_row("SELECT status FROM tasks WHERE id = ?", [task_id], |row| {
                row.get(0)
            })
            .expect("task status")
    }

    #[test]
    fn a_queued_job_runs_and_a_later_request_is_not_deduplicated() {
        let connection = memory_connection();
        insert_task(&connection, "task-1", "Shop", "testing", None);
        add_deliverable(&connection, "task-1", "file");
        let job = request_job(&connection, "task-1", FIXED_TIME).unwrap().job;

        run_queued(
            &connection,
            &job.id,
            &FakeRunner {
                passed: true,
                error: None,
            },
        );

        let done = job_by_id(&connection, &job.id).unwrap().unwrap();
        assert_eq!(done.status, COMPLETED);
        assert_eq!(done.http_status, Some(200));
        assert_eq!(done.result.unwrap()["passed"], true);
        assert_eq!(task_status(&connection, "task-1"), "review");
        let next = request_job(&connection, "task-1", FIXED_TIME).unwrap();
        assert!(!next.deduplicated);
    }

    #[test]
    fn a_failed_check_completes_the_job_and_sends_the_task_back() {
        let connection = memory_connection();
        insert_task(&connection, "task-2", "Shop", "testing", None);
        add_deliverable(&connection, "task-2", "url");
        let job = request_job(&connection, "task-2", FIXED_TIME).unwrap().job;

        run_queued(
            &connection,
            &job.id,
            &FakeRunner {
                passed: false,
                error: None,
            },
        );

        let done = job_by_id(&connection, &job.id).unwrap().unwrap();
        assert_eq!(done.status, COMPLETED);
        assert_eq!(done.result.unwrap()["passed"], false);
        assert_eq!(task_status(&connection, "task-2"), "assigned");
    }

    #[test]
    fn a_missing_task_or_no_file_or_url_deliverable_fails_the_job() {
        let connection = memory_connection();
        insert_task(&connection, "task-3", "Shop", "testing", None);
        add_deliverable(&connection, "task-3", "artifact");
        let no_deliverable = request_job(&connection, "task-3", FIXED_TIME).unwrap().job;
        let missing = create_job(&connection, "ghost", FIXED_TIME).unwrap();
        let runner = FakeRunner {
            passed: true,
            error: None,
        };

        run_queued(&connection, &no_deliverable.id, &runner);
        run_queued(&connection, &missing.id, &runner);

        let failed = job_by_id(&connection, &no_deliverable.id).unwrap().unwrap();
        assert_eq!(failed.status, FAILED);
        assert_eq!(failed.http_status, Some(400));
        assert_eq!(
            failed.error_message.as_deref(),
            Some("No testable deliverables found (file or url types)")
        );
        let gone = job_by_id(&connection, &missing.id).unwrap().unwrap();
        assert_eq!(gone.http_status, Some(404));
        assert_eq!(gone.error_message.as_deref(), Some("Task not found"));
        assert_eq!(task_status(&connection, "task-3"), "testing");
    }

    #[test]
    fn a_runner_error_fails_the_job_and_leaves_the_task_alone() {
        let connection = memory_connection();
        insert_task(&connection, "task-4", "Shop", "testing", None);
        add_deliverable(&connection, "task-4", "file");
        let job = request_job(&connection, "task-4", FIXED_TIME).unwrap().job;

        run_queued(
            &connection,
            &job.id,
            &FakeRunner {
                passed: true,
                error: Some("browser missing"),
            },
        );

        let failed = job_by_id(&connection, &job.id).unwrap().unwrap();
        assert_eq!(failed.status, FAILED);
        assert_eq!(failed.http_status, Some(500));
        assert_eq!(failed.error_message.as_deref(), Some("browser missing"));
        assert_eq!(task_status(&connection, "task-4"), "testing");
        assert!(
            !request_job(&connection, "task-4", FIXED_TIME)
                .unwrap()
                .deduplicated
        );
    }
}
