import { NextResponse } from 'next/server';
import { chromium } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import type { Task, TaskDeliverable } from '@/lib/types';
import { ensureScreenshotsDirExists, testDeliverable } from './deliverableTester';
import type { TaskTestJob, TaskTestJobStatus, TestResponse, TestResult } from './types';

const TASK_TEST_JOBS_TABLE = 'task_test_jobs';
const pendingTaskTestJobIds: string[] = [];
let drainingTaskTestQueue = false;

function ensureTaskTestJobsTable(): void {
  run(`
    CREATE TABLE IF NOT EXISTS ${TASK_TEST_JOBS_TABLE} (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      http_status INTEGER,
      error_message TEXT,
      result_json TEXT
    )
  `);
  run(`
    CREATE INDEX IF NOT EXISTS idx_task_test_jobs_task_requested
      ON ${TASK_TEST_JOBS_TABLE}(task_id, requested_at DESC)
  `);
  run(`
    CREATE INDEX IF NOT EXISTS idx_task_test_jobs_status_requested
      ON ${TASK_TEST_JOBS_TABLE}(status, requested_at ASC)
  `);
}

function toTaskTestJob(row: Record<string, unknown>): TaskTestJob {
  let parsedResult: TaskTestJob['result'] = null;
  if (typeof row.result_json === 'string' && row.result_json.trim()) {
    try {
      parsedResult = JSON.parse(row.result_json) as TaskTestJob['result'];
    } catch {
      parsedResult = null;
    }
  }

  return {
    id: String(row.id),
    taskId: String(row.task_id),
    status: String(row.status) as TaskTestJobStatus,
    requestedAt: String(row.requested_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    httpStatus: row.http_status != null ? Number(row.http_status) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    result: parsedResult,
  };
}

function getTaskById(taskId: string): Task | null {
  return queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]) ?? null;
}

function getTaskTestJobById(jobId: string): TaskTestJob | null {
  ensureTaskTestJobsTable();
  const row = queryOne<Record<string, unknown>>(
    `SELECT * FROM ${TASK_TEST_JOBS_TABLE} WHERE id = ?`,
    [jobId],
  );
  return row ? toTaskTestJob(row) : null;
}

function getTaskTestJob(taskId: string, jobId: string): TaskTestJob | null {
  ensureTaskTestJobsTable();
  const row = queryOne<Record<string, unknown>>(
    `SELECT * FROM ${TASK_TEST_JOBS_TABLE} WHERE id = ? AND task_id = ?`,
    [jobId, taskId],
  );
  return row ? toTaskTestJob(row) : null;
}

function getLatestTaskTestJob(taskId: string): TaskTestJob | null {
  ensureTaskTestJobsTable();
  const row = queryOne<Record<string, unknown>>(
    `SELECT * FROM ${TASK_TEST_JOBS_TABLE} WHERE task_id = ? ORDER BY requested_at DESC LIMIT 1`,
    [taskId],
  );
  return row ? toTaskTestJob(row) : null;
}

function getActiveTaskTestJob(taskId: string): TaskTestJob | null {
  ensureTaskTestJobsTable();
  const row = queryOne<Record<string, unknown>>(
    `SELECT * FROM ${TASK_TEST_JOBS_TABLE}
     WHERE task_id = ? AND status IN ('queued', 'running')
     ORDER BY requested_at DESC LIMIT 1`,
    [taskId],
  );
  return row ? toTaskTestJob(row) : null;
}

function createTaskTestJob(taskId: string): TaskTestJob {
  ensureTaskTestJobsTable();
  const now = new Date().toISOString();
  const jobId = uuidv4();
  run(
    `INSERT INTO ${TASK_TEST_JOBS_TABLE} (
      id, task_id, status, requested_at, started_at, finished_at, http_status, error_message, result_json
    ) VALUES (?, ?, 'queued', ?, NULL, NULL, NULL, NULL, NULL)`,
    [jobId, taskId, now],
  );
  const job = getTaskTestJobById(jobId);
  if (!job) {
    throw new Error('Failed to create task test job.');
  }
  return job;
}

