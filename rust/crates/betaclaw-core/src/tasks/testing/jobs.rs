//! Port of the `task_test_jobs` repository of `src/server/tasks/testing/service.ts`
//! (`ensureTaskTestJobsTable`, `createTaskTestJob`, `markTaskTestJobRunning`,
//! `markTaskTestJobTerminal`, the lookups and the dedupe of `runTaskTests`).
//!
//! The table is created lazily, as in the source, on the first read or create.
//! The queue and its drain are in `queue.rs`. The caller enqueues a job when
//! `request_job` reports `deduplicated: false`.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use uuid::Uuid;

use crate::tasks::{js_trim, non_empty};

pub const QUEUED: &str = "queued";
pub const RUNNING: &str = "running";
pub const COMPLETED: &str = "completed";
pub const FAILED: &str = "failed";

const TABLE_DDL: &str = "
    CREATE TABLE IF NOT EXISTS task_test_jobs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      http_status INTEGER,
      error_message TEXT,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_test_jobs_task_requested
      ON task_test_jobs(task_id, requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_test_jobs_status_requested
      ON task_test_jobs(status, requested_at ASC);
";

/// `TaskTestJob` (`src/server/tasks/testing/types.ts:41-53`).
#[derive(Debug, Clone, PartialEq)]
pub struct TestJob {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub requested_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub http_status: Option<i64>,
    pub error_message: Option<String>,
    pub result: Option<Value>,
}

/// The answer of `runTaskTests` before the HTTP response is built.
#[derive(Debug, Clone, PartialEq)]
pub struct JobRequest {
    pub deduplicated: bool,
    pub job: TestJob,
}

fn ensure_table(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(TABLE_DDL)
}

fn job_from_row(row: &Row<'_>) -> rusqlite::Result<TestJob> {
    // `JSON.parse` of a non-blank `result_json`, or `null` when it does not parse.
    let result = row
        .get::<_, Option<String>>("result_json")?
        .filter(|text| !js_trim(text).is_empty())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    Ok(TestJob {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        status: row.get("status")?,
        requested_at: row.get("requested_at")?,
        started_at: non_empty(row.get::<_, Option<String>>("started_at")?.as_deref())
            .map(str::to_string),
        finished_at: non_empty(row.get::<_, Option<String>>("finished_at")?.as_deref())
            .map(str::to_string),
        http_status: row.get("http_status")?,
        error_message: non_empty(row.get::<_, Option<String>>("error_message")?.as_deref())
            .map(str::to_string),
        result,
    })
}

pub fn job_by_id(connection: &Connection, job_id: &str) -> rusqlite::Result<Option<TestJob>> {
    ensure_table(connection)?;
    connection
        .query_row(
            "SELECT * FROM task_test_jobs WHERE id = ?",
            [job_id],
            job_from_row,
        )
        .optional()
}

/// The job `job_id` when it belongs to `task_id`.
pub fn job_for_task(
    connection: &Connection,
    task_id: &str,
    job_id: &str,
) -> rusqlite::Result<Option<TestJob>> {
    ensure_table(connection)?;
    connection
        .query_row(
            "SELECT * FROM task_test_jobs WHERE id = ? AND task_id = ?",
            params![job_id, task_id],
            job_from_row,
        )
        .optional()
}

/// The newest job of the task, whatever its status.
pub fn latest_job(connection: &Connection, task_id: &str) -> rusqlite::Result<Option<TestJob>> {
    ensure_table(connection)?;
    connection
        .query_row(
            "SELECT * FROM task_test_jobs WHERE task_id = ? ORDER BY requested_at DESC LIMIT 1",
            [task_id],
            job_from_row,
        )
        .optional()
}

/// The newest job of the task that is still queued or running.
pub fn active_job(connection: &Connection, task_id: &str) -> rusqlite::Result<Option<TestJob>> {
    ensure_table(connection)?;
    connection
        .query_row(
            "SELECT * FROM task_test_jobs
             WHERE task_id = ? AND status IN ('queued', 'running')
             ORDER BY requested_at DESC LIMIT 1",
            [task_id],
            job_from_row,
        )
        .optional()
}

/// `createTaskTestJob`: a new queued job.
pub fn create_job(connection: &Connection, task_id: &str, now: &str) -> rusqlite::Result<TestJob> {
    ensure_table(connection)?;
    let job_id = Uuid::new_v4().to_string();
    connection.execute(
        "INSERT INTO task_test_jobs (id, task_id, status, requested_at, started_at, finished_at, http_status, error_message, result_json)
         VALUES (?, ?, 'queued', ?, NULL, NULL, NULL, NULL, NULL)",
        params![job_id, task_id, now],
    )?;
    job_by_id(connection, &job_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// `runTaskTests`: returns the active job when there is one, otherwise a new queued job.
pub fn request_job(
    connection: &Connection,
    task_id: &str,
    now: &str,
) -> rusqlite::Result<JobRequest> {
    if let Some(job) = active_job(connection, task_id)? {
        return Ok(JobRequest {
            deduplicated: true,
            job,
        });
    }
    let job = create_job(connection, task_id, now)?;
    Ok(JobRequest {
        deduplicated: false,
        job,
    })
}

/// `markTaskTestJobRunning`.
pub fn mark_running(connection: &Connection, job_id: &str, now: &str) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE task_test_jobs SET status = 'running', started_at = ? WHERE id = ?",
        params![now, job_id],
    )?;
    Ok(())
}

/// `markTaskTestJobTerminal`. An empty error message is stored as `NULL`.
pub fn mark_terminal(
    connection: &Connection,
    job_id: &str,
    status: &str,
    http_status: i64,
    result: Option<&Value>,
    error_message: Option<&str>,
    now: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE task_test_jobs
         SET status = ?, finished_at = ?, http_status = ?, error_message = ?, result_json = ?
         WHERE id = ?",
        params![
            status,
            now,
            http_status,
            non_empty(error_message),
            result.map(Value::to_string),
            job_id
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::test_support::memory_connection;
    use serde_json::json;

    #[test]
    fn a_second_request_while_one_is_active_is_deduplicated() {
        let connection = memory_connection();
        let first = request_job(&connection, "task-1", "2026-01-01T00:00:00.000Z").unwrap();
        assert!(!first.deduplicated);
        assert_eq!(first.job.status, QUEUED);

        let second = request_job(&connection, "task-1", "2026-01-01T00:00:01.000Z").unwrap();
        assert!(second.deduplicated);
        assert_eq!(second.job.id, first.job.id);
    }

    #[test]
    fn running_then_completed_keeps_the_result_and_drops_an_empty_error() {
        let connection = memory_connection();
        let job = create_job(&connection, "task-2", "2026-01-01T00:00:00.000Z").unwrap();
        mark_running(&connection, &job.id, "2026-01-01T00:00:02.000Z").unwrap();
        let running = job_by_id(&connection, &job.id).unwrap().unwrap();
        assert_eq!(running.status, RUNNING);
        assert_eq!(
            running.started_at.as_deref(),
            Some("2026-01-01T00:00:02.000Z")
        );

        let result = json!({"taskId": "task-2", "passed": true});
        mark_terminal(
            &connection,
            &job.id,
            COMPLETED,
            200,
            Some(&result),
            Some(""),
            "2026-01-01T00:00:03.000Z",
        )
        .unwrap();
        let done = job_for_task(&connection, "task-2", &job.id)
            .unwrap()
            .unwrap();
        assert_eq!(done.status, COMPLETED);
        assert_eq!(done.http_status, Some(200));
        assert_eq!(done.result, Some(result));
        assert_eq!(done.error_message, None);
        assert_eq!(
            done.finished_at.as_deref(),
            Some("2026-01-01T00:00:03.000Z")
        );
    }

    #[test]
    fn a_finished_job_no_longer_blocks_a_new_request() {
        let connection = memory_connection();
        let first = create_job(&connection, "task-3", "2026-01-01T00:00:00.000Z").unwrap();
        mark_terminal(
            &connection,
            &first.id,
            FAILED,
            500,
            None,
            Some("boom"),
            "2026-01-01T00:00:01.000Z",
        )
        .unwrap();
        assert!(active_job(&connection, "task-3").unwrap().is_none());

        let next = request_job(&connection, "task-3", "2026-01-01T00:00:02.000Z").unwrap();
        assert!(!next.deduplicated);
        let latest = latest_job(&connection, "task-3").unwrap().unwrap();
        assert_eq!(latest.id, next.job.id);
    }

    #[test]
    fn a_job_is_only_found_under_its_own_task() {
        let connection = memory_connection();
        let job = create_job(&connection, "task-4", "2026-01-01T00:00:00.000Z").unwrap();
        assert!(job_for_task(&connection, "other-task", &job.id)
            .unwrap()
            .is_none());
        assert!(job_by_id(&connection, "missing").unwrap().is_none());
    }
}