function markTaskTestJobRunning(jobId: string): void {
  run(`UPDATE ${TASK_TEST_JOBS_TABLE} SET status = 'running', started_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    jobId,
  ]);
}

function markTaskTestJobTerminal(params: {
  jobId: string;
  status: 'completed' | 'failed';
  httpStatus: number;
  result: TaskTestJob['result'];
  errorMessage?: string | null;
}): void {
  run(
    `UPDATE ${TASK_TEST_JOBS_TABLE}
     SET status = ?, finished_at = ?, http_status = ?, error_message = ?, result_json = ?
     WHERE id = ?`,
    [
      params.status,
      new Date().toISOString(),
      params.httpStatus,
      params.errorMessage || null,
      params.result ? JSON.stringify(params.result) : null,
      params.jobId,
    ],
  );
}

async function readResponsePayload(
  response: NextResponse,
): Promise<TestResponse | { error: string } | null> {
  try {
    return (await response.clone().json()) as TestResponse | { error: string };
  } catch {
    try {
      const text = await response.clone().text();
      return text ? { error: text } : null;
    } catch {
      return null;
    }
  }
}

function deriveErrorMessage(
  payload: TestResponse | { error: string } | null,
  fallback: string,
): string {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const message = String(payload.error || '').trim();
    if (message) {
      return message;
    }
  }
  return fallback;
}

function enqueueTaskTestJob(jobId: string): void {
  pendingTaskTestJobIds.push(jobId);
  void drainTaskTestQueue();
}

async function drainTaskTestQueue(): Promise<void> {
  if (drainingTaskTestQueue) {
    return;
  }
  drainingTaskTestQueue = true;

  try {
    while (pendingTaskTestJobIds.length > 0) {
      const jobId = pendingTaskTestJobIds.shift();
      if (!jobId) {
        continue;
      }

      const job = getTaskTestJobById(jobId);
      if (!job || job.status !== 'queued') {
        continue;
      }

      markTaskTestJobRunning(jobId);
      try {
        const response = await runTaskTestsNow(job.taskId);
        const payload = await readResponsePayload(response);
        const status = response.ok ? 'completed' : 'failed';
        const errorMessage = response.ok
          ? null
          : deriveErrorMessage(payload, `Task test job failed with HTTP ${response.status}`);
        markTaskTestJobTerminal({
          jobId,
          status,
          httpStatus: response.status,
          result: payload,
          errorMessage,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Task test execution failed unexpectedly.';
        markTaskTestJobTerminal({
          jobId,
          status: 'failed',
          httpStatus: 500,
          result: { error: message },
          errorMessage: message,
        });
      }
    }
  } finally {
    drainingTaskTestQueue = false;
    if (pendingTaskTestJobIds.length > 0) {
      void drainTaskTestQueue();
    }
  }
}

async function runTaskTestsNow(taskId: string): Promise<NextResponse> {
  try {
    const task = getTaskById(taskId);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const deliverables = queryAll<TaskDeliverable>(
      'SELECT * FROM task_deliverables WHERE task_id = ? AND deliverable_type IN (?, ?)',
      [taskId, 'file', 'url'],
    );

    if (deliverables.length === 0) {
      return NextResponse.json(
        { error: 'No testable deliverables found (file or url types)' },
        { status: 400 },
      );
    }

    ensureScreenshotsDirExists();

    const browser = await chromium.launch({ headless: true });
    const results: TestResult[] = [];

    try {
      for (const deliverable of deliverables) {
        const result = await testDeliverable(browser, deliverable, taskId);
        results.push(result);
      }
    } finally {
      await browser.close();
    }

    const passed = results.every((result) => result.passed);
    const failedCount = results.filter((result) => !result.passed).length;

    let summary: string;
    if (passed) {
      summary = `All ${results.length} deliverable(s) passed automated testing. No console errors, CSS errors, or broken resources detected.`;
    } else {
      const issues: string[] = [];
      for (const result of results.filter((entry) => !entry.passed)) {
        const errorTypes: string[] = [];
        if (result.consoleErrors.length > 0)
          errorTypes.push(`${result.consoleErrors.length} JS errors`);
        if (result.cssErrors.length > 0) errorTypes.push(`${result.cssErrors.length} CSS errors`);
        if (result.resourceErrors.length > 0) {
          errorTypes.push(`${result.resourceErrors.length} broken resources`);
        }
        issues.push(`${result.deliverable.title}: ${errorTypes.join(', ')}`);
      }
      summary = `${failedCount}/${results.length} deliverable(s) failed. Issues: ${issues.join('; ')}`;
    }

    const activityMessage = passed
      ? `Automated test passed - ${results.length} deliverable(s) verified, no issues found`
      : `Automated test failed - ${summary}`;

    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        taskId,
        passed ? 'test_passed' : 'test_failed',
        activityMessage,
        JSON.stringify({
          results: results.map((result) => ({
            deliverable: result.deliverable.title,
            type: result.deliverable.type,
            passed: result.passed,
            consoleErrors: result.consoleErrors.length,
            cssErrors: result.cssErrors.length,
            resourceErrors: result.resourceErrors.length,
            screenshot: result.screenshotPath,
          })),
        }),
        new Date().toISOString(),
      ],
    );

    const now = new Date().toISOString();
    let newStatus: string | undefined;

    if (passed) {
      run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['review', now, taskId]);
      newStatus = 'review';

      run(
        `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          taskId,
          'status_changed',
          'Task moved to REVIEW - automated tests passed, awaiting human approval',
          now,
        ],
      );
    } else {
      run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['assigned', now, taskId]);
      newStatus = 'assigned';

      run(
        `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          taskId,
          'status_changed',
          'Task moved back to ASSIGNED due to failed automated tests - agent needs to fix issues',
          now,
        ],
      );
    }

    const response: TestResponse = {
      taskId,
      taskTitle: task.title,
      passed,
      results,
      summary,
      testedAt: new Date().toISOString(),
      newStatus,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Test execution error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function runTaskTests(taskId: string): Promise<NextResponse> {
  const task = getTaskById(taskId);
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const activeJob = getActiveTaskTestJob(taskId);
  if (activeJob) {
    return NextResponse.json({
      ok: true,
      queued: true,
      deduplicated: true,
      job: activeJob,
    });
  }

  const job = createTaskTestJob(taskId);
  enqueueTaskTestJob(job.id);

  return NextResponse.json(
    {
      ok: true,
      queued: true,
      job,
    },
    { status: 202 },
  );
}

export function getTaskTestJobInfo(taskId: string, jobId: string): NextResponse {
  const task = getTaskById(taskId);
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const job = getTaskTestJob(taskId, jobId);
  if (!job) {
    return NextResponse.json({ error: 'Task test job not found' }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    taskId,
    taskTitle: task.title,
    job,
  });
}

export function getTaskTestInfo(taskId: string): NextResponse {
  const task = getTaskById(taskId);
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const deliverables = queryAll<TaskDeliverable>(
    'SELECT * FROM task_deliverables WHERE task_id = ? AND deliverable_type IN (?, ?)',
    [taskId, 'file', 'url'],
  );

  const fileDeliverables = deliverables.filter(
    (deliverable) => deliverable.deliverable_type === 'file',
  );
  const urlDeliverables = deliverables.filter(
    (deliverable) => deliverable.deliverable_type === 'url',
  );

  const latestJob = getLatestTaskTestJob(taskId);
  const activeJob = getActiveTaskTestJob(taskId);

  return NextResponse.json({
    taskId,
    taskTitle: task.title,
    taskStatus: task.status,
    deliverableCount: deliverables.length,
    testableFiles: fileDeliverables
      .filter(
        (deliverable) => deliverable.path?.endsWith('.html') || deliverable.path?.endsWith('.htm'),
      )
      .map((deliverable) => ({
        id: deliverable.id,
        title: deliverable.title,
        path: deliverable.path,
      })),
    testableUrls: urlDeliverables.map((deliverable) => ({
      id: deliverable.id,
      title: deliverable.title,
      path: deliverable.path,
    })),
    queue: {
      activeJob,
      latestJob,
    },
    validations: [
      'JavaScript console error detection',
      'CSS syntax validation (via css-tree)',
      'Resource loading validation (images, scripts, stylesheets)',
      'HTTP status code validation (for URL deliverables)',
    ],
    workflow: {
      expectedStatus: 'testing',
      onPass: 'Moves to review for human approval',
      onFail: 'Moves to assigned for agent to fix issues',
    },
    usage: {
      post: {
        method: 'POST',
        description: 'Queue automated browser tests for all HTML/URL deliverables',
        returns: 'Accepted job payload with status=queued',
      },
      get: {
        method: 'GET',
        description: 'Read endpoint info and latest/active queue state',
      },
      getJob: {
        method: 'GET',
        query: { jobId: 'task-test-job-id' },
        description: 'Read a specific queued/running/completed test job',
      },
    },
  });
}
